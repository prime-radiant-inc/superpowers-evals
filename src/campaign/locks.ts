// Host-wide locking (kernel D3, R-LCK-1/2): the D2 lock-dir protocol idiom
// (atomic mkdir acquire; unforgeable owner-<uuid> token; release/reclaim
// rename-then-delete, never unlink a locked path in place) extended with
// heartbeat tokens and ESRCH/OS-birth-identity dead-holder staleness —
// mtime-only staleness is forbidden for hours-lived locks (REV-2 P-3).
// Ownership is the dispatcher process only; children are marked covered and
// never acquire.
//
// Plan-review C8 hardening plus review round 1 (docs/experiments/
// 2026-08-27-kernel-d3-plan-review.md Critical #8 and the round-1 fix
// brief): every heartbeat write is identity-guarded BEFORE and verified
// AFTER the write, with compensation for a mid-write reclamation (a
// reclaimed old holder can never leave its token in a successor's lock
// directory); reclaim-severing re-verifies the observed directory and token
// so a delayed contender never invalidates a successor's fresh acquisition;
// release is loud and retryable when cleanup fails and unconditional
// otherwise; lock polling reads the injected Clock through clockNowMs (with
// a bounded poll count so a frozen clock still terminates); holder
// inspection is fail-closed (exactly one canonical owner; permission/IO
// errors refuse, never judged blind); the host-wide default refuses any
// non-absolute path.

import { spawnSync } from 'node:child_process';
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
import { basename, dirname, isAbsolute, join } from 'node:path';
import { getEnv } from '../env.ts';
import type { Clock } from '../scheduler/clock.ts';
import { clockNowMs } from './host-stats.ts';

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

export interface ProcessIdentityProbe {
  /** kill(pid, 0): success -> 'alive'; ESRCH -> 'esrch'; anything else
   *  (EPERM, other errors) -> 'unknown'. Only 'esrch' proves no process. */
  exists(pid: number): 'alive' | 'esrch' | 'unknown';
  /** The OS-reported process start time in epoch ms; null when unreadable —
   *  identity unknown, never dead. */
  startTimeMs(pid: number): number | null;
}

export const realProcessIdentityProbe: ProcessIdentityProbe = {
  exists(pid: number): 'alive' | 'esrch' | 'unknown' {
    try {
      process.kill(pid, 0);
      return 'alive';
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH'
        ? 'esrch'
        : 'unknown';
    }
  },
  startTimeMs(pid: number): number | null {
    // `ps -o lstart=` prints a parseable start time on Linux + Darwin.
    const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    if (res.status !== 0) return null;
    const ms = Date.parse(res.stdout.trim());
    return Number.isFinite(ms) ? ms : null;
  },
};

export interface LockToken {
  readonly pid: number;
  readonly birth_ts_ms: number;
  readonly last_heartbeat_ts_ms: number;
}

/** Pinned body (R-LCK-2): pid, birth_ts_ms, last_heartbeat_ts_ms. */
export function formatLockToken(token: LockToken): string {
  return `${token.pid}\n${token.birth_ts_ms}\n${token.last_heartbeat_ts_ms}\n`;
}

export function parseLockToken(body: string): LockToken | null {
  const lines = body.split('\n');
  if (lines.length < 3) return null;
  const pid = Number(lines[0]);
  const birth = Number(lines[1]);
  const hb = Number(lines[2]);
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(birth) ||
    !Number.isInteger(hb)
  ) {
    return null;
  }
  return { pid, birth_ts_ms: birth, last_heartbeat_ts_ms: hb };
}

function tokenEquals(a: LockToken, b: LockToken): boolean {
  return (
    a.pid === b.pid &&
    a.birth_ts_ms === b.birth_ts_ms &&
    a.last_heartbeat_ts_ms === b.last_heartbeat_ts_ms
  );
}

/** Read+parse the token at `path`; null when unreadable or unparseable. */
function readTokenAt(path: string): LockToken | null {
  try {
    return parseLockToken(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export const DEFAULT_HEARTBEAT_MS = 30_000;
export const DEFAULT_STALE_HEARTBEAT_FACTOR = 5;
export const COVERED_BY_LOCK_ENV = 'QUORUM_COVERED_BY_LIVE_SPEND_LOCK';

/** The heartbeat driver seam: acquisition registers exactly one beat at the
 *  pinned cadence; the beat atomically rewrites the holder's own token.
 *  Tests inject a scripted driver (or call heartbeat() manually); production
 *  uses the real timer below. */
export interface HeartbeatScheduler {
  /** Fire cb every `ms` until the returned cancel function is called. */
  every(ms: number, cb: () => void): () => void;
}

/** Production driver (R-LCK-2 heartbeat): an UNREF'D setInterval. unref is
 *  the process-exit semantics — the heartbeat never holds the event loop
 *  open, so a process that exits without release() does not wait on it; the
 *  token simply stops beating, goes stale (default 5 x cadence), and becomes
 *  reclaimable under the stale-heartbeat + dead-holder identity check (the
 *  designed crash path; REV-2 P-3). A beat that throws (our own token lost —
 *  severed underneath us) propagates as an uncaught exception: fail-stop is
 *  correct for a holder that can no longer prove ownership of the lock. */
export const realHeartbeatScheduler: HeartbeatScheduler = {
  every(ms: number, cb: () => void): () => void {
    const timer = setInterval(() => {
      cb();
    }, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};
const CAMPAIGN_ID_FILE = 'campaign-id';
const EMPTY_GRACE_MS = 100;
const POLL_MS = 50;
// Bounded polls per emptiness episode: the grace DECISION reads the injected
// Clock, but a clock that never advances (a frozen test clock) must still
// terminate the loop — past this many physical polls the emptiness is a
// crash, sever, and retry. 3 x 50ms is three orders beyond a live
// contender's mkdir->token-write gap.
const EMPTY_POLL_LIMIT = 3;
const OWNER_NAME_RE = /^owner-[0-9a-f-]{36}$/;
const HEARTBEAT_TMP_RE = /^owner-[0-9a-f-]{36}\.hb-[0-9a-f-]{36}$/;

function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** readdirSync that never throws (empty on error) — best-effort listing of
 *  a directory we already severed to a unique trash name. */
function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** What the lock directory currently holds. Fail-closed holder inspection:
 *  ENOENT is a race (retry); permission/IO errors and ambiguous or corrupt
 *  token states THROW — a holder is never judged blind, and two canonical
 *  owner tokens are ambiguous by definition (a mid-race heartbeat stray or
 *  sabotage), never silently first-wins. */
type OwnerObservation =
  | { readonly kind: 'vanished' }
  | { readonly kind: 'none'; readonly entries: readonly string[] }
  | { readonly kind: 'held'; readonly file: string; readonly token: LockToken };

function observeOwner(lockPath: string): OwnerObservation {
  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'vanished' };
    throw new LockError(
      `cannot inspect lock dir ${lockPath} (${code ?? 'fs error'}) — refusing to judge the holder blind; check permissions on the path and retry`,
    );
  }
  const canonical: string[] = [];
  for (const name of entries) {
    if (OWNER_NAME_RE.test(name)) {
      canonical.push(name);
      continue;
    }
    // Inert protocol neighbors: the campaign-id sidecar, our heartbeat tmp
    // files (crash debris of an in-flight beat), and operator dotfiles.
    if (
      name === CAMPAIGN_ID_FILE ||
      name.startsWith('.') ||
      HEARTBEAT_TMP_RE.test(name)
    ) {
      continue;
    }
    throw new LockError(
      `unexpected entry in lock dir ${lockPath}: ${name} (corruption or sabotage) — inspect the directory and remove it by hand`,
    );
  }
  if (canonical.length > 1) {
    throw new LockError(
      `multiple owner tokens in ${lockPath} (${canonical.join(', ')}) — ambiguous holder state; inspect the directory and remove the stale token by hand`,
    );
  }
  const name = canonical[0];
  if (name === undefined) {
    return { kind: 'none', entries };
  }
  const file = join(lockPath, name);
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'vanished' };
    throw new LockError(
      `owner token ${file} unreadable (${code ?? 'fs error'}) — refusing to judge the holder blind; check permissions and retry`,
    );
  }
  const token = parseLockToken(body);
  if (token === null) {
    throw new LockError(
      `owner token ${file} is unparseable — corrupt or mid-write holder state; retry the acquisition, then inspect the directory by hand`,
    );
  }
  return { kind: 'held', file, token };
}

/** REV-2 P-3 total identity check. Returns 'live' (refuse), 'dead' (reclaim
 *  OK), or throws LockError for identity-unknown. A same-birth live pid is
 *  never reclaimed even against a stale heartbeat; a reused pid (different
 *  birth) means the recorded holder is dead and the replacement is never
 *  signaled. */
function holderDisposition(
  token: LockToken,
  identity: ProcessIdentityProbe,
): 'live' | 'dead' {
  switch (identity.exists(token.pid)) {
    case 'esrch':
      return 'dead';
    case 'unknown':
      throw new LockError(
        `lock holder identity unknown (kill(pid,0) neither succeeded nor returned ESRCH for pid ${token.pid}) — refusing reclamation`,
      );
    case 'alive': {
      const start = identity.startTimeMs(token.pid);
      if (start === null) {
        throw new LockError(
          `lock holder identity unknown (OS start time unreadable for pid ${token.pid}) — refusing reclamation`,
        );
      }
      return start === token.birth_ts_ms ? 'live' : 'dead';
    }
  }
}

/** Sever (rename-then-delete) the lock dir at `lockPath`, TRUSTED only when
 *  the severed directory still matches `expected` — the identity the caller
 *  observed or created. On mismatch the grabbed directory is restored
 *  untouched (if the path was re-taken meanwhile, it is orphaned under the
 *  unguessable trash name; its holder fail-stops on the next heartbeat
 *  guard). Rename failures other than ENOENT surface loudly: only a verified
 *  race-away is a no-op. Returns whether the lock path was freed. */
function severAndRemove(lockPath: string, expected: Stats): boolean {
  const trash = `${lockPath}.trash-${randomUUID()}`;
  try {
    renameSync(lockPath, trash);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false; // raced away: nothing of ours to remove
    throw new LockError(
      `cannot sever lock dir ${lockPath} (rename failed: ${code ?? 'fs error'}) — the lease may still be held; resolve the filesystem failure and retry`,
    );
  }
  const st = tryLstat(trash);
  if (st === null) return false;
  if (st.dev !== expected.dev || st.ino !== expected.ino) {
    // We grabbed a directory we did not observe (a successor's fresh lock
    // landed between the caller's check and this rename, or a symlink was
    // swapped in): put it back untouched — never delete what we cannot
    // identify as ours.
    try {
      renameSync(trash, lockPath);
    } catch {
      // path re-taken: orphan under the unique trash name
    }
    return false;
  }
  // Our directory under our private unguessable name: no path through the
  // original lock path can redirect these deletions. Entry removal is
  // best-effort — the rename already freed the lock path.
  for (const name of readdirSafe(trash)) {
    try {
      rmSync(join(trash, name), { force: true });
    } catch {}
  }
  try {
    rmdirSync(trash);
  } catch {}
  return true;
}

/** Sever ONLY if the path still identifies the directory `mine` (dev+ino) —
 *  acquisition rollback and release both go through here so a successor's
 *  freshly created lock at the same path is never touched. */
function severeIfOurs(lockPath: string, mine: Stats): void {
  const now = tryLstat(lockPath);
  if (
    now === null ||
    !now.isDirectory() ||
    now.dev !== mine.dev ||
    now.ino !== mine.ino
  ) {
    return; // reclaimed, severed, or swapped underneath us: not ours
  }
  severAndRemove(lockPath, mine);
}

/** Reclaim-sever: the occupant must STILL be the directory we observed,
 *  still holding the exact token we judged stale+dead. Any drift means
 *  another contender won the race (Critical 2) — never sever; the caller
 *  re-observes and judges the new state instead. */
function severeIfMatches(
  lockPath: string,
  observed: Stats,
  ownerFile: string,
  token: LockToken,
): boolean {
  const now = tryLstat(lockPath);
  if (
    now === null ||
    !now.isDirectory() ||
    now.dev !== observed.dev ||
    now.ino !== observed.ino
  ) {
    return false;
  }
  const current = readTokenAt(ownerFile);
  if (current === null || !tokenEquals(current, token)) {
    return false;
  }
  return severAndRemove(lockPath, observed);
}

/** Compensation for a mid-race heartbeat (Critical 1): remove OUR
 *  uniquely-named artifacts through the lock path. The owner-<uuid> name is
 *  unguessable and only this handle ever creates it or its .hb- siblings,
 *  so this can only ever remove files this handle momentarily believed were
 *  inside its own directory. Best-effort: a survivor is caught loudly by the
 *  multiple-owner refusal. */
function removeOurArtifacts(lockPath: string, ownerFile: string): void {
  const mine = basename(ownerFile);
  for (const name of readdirSafe(lockPath)) {
    if (name === mine || name.startsWith(`${mine}.hb-`)) {
      try {
        rmSync(join(lockPath, name), { force: true });
      } catch {}
    }
  }
}

/** Release-time inspection: ENOENT is provably gone, an identity mismatch is
 *  a verified replacement — both successful no-ops. Any other lstat error
 *  refuses loudly; the handle stays retryable. */
function releaseInspection(
  lockPath: string,
  mine: Stats,
): 'gone' | 'not-ours' | 'ours' {
  let now: Stats;
  try {
    now = lstatSync(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'gone';
    throw new LockError(
      `cannot inspect lock dir ${lockPath} during release (${code ?? 'fs error'}) — the lease may still be held; resolve the cause and call release() again`,
    );
  }
  if (!now.isDirectory() || now.dev !== mine.dev || now.ino !== mine.ino) {
    return 'not-ours';
  }
  return 'ours';
}

export interface LeaseHandle {
  readonly lockPath: string;
  readonly ownerFile: string;
  /** Atomically rewrite this holder's token with a fresh heartbeat
   *  timestamp (pinned cadence lives at the caller). Identity-guarded
   *  before AND verified after the write (Critical 1): a mid-write
   *  reclamation is compensated, then fails loudly. */
  heartbeat(): void;
  /** Sever the lease. Loud and retryable: a cleanup failure throws with the
   *  held path and the handle remains usable — `released` only becomes
   *  final once the directory is provably gone, replaced, or severed. */
  release(): void;
}

export interface AcquireLeaseArgs {
  readonly lockPath: string;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  readonly heartbeatMs?: number;
  readonly staleFactor?: number;
  /** Error-text surface: 'journal lease' | 'live-spend lock'. */
  readonly label: string;
  /** Heartbeat driver; production default is the unref'd setInterval. */
  readonly scheduler?: HeartbeatScheduler | undefined;
}

export function acquireLease(args: AcquireLeaseArgs): LeaseHandle {
  if (getEnv(COVERED_BY_LOCK_ENV) !== undefined) {
    throw new LockError(
      `${args.label}: campaign children never acquire — ${COVERED_BY_LOCK_ENV} is set; the holder's accounting covers this process`,
    );
  }
  const heartbeatMs = args.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleAfterMs =
    (args.staleFactor ?? DEFAULT_STALE_HEARTBEAT_FACTOR) * heartbeatMs;
  const { lockPath, clock, identity } = args;
  const birth = identity.startTimeMs(process.pid);
  if (birth === null) {
    throw new LockError(
      `${args.label}: cannot read this process's OS start time — refusing to take a lock whose ownership token would be unverifiable`,
    );
  }
  const ownerFile = join(lockPath, `owner-${randomUUID()}`);
  let emptySince: number | null = null;
  let emptyPolls = 0;
  for (;;) {
    let mine: Stats | null = null;
    try {
      mkdirSync(lockPath);
      mine = tryLstat(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (mine?.isDirectory() === true) {
      // We created this directory: everything below is post-acquisition.
      // Any failure unwinds it fully (C8) — no live heartbeat, no held
      // directory — severing only if the path still identifies OUR dir.
      try {
        const token: LockToken = {
          pid: process.pid,
          birth_ts_ms: birth,
          last_heartbeat_ts_ms: clockNowMs(clock),
        };
        writeFileSync(ownerFile, formatLockToken(token), { flag: 'wx' });
        const still = tryLstat(lockPath);
        if (
          still === null ||
          !still.isDirectory() ||
          still.dev !== mine.dev ||
          still.ino !== mine.ino
        ) {
          throw new LockError(
            `${args.label}: lock path vanished mid-acquire: ${lockPath}`,
          );
        }
        return makeHandle(
          lockPath,
          ownerFile,
          still,
          token,
          clock,
          args.label,
          args.scheduler ?? realHeartbeatScheduler,
          heartbeatMs,
        );
      } catch (err) {
        try {
          severeIfOurs(lockPath, mine);
        } catch {
          // The rollback sever itself failed (fs fault): the original
          // error is the louder diagnosis; the orphaned dir is caught by
          // the fail-closed holder inspection.
        }
        throw err;
      }
    }
    // Contended (or the path is not a directory we just created): pin the
    // observed directory identity FIRST — a swapped path is never traversed
    // and never severed by observation of its contents.
    const observed = tryLstat(lockPath);
    if (observed === null) continue; // vanished: retry the mkdir race
    if (!observed.isDirectory()) {
      throw new LockError(
        `${args.label}: lock path ${lockPath} is not a directory (symlink or foreign file) — refusing to touch foreign lock state; inspect the path by hand`,
      );
    }
    const owner = observeOwner(lockPath);
    if (owner.kind === 'vanished') continue;
    if (owner.kind === 'none') {
      if (owner.entries.length === 0) {
        emptySince = emptySince ?? clockNowMs(clock);
        emptyPolls += 1;
        if (
          clockNowMs(clock) - emptySince <= EMPTY_GRACE_MS &&
          emptyPolls < EMPTY_POLL_LIMIT
        ) {
          // Physical backoff only — the grace DECISION above reads the
          // injected Clock (C8: no wall-clock reads in lock polling).
          Bun.sleepSync(POLL_MS); // contender mid-acquire: poll, never touch
          continue;
        }
        severAndRemove(lockPath, observed); // crashed mid-acquire: sever, retry
        emptySince = null;
        emptyPolls = 0;
        continue;
      }
      throw new LockError(
        `${args.label}: no owner token in ${lockPath} and non-inert entries present (${owner.entries.join(', ')}) — refusing to touch foreign lock state; inspect the directory by hand`,
      );
    }
    emptySince = null;
    emptyPolls = 0;
    const nowMs = clockNowMs(clock);
    const heartbeatAge = nowMs - owner.token.last_heartbeat_ts_ms;
    if (heartbeatAge <= staleAfterMs) {
      throw holderRefusal(args.label, owner.token, heartbeatAge, lockPath);
    }
    // Stale heartbeat — the dead-holder identity check gates reclamation.
    if (holderDisposition(owner.token, identity) === 'live') {
      throw holderRefusal(args.label, owner.token, heartbeatAge, lockPath);
    }
    // Dead/reused holder: sever only if the occupant is STILL exactly the
    // one we judged (Critical 2); otherwise re-observe and re-judge.
    severeIfMatches(lockPath, observed, owner.file, owner.token);
  }
}

function holderRefusal(
  label: string,
  token: LockToken,
  heartbeatAgeMs: number,
  lockPath: string,
): LockError {
  const campaignId = readCampaignId(lockPath);
  return new LockError(
    `${label} is held by pid ${token.pid} (heartbeat ${Math.round(heartbeatAgeMs / 1000)}s old${campaignId !== null ? `, campaign ${campaignId}` : ''}) at ${lockPath} — refuse, wait, or inspect the holder`,
  );
}

function readCampaignId(lockPath: string): string | null {
  try {
    return (
      readFileSync(join(lockPath, CAMPAIGN_ID_FILE), 'utf8').trim() || null
    );
  } catch {
    return null;
  }
}

function makeHandle(
  lockPath: string,
  ownerFile: string,
  acquired: Stats,
  initialToken: LockToken,
  clock: Clock,
  label: string,
  scheduler: HeartbeatScheduler,
  heartbeatMs: number,
): LeaseHandle {
  let released = false;
  let current = initialToken;
  let cancelHeartbeat: () => void = () => {};
  const handle: LeaseHandle = {
    lockPath,
    ownerFile,
    heartbeat(): void {
      if (released) throw new LockError(`${label}: heartbeat after release`);
      // Pre-write identity guard (C8). Order matters: the directory is
      // lstat'd BEFORE the token read, so a replacement landing mid-read is
      // caught by the POST-write check — the write is trusted only after
      // re-verification (Critical 1).
      const now = tryLstat(lockPath);
      if (
        now === null ||
        !now.isDirectory() ||
        now.dev !== acquired.dev ||
        now.ino !== acquired.ino
      ) {
        throw new LockError(
          `${label}: lock dir at ${lockPath} is no longer the one this holder acquired — refusing to heartbeat; fail-stop and stop spending on this lock`,
        );
      }
      const observed = readTokenAt(ownerFile);
      if (observed === null || !tokenEquals(observed, current)) {
        throw new LockError(
          `${label}: owner token at ${ownerFile} is no longer ours — refusing to heartbeat into a foreign token`,
        );
      }
      const fresh: LockToken = {
        ...current,
        last_heartbeat_ts_ms: clockNowMs(clock),
      };
      const tmp = `${ownerFile}.hb-${randomUUID()}`;
      try {
        writeFileSync(tmp, formatLockToken(fresh), { flag: 'wx' });
        renameSync(tmp, ownerFile); // atomic rewrite of our OWN token
      } catch (err) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // inert uniquely-named stray
        }
        throw err;
      }
      // POST-write linearization check (Critical 1): if reclamation replaced
      // the directory between the guard and the rename, this write just
      // published our token inside the successor's directory. Detect it,
      // compensate by removing OUR uniquely-named artifacts (no one else
      // can own those names), then fail loudly. A contender observing the
      // transient stray refuses on the multiple-owner check, never
      // mis-judges it.
      const after = tryLstat(lockPath);
      const published = readTokenAt(ownerFile);
      if (
        after === null ||
        !after.isDirectory() ||
        after.dev !== acquired.dev ||
        after.ino !== acquired.ino ||
        published === null ||
        !tokenEquals(published, fresh)
      ) {
        removeOurArtifacts(lockPath, ownerFile);
        throw new LockError(
          `${label}: lock dir at ${lockPath} was replaced during heartbeat — any token of ours that momentarily landed in the successor's directory was removed; fail-stop and stop spending on this lock`,
        );
      }
      current = fresh;
    },
    release(): void {
      if (released) return;
      // `released` flips only after the outcome is decided (Important 3): a
      // cleanup failure throws with the held path and the handle stays
      // retryable — while it is genuinely still held, heartbeats keep
      // proving ownership.
      const inspection = releaseInspection(lockPath, acquired);
      if (inspection === 'ours') {
        severAndRemove(lockPath, acquired); // loud on fs failure; false = raced/replaced
      }
      released = true;
      try {
        cancelHeartbeat(); // C8: a throwing cancel never masks the release outcome
      } catch {
        // the beat wrapper is released-guarded; the cancel failure cannot
        // un-release the lease
      }
    },
  };
  // Timer lifecycle: ONE beat starts at acquisition, at the pinned cadence.
  // This is the production heartbeat — the journal writer (task 3), the
  // live-spend lock held across campaign dispatch (task 9), and every other
  // holder beat through this driver without any caller-side scheduling. A
  // beat firing after release is a no-op (the released flag guards it); a
  // beat that throws (token severed underneath us) fails the process loud —
  // a holder that cannot prove its lock must not keep spending on it.
  cancelHeartbeat = scheduler.every(heartbeatMs, () => {
    if (released) return;
    handle.heartbeat();
  });
  return handle;
}

export function defaultLiveSpendLockPath(): string {
  const explicit = getEnv('QUORUM_LIVE_SPEND_LOCK');
  if (explicit !== undefined && explicit !== '') {
    if (!isAbsolute(explicit)) {
      throw new LockError(
        `QUORUM_LIVE_SPEND_LOCK must be an absolute path (got '${explicit}') — a relative host-wide lock would resolve differently per cwd and let two spenders run at once`,
      );
    }
    return explicit;
  }
  const home = getEnv('HOME');
  if (home === undefined || home === '' || !isAbsolute(home)) {
    throw new LockError(
      'no absolute live-spend lock path available — set QUORUM_LIVE_SPEND_LOCK or HOME; refusing a cwd-relative default that would let spenders from different cwds hold different locks',
    );
  }
  return join(home, '.quorum', 'live-spend.lock.d');
}

export interface LiveSpendLock extends LeaseHandle {
  readonly campaignId: string | null;
}

export function acquireLiveSpendLock(args: {
  readonly lockPath?: string;
  readonly campaignId?: string;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  /** Heartbeat driver; forwarded to the lease (tests inject failures or
   *  scripted beats through it). */
  readonly scheduler?: HeartbeatScheduler | undefined;
}): LiveSpendLock {
  const lockPath = args.lockPath ?? defaultLiveSpendLockPath();
  mkdirSync(dirname(lockPath), { recursive: true });
  const lease = acquireLease({
    lockPath,
    clock: args.clock,
    identity: args.identity,
    label: 'live-spend lock',
    scheduler: args.scheduler,
  });
  if (args.campaignId === undefined) {
    return { ...lease, campaignId: null };
  }
  try {
    writeFileSync(join(lockPath, CAMPAIGN_ID_FILE), `${args.campaignId}\n`);
  } catch (err) {
    try {
      lease.release(); // C8: a post-acquisition failure unwinds the lease
    } catch (releaseErr) {
      throw new LockError(
        `live-spend lock: campaign-id sidecar write failed AND the lease could not be released — the lock may still be held at ${lockPath}: ${(releaseErr as Error).message}`,
      );
    }
    throw err;
  }
  return { ...lease, campaignId: args.campaignId };
}

export function readLiveSpendHolder(
  lockPath: string,
): (LockToken & { campaignId: string | null }) | null {
  const owner = observeOwner(lockPath);
  if (owner.kind !== 'held') return null;
  return { ...owner.token, campaignId: readCampaignId(lockPath) };
}
