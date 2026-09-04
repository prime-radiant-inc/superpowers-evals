// Host-wide locking (kernel D3, R-LCK-1/2): the D2 lock-dir protocol idiom
// (atomic mkdir acquire; unforgeable owner-<uuid> token; release/reclaim
// rename-then-delete, never unlink a locked path in place) extended with
// heartbeat tokens and ESRCH/OS-birth-identity dead-holder staleness —
// mtime-only staleness is forbidden for hours-lived locks (REV-2 P-3).
// Ownership is the dispatcher process only; children are marked covered and
// never acquire.
//
// Race discipline (the provisioning.ts withDestLock idiom, extended):
// identity is captured BEFORE acting and every destructive act is claimed
// atomically, never check-then-act. The heartbeat proves ownership on every
// beat (dir dev+ino, sole-owner-token observation, token-inode binding) and
// publishes through a descriptor fstat-verified against the inode captured
// at acquisition. Open references retain the directory and owner-token
// identities until release, so unlinked inodes cannot be reused by a
// successor. A replacement landing at any point can never receive the
// holder's bytes, and ambiguous ownership (two owner tokens) fails closed.
// Severance renames the lock dir to a unique trash name FIRST (the rename
// IS the claim; ENOENT = lost the race, back off) and verifies the severed
// directory under that private name; a foreign directory grabbed by a won
// rename is restored, or the failure surfaces loudly — never a silent
// orphan. Lock polling waits through the injected Clock's sleepSync, so
// poll progress is keyed off clock advancement, never off wall-time counts.
// Rollback and release surface cleanup failures loudly (original error plus
// the held path); inspection is fail-closed EVERYWHERE — holder judgment
// (exactly one canonical owner; permission/IO errors refuse, never judged
// blind) and the claim path alike (only ENOENT reads as vanished; an
// unlistable severed directory is never "empty", nothing is deleted through
// it); the host-wide default refuses any non-absolute path.
//
// Residual (the protocol's explicit bound): every holder-side action is
// gated on identity — the acquirer re-proves the lock path's dev+ino
// against the directory it created after writing its owner token (D2
// tryAcquireLock's swap check: a parked fresh owner never acts as holder),
// and every heartbeat re-proves it at the pinned cadence — so a holder
// whose directory is displaced spends for at most one heartbeat cadence
// before it fail-stops. Displacing a LIVE holder is unreachable in-protocol
// (reclamation requires a stale heartbeat AND proven-dead-or-reused
// identity; identity-unknown refuses), leaving the window open only under
// corruption or sabotage. The parent spec's Linux matrix lists two-process
// locking as asserted-not-proven debt; this cadence-bounded window is that
// debt's locks-module expression.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { loadStateConfig } from '../appliance/config.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { Clock } from '../scheduler/clock.ts';
import { clockNowMs } from './host-stats.ts';
import {
  assertHostClaimAuthority,
  type LiveSpendAuthority,
} from './ownership.ts';

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
    // `ps -o lstart=` prints a parseable start time on Linux + Darwin, but
    // WITHOUT a zone designator — Date.parse would then read it in the
    // reader's local zone. Two processes with different TZ settings would
    // compute different births for the same pid and read each other as pid
    // reuse (a cancel would take the post-crash path against a LIVE
    // dispatcher). Pin both ends: ask ps for UTC, and parse it as UTC.
    const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...envSnapshot(), TZ: 'UTC' },
    });
    if (res.status !== 0) return null;
    const ms = Date.parse(`${res.stdout.trim()} UTC`);
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
const OWNER_NAME_RE = /^owner-[0-9a-f-]{36}$/;

/** lstat whose null means only "the beat must fail-stop / the path is not
 *  ours" — callers that use null as a FAIL-CLOSED signal. Judgment sites in
 *  the claim path use lstatOrVanished instead: there, absence and
 *  permission failure must be told apart. */
function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** lstat that returns null ONLY for ENOENT (genuinely vanished — a
 *  transient race the caller backs off from). Every other failure refuses
 *  loudly: an EACCES/EIO must never read as absence (the same fail-closed
 *  bar observeOwner meets). */
function lstatOrVanished(
  path: string,
  label: string,
  what: string,
): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new LockError(
      `${label}: cannot inspect ${what} at ${path} (${code ?? 'fs error'}) — refusing to judge lock state blind; resolve the filesystem failure and retry`,
    );
  }
}

/** readdirSync that never throws (empty on error) — ONLY for the best-effort
 *  deletion sweep of an already-verified severed directory, where the rename
 *  has freed the lock path and leftovers are inert under the unguessable
 *  trash name. Never used to JUDGE state. */
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
    // Inert protocol neighbors: the campaign-id sidecar and operator
    // dotfiles. (The heartbeat writes through a verified descriptor and
    // creates no tmp files, so no other name is ever protocol debris.)
    if (name === CAMPAIGN_ID_FILE || name.startsWith('.')) {
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

/** What the caller proved about the directory it is severing; verified on
 *  the SEVERED directory under the private trash name, never through the
 *  mutable lock path. */
type SeverGuard =
  | { readonly kind: 'ours' } // release/rollback: `expected` is the dir we created
  | { readonly kind: 'empty' } // crashed mid-acquire: judged owner-token-free
  | {
      readonly kind: 'reclaim'; // judged stale + dead: this exact token
      readonly ownerName: string;
      readonly token: LockToken;
    };

/** A won rename grabbed a directory the caller never judged (a fresh lock
 *  landed between observation and the claim): put it back untouched. A
 *  restore that cannot land (the path was re-taken) surfaces LOUDLY — a
 *  displaced live lock is never silently orphaned. */
function restoreOrThrow(
  trash: string,
  lockPath: string,
  label: string,
): 'raced' {
  try {
    renameSync(trash, lockPath);
    return 'raced';
  } catch {
    throw new LockError(
      `${label}: a concurrently-created lock at ${lockPath} was displaced during severance and could not be restored — it is parked at ${trash}; verify no orphaned holder is still running, then remove it by hand`,
    );
  }
}

/** Sever (rename-then-delete) the lock dir at `lockPath`. The ATOMIC RENAME
 *  to the unique trash name IS the claim — there is no check-then-act
 *  window: ENOENT on the rename means another contender claimed the path
 *  first (back off); everything else is verified on the severed directory
 *  under the private name. `expected` is the identity (dev+ino) the caller
 *  observed or created; `guard` is what it proved about the contents.
 *  Rename failures other than ENOENT surface loudly: only a verified
 *  race-away is a no-op. */
function severAndRemove(
  lockPath: string,
  expected: Stats,
  guard: SeverGuard,
  label: string,
): 'severed' | 'lost' | 'raced' {
  const trash = `${lockPath}.trash-${randomUUID()}`;
  try {
    renameSync(lockPath, trash);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'lost'; // someone else claimed it: back off
    throw new LockError(
      `${label}: cannot sever lock dir ${lockPath} (rename failed: ${code ?? 'fs error'}) — the lease may still be held; resolve the filesystem failure and retry`,
    );
  }
  const st = lstatOrVanished(trash, label, 'the severed lock directory');
  if (st === null) return 'lost';
  if (!st.isDirectory() || st.dev !== expected.dev || st.ino !== expected.ino) {
    return restoreOrThrow(trash, lockPath, label);
  }
  if (guard.kind === 'reclaim') {
    // The severed directory is the one we observed; the judged token must
    // still be in it, byte-identical. Nothing legitimate rewrites a dead
    // holder's token, so any drift here is corruption — park the severed
    // state for the operator, never delete what we cannot re-verify. An
    // inspection failure is its own loud refusal (lstatOrVanished), never
    // read as drift.
    const tokenPath = join(trash, guard.ownerName);
    const tokenStat = lstatOrVanished(
      tokenPath,
      label,
      'the judged owner token',
    );
    const current =
      tokenStat?.isFile() === true ? readTokenAt(tokenPath) : null;
    if (
      tokenStat === null ||
      !tokenStat.isFile() ||
      current === null ||
      !tokenEquals(current, guard.token)
    ) {
      throw new LockError(
        `${label}: the judged owner token at ${lockPath} is no longer the regular file that was judged stale (corruption or sabotage) — severed lock state parked at ${trash}; inspect and remove it by hand`,
      );
    }
  }
  if (guard.kind === 'empty') {
    // Judged owner-token-free; if an owner token landed between the
    // observation and the claim, a slow acquisition just completed in this
    // directory — put it back untouched. The verification listing must
    // succeed: a directory we cannot list is never "empty" (fail-closed) —
    // nothing gets deleted, the claim parks loudly for the operator.
    let names: string[];
    try {
      names = readdirSync(trash);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 'lost';
      throw new LockError(
        `${label}: cannot inspect the severed lock directory at ${trash} (${code ?? 'fs error'}) — refusing to treat an unlistable directory as empty; nothing was deleted; resolve the filesystem failure, then inspect and remove ${trash} by hand`,
      );
    }
    const owners = names.filter((n) => OWNER_NAME_RE.test(n));
    if (owners.length > 0) {
      return restoreOrThrow(trash, lockPath, label);
    }
  }
  // Our verified claim, under our private unguessable name: no path through
  // the original lock path can redirect these deletions. Entry removal is
  // best-effort — the rename already freed the lock path.
  for (const name of readdirSafe(trash)) {
    try {
      rmSync(join(trash, name), { force: true });
    } catch {}
  }
  try {
    rmdirSync(trash);
  } catch {}
  return 'severed';
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
  /** Rewrite this holder's own token with a fresh heartbeat timestamp
   *  (pinned cadence lives at the caller). Ownership is re-proven
   *  fail-closed before the write and the write goes through a descriptor
   *  verified against the inode captured at acquisition, so it can never
   *  land anywhere but this holder's own token; when ownership is
   *  unprovable the beat driver is cancelled and the call throws. */
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
  for (;;) {
    let directoryFd: number | null = null;
    let tokenFd: number | null = null;
    let handedOff = false;
    const closeDescriptors = () => {
      if (tokenFd !== null) {
        closeSync(tokenFd);
        tokenFd = null;
      }
      if (directoryFd !== null) {
        closeSync(directoryFd);
        directoryFd = null;
      }
    };
    try {
      let mine: Stats | null = null;
      try {
        mkdirSync(lockPath);
        directoryFd = openSync(
          lockPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
        );
        mine = fstatSync(directoryFd);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      if (mine?.isDirectory() === true && directoryFd !== null) {
        // We created this directory: everything below is post-acquisition.
        // Any failure unwinds it fully — no live heartbeat, no held directory.
        try {
          const token: LockToken = {
            pid: process.pid,
            birth_ts_ms: birth,
            last_heartbeat_ts_ms: clockNowMs(clock),
          };
          tokenFd = openSync(ownerFile, 'wx+');
          writeFileSync(tokenFd, formatLockToken(token));
          // The post-create identity re-proof (D2 tryAcquireLock's swap
          // check): the lock path must STILL be the directory this call
          // created — a contender whose fresh dir was parked out from under
          // it discovers the displacement here and never acts as holder. An
          // inspection failure refuses loudly (never read as vanished).
          const still = lstatOrVanished(lockPath, args.label, 'the lock path');
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
          // The identity every heartbeat write proves itself against: the
          // token file this acquisition created, captured inside the verified
          // window (the provisioning.ts capture-identity-before-acting rule).
          const ownerStats = fstatSync(tokenFd);
          const handle = makeHandle(
            lockPath,
            ownerFile,
            still,
            ownerStats,
            token,
            clock,
            args.label,
            args.scheduler ?? realHeartbeatScheduler,
            heartbeatMs,
            tokenFd,
            closeDescriptors,
          );
          handedOff = true;
          return handle;
        } catch (err) {
          rollbackCreatedDir(lockPath, ownerFile, mine, args.label, err);
          throw err;
        }
      }
      // Contended (or the path is not a directory we just created): pin the
      // observed directory identity FIRST — a swapped path is never traversed
      // and never severed by observation of its contents. An inspection
      // failure refuses loudly; only ENOENT retries the mkdir race.
      const observed = lstatOrVanished(lockPath, args.label, 'the lock path');
      if (observed === null) continue; // vanished: retry the mkdir race
      if (!observed.isDirectory()) {
        throw new LockError(
          `${args.label}: lock path ${lockPath} is not a directory (symlink or foreign file) — refusing to touch foreign lock state; inspect the path by hand`,
        );
      }
      // Keep the judged directory alive until the claim finishes. A saved
      // dev+ino alone can identify a successor after the old inode is freed.
      try {
        directoryFd = openSync(
          lockPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new LockError(
          `${args.label}: cannot inspect lock directory ${lockPath} — refusing reclamation: ${errorMessage(err)}`,
        );
      }
      const pinned = fstatSync(directoryFd);
      if (
        !pinned.isDirectory() ||
        pinned.dev !== observed.dev ||
        pinned.ino !== observed.ino
      )
        continue;
      const owner = observeOwner(lockPath);
      if (owner.kind === 'vanished') continue;
      if (owner.kind === 'none') {
        if (owner.entries.length === 0) {
          emptySince = emptySince ?? clockNowMs(clock);
          if (clockNowMs(clock) - emptySince <= EMPTY_GRACE_MS) {
            // Contender mid-acquire: poll, never touch. The wait rides the
            // injected clock (sleepSync) — the real clock physically sleeps,
            // the fake clock advances itself — so the grace decision above is
            // pure clock arithmetic and wall time is never proof of crash.
            clock.sleepSync(POLL_MS / 1000);
            continue;
          }
          // Grace expired on the clock: the emptiness is a crash. The rename
          // claim + severed-dir verification handles every race (a slow
          // acquisition that landed anyway is restored untouched).
          severAndRemove(lockPath, observed, { kind: 'empty' }, args.label);
          emptySince = null;
          continue;
        }
        throw new LockError(
          `${args.label}: no owner token in ${lockPath} and non-inert entries present (${owner.entries.join(', ')}) — refusing to touch foreign lock state; inspect the directory by hand`,
        );
      }
      emptySince = null;
      const nowMs = clockNowMs(clock);
      const heartbeatAge = nowMs - owner.token.last_heartbeat_ts_ms;
      if (heartbeatAge <= staleAfterMs) {
        throw holderRefusal(args.label, owner.token, heartbeatAge, lockPath);
      }
      // Stale heartbeat — the dead-holder identity check gates reclamation.
      if (holderDisposition(owner.token, identity) === 'live') {
        throw holderRefusal(args.label, owner.token, heartbeatAge, lockPath);
      }
      // Dead/reused holder: the severing rename IS the claim — verification of
      // the judged directory and token happens on the severed state under the
      // private trash name; a lost rename means another contender claimed the
      // path first, and the loop re-observes whatever holds it now.
      severAndRemove(
        lockPath,
        observed,
        {
          kind: 'reclaim',
          ownerName: basename(owner.file),
          token: owner.token,
        },
        args.label,
      );
    } finally {
      if (!handedOff) closeDescriptors();
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Unwind a failed acquisition. Never silent, never success-with-held-lock:
 *  every cleanup failure surfaces as a combined LockError carrying the
 *  original failure, what could not be cleaned, and where. When the path no
 *  longer identifies the directory this call created, its uniquely named
 *  token may have landed in a replacement — removing it by OUR name can
 *  only ever remove a file this call created, and a removal failure is
 *  reported loudly: a lingering second owner token is corruption for the
 *  replacement's holder. */
function rollbackCreatedDir(
  lockPath: string,
  ownerFile: string,
  mine: Stats,
  label: string,
  original: unknown,
): void {
  let now: Stats | null;
  try {
    now = lstatOrVanished(lockPath, label, 'the lock path');
  } catch (inspectErr) {
    throw new LockError(
      `${label}: acquisition failed (${errorMessage(original)}) AND rollback could not inspect the lock path — the lease may still be held at ${lockPath}: ${errorMessage(inspectErr)}`,
    );
  }
  if (
    now?.isDirectory() === true &&
    now.dev === mine.dev &&
    now.ino === mine.ino
  ) {
    try {
      severAndRemove(lockPath, mine, { kind: 'ours' }, label);
    } catch (severErr) {
      throw new LockError(
        `${label}: acquisition failed (${errorMessage(original)}) AND rollback could not free the lock — it may still be held at ${lockPath}: ${errorMessage(severErr)}`,
      );
    }
    return;
  }
  try {
    rmSync(ownerFile, { force: true });
  } catch (strayErr) {
    throw new LockError(
      `${label}: acquisition failed (${errorMessage(original)}) AND this call's stray owner token at ${ownerFile} could not be removed from the replacement lock directory: ${errorMessage(strayErr)} — remove it by hand before the replacement's holder fail-stops on it`,
    );
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
  ownerStats: Stats,
  initialToken: LockToken,
  clock: Clock,
  label: string,
  scheduler: HeartbeatScheduler,
  heartbeatMs: number,
  tokenFd: number,
  closeDescriptors: () => void,
): LeaseHandle {
  let released = false;
  let heartbeatStopped = false;
  let identitiesClosed = false;
  const closeIdentity = () => {
    closeDescriptors();
    identitiesClosed = true;
  };
  let current = initialToken;
  let cancelHeartbeat: () => void = () => {};
  // Ownership became unprovable: stop heartbeating (cancel the driver so the
  // pinned cadence never fires again) and fail loudly — a holder that cannot
  // prove its lock must not keep spending on it. (The explicit binding type
  // is what lets control-flow analysis treat calls as terminating.)
  const failStop: (detail: string) => never = (detail) => {
    heartbeatStopped = true;
    // A displaced directory no longer needs our identity references. If
    // only its token is corrupt, retain them so release remains safe and
    // retryable against this same directory.
    let displaced = false;
    try {
      displaced = releaseInspection(lockPath, acquired) !== 'ours';
    } catch {
      // Inspection errors do not prove displacement. Keep the references
      // so release can retry after access to the directory is restored.
    }
    if (displaced) closeIdentity();
    try {
      cancelHeartbeat();
    } catch {}
    throw new LockError(`${label}: ${detail}`);
  };
  const handle: LeaseHandle = {
    lockPath,
    ownerFile,
    heartbeat(): void {
      if (released || heartbeatStopped)
        throw new LockError(
          `${label}: heartbeat after release or loss of ownership`,
        );
      // Every beat re-proves ownership, fail-closed, before anything is
      // written: (1) the directory at the lock path is still the one this
      // acquisition created (dev+ino); (2) it holds exactly ONE owner token
      // and that token is ours by name — two owner tokens are ambiguous
      // ownership, which is corruption, never continue; (3) the token path
      // still binds the inode this acquisition created; (4) the write goes
      // through a descriptor fstat-verified against that inode. The
      // descriptor is bound to our file, not to the mutable path, so a
      // replacement landing at ANY point can never receive our bytes —
      // there is nothing to compensate, ever.
      const dirNow = tryLstat(lockPath);
      if (
        dirNow === null ||
        !dirNow.isDirectory() ||
        dirNow.dev !== acquired.dev ||
        dirNow.ino !== acquired.ino
      ) {
        failStop(
          `lock dir at ${lockPath} is no longer the one this holder acquired — refusing to heartbeat; fail-stop and stop spending on this lock`,
        );
      }
      let entries: string[];
      try {
        entries = readdirSync(lockPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        failStop(
          `cannot inspect lock dir ${lockPath} during heartbeat (${code ?? 'fs error'}) — ownership unprovable; fail-stop and stop spending on this lock`,
        );
      }
      const owners = entries.filter((n) => OWNER_NAME_RE.test(n));
      if (owners.length > 1) {
        failStop(
          `multiple owner tokens in ${lockPath} (${owners.join(', ')}) — ambiguous ownership is corruption; fail-stop, then inspect the directory and remove the foreign token by hand`,
        );
      }
      if (owners[0] !== basename(ownerFile)) {
        failStop(
          `this holder's owner token is no longer the sole token in ${lockPath} (found: ${owners[0] ?? 'none'}) — refusing to heartbeat; fail-stop and stop spending on this lock`,
        );
      }
      const bound = tryLstat(ownerFile);
      if (
        bound === null ||
        !bound.isFile() ||
        bound.dev !== ownerStats.dev ||
        bound.ino !== ownerStats.ino
      ) {
        failStop(
          `token at ${ownerFile} is not the file this holder created — refusing to heartbeat into a foreign token`,
        );
      }
      // Keep the acquisition descriptor open for the entire lease. This
      // prevents an unlinked token's inode being recycled into a replacement.
      const fd = tokenFd;
      const fdStat = fstatSync(fd);
      if (
        !fdStat.isFile() ||
        fdStat.dev !== ownerStats.dev ||
        fdStat.ino !== ownerStats.ino
      ) {
        failStop(
          `token at ${ownerFile} was swapped mid-heartbeat — not the file this holder created; refusing to heartbeat into a foreign token`,
        );
      }
      const buf = Buffer.alloc(256);
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      const observed = parseLockToken(buf.toString('utf8', 0, bytesRead));
      if (observed === null || !tokenEquals(observed, current)) {
        failStop(
          `owner token at ${ownerFile} is no longer ours — refusing to heartbeat into a foreign token`,
        );
      }
      const fresh: LockToken = {
        ...current,
        last_heartbeat_ts_ms: clockNowMs(clock),
      };
      const data = Buffer.from(formatLockToken(fresh), 'utf8');
      // The rewrite of our OWN token through the verified descriptor. A
      // partial write must never leave a parseable truncated prefix
      // standing as our token: keep writing until every byte has landed;
      // zero forward progress or a write failure fail-stops the driver
      // loudly. (The body never shrinks in practice — pid and birth are
      // fixed, the timestamp's digits never lose places — the truncate
      // covers the theoretical remainder.)
      let written = 0;
      while (written < data.length) {
        let n: number;
        try {
          n = writeSync(fd, data, written, data.length - written, written);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          failStop(
            `cannot rewrite own token at ${ownerFile} (${code ?? 'fs error'} after ${written} of ${data.length} bytes) — token state unverifiable; fail-stop and stop spending on this lock`,
          );
        }
        if (n <= 0) {
          failStop(
            `short write while rewriting own token at ${ownerFile} (${written} of ${data.length} bytes, no forward progress) — token state unverifiable; fail-stop and stop spending on this lock`,
          );
        }
        written += n;
      }
      if (data.length < bytesRead) {
        ftruncateSync(fd, data.length);
      }
      // A replacement that landed after the checks above got nothing (the
      // write went to our inode wherever the directory now lives) — but
      // this holder's lock is gone: detect it on the same beat and stop.
      const after = tryLstat(lockPath);
      if (
        after === null ||
        !after.isDirectory() ||
        after.dev !== acquired.dev ||
        after.ino !== acquired.ino
      ) {
        failStop(
          `lock dir at ${lockPath} was replaced during heartbeat — the fresh heartbeat landed only on this holder's own token; fail-stop and stop spending on this lock`,
        );
      }
      current = fresh;
    },
    release(): void {
      if (released) return;
      if (identitiesClosed) {
        released = true;
        return;
      }
      // `released` flips only after the outcome is decided (Important 3): a
      // cleanup failure throws with the held path and the handle stays
      // retryable — while it is genuinely still held, heartbeats keep
      // proving ownership.
      const inspection = releaseInspection(lockPath, acquired);
      if (inspection === 'ours') {
        // Loud on fs failure; 'lost'/'raced' = provably no longer ours.
        severAndRemove(lockPath, acquired, { kind: 'ours' }, label);
      }
      released = true;
      closeIdentity();
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

export interface LockLocationOptions {
  /** Read-only configuration seam; production always uses the canonical appliance path. */
  readonly canonicalConfigPath?: string;
  readonly env?: Record<string, string | undefined>;
  readonly requestedLockPath?: string;
}
export function defaultLiveSpendLockPath(
  options: LockLocationOptions = {},
): string {
  const env = options.env ?? envSnapshot();
  const canonicalPath =
    options.canonicalConfigPath ?? '/srv/quorum/config/appliance.json';
  const configured = (path: string): string => {
    // The structural loader parses one pinned no-follow read without credentials.
    const value = loadStateConfig(path).config.live_spend_lock;
    if (!value || !isAbsolute(value))
      throw new LockError(
        'appliance configuration requires an absolute live_spend_lock',
      );
    return value;
  };
  const canonical =
    lstatSync(canonicalPath, { throwIfNoEntry: false }) === undefined
      ? undefined
      : configured(canonicalPath);
  const selectedPath = env['EVALS_APPLIANCE_CONFIG'];
  const selected = selectedPath ? configured(selectedPath) : undefined;
  if (canonical && selected && canonical !== selected)
    throw new LockError(
      'explicit appliance config disagrees with canonical live-spend lock',
    );
  const appliance = canonical ?? selected;
  const requested = options.requestedLockPath;
  if (requested && !isAbsolute(requested))
    throw new LockError('requested live-spend lock must be an absolute path');
  if (appliance && requested && requested !== appliance)
    throw new LockError(
      'requested lock disagrees with canonical appliance lock',
    );
  const explicit = env['QUORUM_LIVE_SPEND_LOCK'];
  if (explicit && !isAbsolute(explicit))
    throw new LockError('QUORUM_LIVE_SPEND_LOCK must be an absolute path');
  if (appliance && explicit && appliance !== explicit)
    throw new LockError(
      'QUORUM_LIVE_SPEND_LOCK disagrees with canonical appliance lock',
    );
  if (appliance) return appliance;
  if (requested) return requested;
  if (explicit) return explicit;
  const home = env['HOME'];
  if (!home || !isAbsolute(home))
    throw new LockError(
      'no absolute live-spend lock path available — set QUORUM_LIVE_SPEND_LOCK or HOME',
    );
  return join(home, '.quorum', 'live-spend.lock.d');
}

export interface LiveSpendLock extends LeaseHandle {
  readonly campaignId: string | null;
}

export function acquireLiveSpendLock(args: {
  readonly lockPath?: string;
  readonly campaignId?: string;
  readonly authority?: LiveSpendAuthority;
  readonly location?: LockLocationOptions;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  /** Heartbeat driver; forwarded to the lease (tests inject failures or
   *  scripted beats through it). */
  readonly scheduler?: HeartbeatScheduler | undefined;
}): LiveSpendLock {
  const lockPath = defaultLiveSpendLockPath({
    ...args.location,
    ...(args.lockPath ? { requestedLockPath: args.lockPath } : {}),
  });
  mkdirSync(dirname(lockPath), { recursive: true });
  const lease = acquireLease({
    lockPath,
    clock: args.clock,
    identity: args.identity,
    label: 'live-spend lock',
    scheduler: args.scheduler,
  });
  try {
    assertHostClaimAuthority(lockPath, args.authority);
  } catch (error) {
    lease.release();
    throw error;
  }
  // NOTE (R-LCK-2 layering): the resource-floor preflight is deliberately
  // NOT here. The spec's recovery ordering (REV sol #8c) pins
  // acquire lock → kill/reconcile → preflight → admit: preflight failure
  // refuses admission but must never block the lock or orphan cleanup, so
  // the spender verbs run preflightResourceFloors as a separate step after
  // this returns (see src/campaign/host-stats.ts).
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
