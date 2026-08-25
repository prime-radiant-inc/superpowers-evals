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
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 250;

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

/** Validate sha as a full 40/64-char hex object id. Called before ANY path
 *  construction (materializeSuperpowersWorktree runs this ahead of join) and
 *  re-run by ensureWorktreeAt, which must stand alone as the shared core —
 *  a traversal-shaped ref must never reach join() or the filesystem. */
function assertFullSha(sha: string): void {
  if (!FULL_HEX_SHA_RE.test(sha)) {
    throw new ProvisioningError(
      `refusing to materialize non-SHA ref ${JSON.stringify(sha)} (expected full 40/64 hex)`,
    );
  }
}

function runGit(runner: CommandRunner, args: readonly string[]): CommandResult {
  return runner.run('git', args, { env: materializeEnv() });
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
  for (;;) {
    if (tryAcquireLock(lockPath, ownerFile)) break;
    if (!reclaimStaleLock(lockPath)) Bun.sleepSync(LOCK_POLL_MS);
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
 *  lock — and the caller retries. */
function tryAcquireLock(lockPath: string, ownerFile: string): boolean {
  try {
    mkdirSync(lockPath);
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
  return true;
}

/** Reclaim a lock whose owner died mid-flight. Returns whether the acquire
 *  should be retried immediately (progress was made). */
function reclaimStaleLock(lockPath: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch (err) {
    if (!isTransientLockRace(err)) throw err;
    return true; // vanished: retry the acquire immediately
  }
  if (entries.length === 0) {
    const st = tryLstat(lockPath);
    if (st !== null && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      // A contender or reclaimer crashed before finishing its teardown.
      // rmdir only succeeds while empty, so an owner file landing
      // concurrently makes this a no-op.
      try {
        rmdirSync(lockPath);
      } catch {
        // An owner landed: not ours to remove.
      }
      return true;
    }
    return false; // someone is mid-acquire: poll
  }
  let reclaimed = false;
  for (const name of entries) {
    const ownerPath = join(lockPath, name);
    const st = tryLstat(ownerPath);
    if (st === null) continue;
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      // The unique name IS the ownership token: this unlink can only ever
      // remove the exact stale owner we observed, never a successor's fresh
      // file (and an already-released file yields a harmless no-op).
      try {
        rmSync(ownerPath, { force: true });
      } catch (err) {
        if (!isTransientLockRace(err)) throw err;
      }
      reclaimed = true;
    }
  }
  if (reclaimed) {
    try {
      rmdirSync(lockPath);
    } catch {
      // A fresh owner already moved in: poll instead.
    }
  }
  return reclaimed;
}

export function ensureWorktreeAt(args: {
  readonly sourceCheckout: string;
  readonly sha: string;
  readonly dest: string;
  readonly runner: CommandRunner;
}): void {
  const { sourceCheckout, sha, dest, runner } = args;
  assertFullSha(sha);
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
  // Before join(): the sha must never reach path construction unvalidated
  // (ensureWorktreeAt re-validates because it is also called directly).
  assertFullSha(args.sha);
  const dest = join(args.destParent, `superpowers-${args.sha}`);
  ensureWorktreeAt({ ...args, dest });
  return dest;
}
