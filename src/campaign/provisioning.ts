// The superpowers worktree materializer (kernel D2). A library: it knows
// nothing about runs or campaigns; the caller (D3) supplies the destination.
// Every subprocess call goes through the CommandRunner seam with an explicit
// minimal env — the seam's documented invariant forbids inheriting the parent
// env. Confinement idiom mirrors src/campaign/acquire.ts (lstat, never stat;
// validate components before path construction).
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { CommandResult, CommandRunner } from '../agents/command-runner.ts';
import { getEnv } from '../env.ts';

export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

export interface MaterializeSuperpowersArgs {
  /** Local superpowers checkout to source the worktree from. */
  readonly sourceCheckout: string;
  /** Resolved full SHA (refs never reach here — Decision D-2); validated as
   *  full hex (40/64) before any path construction. */
  readonly sha: string;
  /** Parent dir; D3 passes the campaign dir, tests/smoke pass a tmpdir. */
  readonly destParent: string;
  readonly runner: CommandRunner;
}

const FULL_HEX_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// An owner token: owner-<uuid> name AND a parseable pid body (what
// tryAcquireLock writes). Anything else inside a lock dir is junk —
// corruption or sabotage — and is treated as such, never as a live owner.
const OWNER_NAME_RE =
  /^owner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 250;
// How long an EMPTY lock dir with a fresh mtime is treated as a contender
// mid-acquire (mkdir and owner-file create are two steps, µs apart). Past
// this grace the emptiness is a crash, and the dir is severed — the poll
// loop must always be able to make progress or fail loudly, never hang.
const LOCK_EMPTY_GRACE_MS = 100;

/** The minimal env every materializer subprocess gets — PATH/HOME/TMPDIR only.
 *  Read through src/env.ts (§6.5): the gate forbids direct process.env reads
 *  outside that boundary. */
function materializeEnv(): Record<string, string | undefined> {
  return {
    PATH: getEnv('PATH'),
    HOME: getEnv('HOME'),
    TMPDIR: getEnv('TMPDIR'),
  };
}

/** lstat — does NOT follow symlinks — so a symlink never passes the reuse
 *  checks. Returns null when missing. (Idiom: acquire.ts's tryLstat.) */
function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

declare const validatedShaBrand: unique symbol;

/** A SHA that passed FULL_HEX_SHA_RE. A branded nominal type: the dest-path
 *  constructor below accepts ONLY it, so raw caller input physically cannot
 *  reach path construction — validating after `join` stops being merely a
 *  test away from happening and becomes a compile error. (The ordering of
 *  validation vs a pure join() is not runtime-observable in a hermetic
 *  test: join is pure and both orderings produce identical filesystem and
 *  subprocess effects. The type system is the enforceable guard.) */
type ValidatedSha = string & { readonly [validatedShaBrand]: true };

/** The single validation site (Decision D-2: refs never reach here — full
 *  40/64 hex only). Each public entry validates its raw input exactly once,
 *  at the boundary, before anything else runs. */
function validateSha(sha: string): ValidatedSha {
  if (!FULL_HEX_SHA_RE.test(sha)) {
    throw new ProvisioningError(
      `refusing to materialize non-SHA ref ${JSON.stringify(sha)} (expected full 40/64 hex)`,
    );
  }
  return sha as ValidatedSha;
}

/** The ONLY `superpowers-<sha>` path construction. Branded parameter: an
 *  unvalidated ref cannot be joined into a destination. */
function superpowersDest(destParent: string, sha: ValidatedSha): string {
  return join(destParent, `superpowers-${sha}`);
}

function runGit(runner: CommandRunner, args: readonly string[]): CommandResult {
  return runner.run('git', args, { env: materializeEnv() });
}

/** Read an owner file's pid body; null when it is not an owner token. */
function ownerPid(path: string, stats: Stats): number | null {
  if (!stats.isFile() || !OWNER_NAME_RE.test(basename(path))) return null;
  try {
    const m = /^([0-9]+)\n?$/.exec(readFileSync(path, 'utf8'));
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}

/** readdirSync that never throws for the emptiness probe (null on error). */
function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function gitOut(runner: CommandRunner, args: readonly string[]): string {
  const res = runGit(runner, args);
  if (res.status !== 0) {
    throw new ProvisioningError(
      `git ${args.join(' ')} failed (${res.status}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout.trim();
}

/** Single-flight per destination, via an ownership-safe lock:
 *  - the lock is a DIRECTORY (atomic mkdir acquire — EEXIST means contended);
 *  - ownership is pinned by a uniquely-named `owner-<uuid>` file inside it,
 *    so the owner's identity is the file NAME — an unforgeable token;
 *  - release unlinks exactly our own owner file, then rmdirs the dir only if
 *    empty: an old owner can therefore never delete a successor's lock;
 *  - reclaim removes owner files older than LOCK_STALE_MS by their OBSERVED
 *    unique names: two contenders observing the same stale lock can never
 *    remove a file a third party has freshly created, because every fresh
 *    owner has a different name.
 *  An empty-but-present lock dir younger than LOCK_STALE_MS is a contender
 *  mid-acquire (mkdir and owner-file create are two steps) or a releaser
 *  between its two teardown steps: poll, never touch. */
function withDestLock<T>(lockPath: string, fn: () => T): T {
  const ownerFile = join(lockPath, `owner-${randomUUID()}`);
  let emptySince: number | null = null;
  for (;;) {
    if (tryAcquireLock(lockPath, ownerFile)) break;
    const progressed = reclaimStaleLock(lockPath, emptySince);
    if (!progressed) {
      // Distinguish "waiting on a live owner" (fine, keep polling) from
      // "stuck on an empty mid-acquire dir" (a crash after LOCK_EMPTY_GRACE_MS
      // — sever it so the loop always progresses).
      const st = tryLstat(lockPath);
      const empty =
        st?.isDirectory() === true && readdirSafe(lockPath).length === 0;
      emptySince = empty ? (emptySince ?? Date.now()) : null;
      Bun.sleepSync(LOCK_POLL_MS);
    } else {
      emptySince = null;
    }
  }
  try {
    return fn();
  } finally {
    // Ownership-safe release: unlink exactly our uniquely-named owner file
    // (a successor's file carries a different name and cannot be touched),
    // then rmdir — which only succeeds when the dir is empty, i.e. when no
    // other owner exists. Fully best-effort: this runs in finally and must
    // never mask the guarded section's result or its exceptions.
    try {
      rmSync(ownerFile, { force: true });
    } catch {
      // raced a reclaimer's teardown, or a permanent FS fault — either way
      // the stale-reclaim path will clean up after LOCK_STALE_MS.
    }
    try {
      rmdirSync(lockPath);
    } catch {
      // Non-empty (another owner holds it) or already reclaimed: not ours.
    }
  }
}

/** Transient outcome of an FS step that raced a concurrent teardown of the
 *  lock dir: ENOENT (path gone) or, on some platforms (macOS APFS), EINVAL
 *  from an O_CREAT|O_EXCL open whose parent vanished mid-call. Either way
 *  the caller simply retries — nothing was acquired or removed. */
function isTransientLockRace(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'EINVAL';
}

/** Atomic acquire: mkdir succeeds for exactly one contender. Ownership is
 *  then pinned by the uniquely-named owner file; a teardown racing between
 *  the two steps surfaces as a transient ENOENT/EINVAL — we never held the
 *  lock — and the caller retries.
 *  Swap check: after writing the owner file, the lock path must STILL be
 *  the directory we created (same dev+ino). If a symlink was planted over
 *  it in between, the write landed in the swap target — remove our own
 *  uniquely-named stray (best-effort net-zero) and retry. */
function tryAcquireLock(lockPath: string, ownerFile: string): boolean {
  let mine: Stats | null;
  try {
    mkdirSync(lockPath);
    mine = tryLstat(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
  try {
    writeFileSync(ownerFile, `${process.pid}\n`, { flag: 'wx' });
  } catch (err) {
    if (isTransientLockRace(err)) return false; // torn down mid-acquire
    throw err;
  }
  const now = tryLstat(lockPath);
  if (
    mine === null ||
    !mine.isDirectory() ||
    now === null ||
    !now.isDirectory() ||
    now.dev !== mine.dev ||
    now.ino !== mine.ino
  ) {
    try {
      rmSync(ownerFile, { force: true });
    } catch {
      // best effort: a stray uniquely-named file is inert
    }
    return false;
  }
  return true;
}

/** Reclaim a lock whose owner died mid-flight. Returns whether the acquire
 *  loop should retry immediately (progress was made).
 *  Confinement rules, in order:
 *  1. lstat the lock path FIRST and refuse any symlink/non-directory — a
 *     pre-existing symlink is never traversed.
 *  2. Decide from READ-ONLY lstats whether anything is reclaimable; a lock
 *     holding any fresh owner is live: poll, never touch it.
 *  3. Before deleting ANYTHING, sever the swap window: rename the lock path
 *     to a unique trash name. POSIX rename never follows a symlink — if the
 *     path was swapped for one since our lstat, we rename the LINK, detect
 *     that (trash is not a directory), and unlink the link itself; the
 *     symlink's target is unreachable. Every deletion then happens under
 *     the unguessable trash path, which cannot be redirected through the
 *     original lock path.
 *  4. Unexpected entry types (a directory child) fail LOUDLY — never a
 *     silent skip, never an unbounded poll.
 *  5. If a fresh owner appears under trash (it landed between the read-only
 *     pass and the rename), restore the lock and poll: a live lock is never
 *     deleted, at most orphaned if the original path was re-taken. */
function reclaimStaleLock(
  lockPath: string,
  emptySince: number | null,
): boolean {
  const lockStat = tryLstat(lockPath);
  if (lockStat === null) return true; // vanished: retry the acquire
  if (!lockStat.isDirectory()) {
    throw new ProvisioningError(
      `refusing to reclaim non-directory or symlinked lock path: ${lockPath}`,
    );
  }
  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch (err) {
    if (!isTransientLockRace(err)) throw err;
    return true; // vanished: retry the acquire immediately
  }
  // Read-only pass: decide without deleting anything. A LIVE owner (fresh
  // valid owner token) means wait; stale anything is reclaimable; a FRESH
  // non-owner entry is corruption/sabotage and fails loudly — polling on it
  // forever would be an unbounded hang.
  let anyStale = false;
  for (const name of entries) {
    const st = tryLstat(join(lockPath, name));
    if (st === null) continue;
    if (!st.isFile() && !st.isSymbolicLink()) {
      throw new ProvisioningError(
        `unexpected non-file entry in lock dir (sabotage or corruption): ${join(lockPath, name)}`,
      );
    }
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      anyStale = true;
      continue;
    }
    if (ownerPid(join(lockPath, name), st) === null) {
      throw new ProvisioningError(
        `unexpected fresh non-owner entry in lock dir (sabotage or corruption): ${join(lockPath, name)}`,
      );
    }
    // A live owner coexisting with stale entries: partial reclaim below —
    // sever, delete only the stale ones, then restore the lock for it.
  }
  if (entries.length === 0) {
    // Empty: a contender mid-acquire (mkdir and owner-file create are two
    // steps, µs apart) — poll, but never indefinitely: past
    // LOCK_EMPTY_GRACE_MS of observed emptiness (or a stale-aged dir) the
    // emptiness is a crash and the dir is severed below.
    const graceExpired =
      emptySince !== null && Date.now() - emptySince > LOCK_EMPTY_GRACE_MS;
    if (Date.now() - lockStat.mtimeMs <= LOCK_STALE_MS && !graceExpired) {
      return false;
    }
    anyStale = true;
  }
  if (!anyStale) return false; // live lock: poll untouched

  // Sever the swap window: from here on, operate only under our private
  // name, never through the original lock path.
  const trash = `${lockPath}.trash-${randomUUID()}`;
  try {
    renameSync(lockPath, trash);
  } catch (err) {
    if (!isTransientLockRace(err)) throw err;
    return true; // raced away under us: retry the acquire
  }
  const trashStat = tryLstat(trash);
  if (trashStat === null) return true;
  if (!trashStat.isDirectory()) {
    // The lock path was swapped for a symlink before our rename: we hold
    // the LINK. Remove the link itself — its target is unreachable — and
    // retry the acquire on the now-free path.
    try {
      rmSync(trash, { force: true });
    } catch {
      // best effort: a leftover uniquely-named link redirects nothing
    }
    return true;
  }
  let sawFresh = false;
  try {
    entries = readdirSync(trash);
  } catch (err) {
    if (!isTransientLockRace(err)) throw err;
    return true;
  }
  for (const name of entries) {
    const ownerPath = join(trash, name);
    const st = tryLstat(ownerPath);
    if (st === null) continue;
    if (!st.isFile() && !st.isSymbolicLink()) {
      throw new ProvisioningError(
        `unexpected non-file entry in lock dir (sabotage or corruption): ${ownerPath}`,
      );
    }
    if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) {
      if (ownerPid(ownerPath, st) === null) {
        throw new ProvisioningError(
          `unexpected fresh non-owner entry in lock dir (sabotage or corruption): ${ownerPath}`,
        );
      }
      sawFresh = true;
      continue;
    }
    // The unique name IS the ownership token: this unlink can only ever
    // remove the exact stale owner we observed under OUR private trash
    // path, never a successor's fresh file.
    try {
      rmSync(ownerPath, { force: true });
    } catch (err) {
      if (!isTransientLockRace(err)) throw err;
    }
  }
  if (sawFresh) {
    // A live owner landed between the read-only pass and the rename: put
    // the lock back. If the original path was re-acquired meanwhile, leave
    // the orphan — fresh owners are never deleted.
    try {
      renameSync(trash, lockPath);
    } catch {
      // re-acquired: orphan rather than delete a live lock
    }
    return false;
  }
  try {
    rmdirSync(trash);
  } catch {
    // raced (an owner landed): handled on a later pass
  }
  return true;
}

export function ensureWorktreeAt(args: {
  readonly sourceCheckout: string;
  readonly sha: string;
  readonly dest: string;
  readonly runner: CommandRunner;
}): void {
  ensureValidatedWorktree({ ...args, sha: validateSha(args.sha) });
}

/** The shared core (Task 2's instrument-snapshot consumes it): only ever
 *  reached with an already-validated SHA — the branded parameter makes an
 *  unvalidated call a compile error. */
function ensureValidatedWorktree(args: {
  readonly sourceCheckout: string;
  readonly sha: ValidatedSha;
  readonly dest: string;
  readonly runner: CommandRunner;
}): void {
  const { sourceCheckout, sha, dest, runner } = args;
  withDestLock(`${dest}.lock`, () => {
    const st = tryLstat(dest);
    if (st !== null) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new ProvisioningError(
          `refusing to reuse non-directory or symlinked destination: ${dest}`,
        );
      }
      const head = gitOut(runner, ['-C', dest, 'rev-parse', 'HEAD']);
      const porcelain = gitOut(runner, ['-C', dest, 'status', '--porcelain']);
      if (head === sha && porcelain === '') {
        return; // exact + clean: reuse (idempotent per SHA within destParent)
      }
      throw new ProvisioningError(
        `refusing to reuse drifted worktree at ${dest}: HEAD=${head} (want ${sha}), porcelain=${JSON.stringify(porcelain)}`,
      );
    }
    const addRes = runGit(runner, [
      '-C',
      sourceCheckout,
      'worktree',
      'add',
      '--detach',
      dest,
      sha,
    ]);
    if (addRes.status !== 0) {
      // Failure cleanup: remove the half-created worktree and prune the
      // registration — never rm -rf (registrations live in the source
      // checkout's .git/worktrees). Both cleanup results are inspected and
      // reported: a cleanup that itself failed leaves a registered or
      // partial tree, and the error must say so rather than assume success.
      const removeRes = runGit(runner, [
        '-C',
        sourceCheckout,
        'worktree',
        'remove',
        '--force',
        dest,
      ]);
      const pruneRes = runGit(runner, [
        '-C',
        sourceCheckout,
        'worktree',
        'prune',
      ]);
      const removeNote =
        removeRes.status === 0
          ? 'worktree remove --force ok'
          : `worktree remove --force failed (${removeRes.status}): ${removeRes.stderr.trim()}`;
      const pruneNote =
        pruneRes.status === 0
          ? 'worktree prune ok'
          : `worktree prune failed (${pruneRes.status}): ${pruneRes.stderr.trim()}`;
      throw new ProvisioningError(
        `git worktree add ${dest} @ ${sha} failed (${addRes.status}): ${addRes.stderr.trim()}; cleanup: ${removeNote}; ${pruneNote}`,
      );
    }
  });
}

/** Materialize `<destParent>/superpowers-<sha>`; idempotent per SHA. */
export function materializeSuperpowersWorktree(
  args: MaterializeSuperpowersArgs,
): string {
  // Validate FIRST — the only join() this module performs on caller input
  // (superpowersDest) accepts the branded type, so a reorder is a compile
  // error rather than a latent regression.
  const sha = validateSha(args.sha);
  const dest = superpowersDest(args.destParent, sha);
  ensureValidatedWorktree({ ...args, sha, dest });
  return dest;
}
