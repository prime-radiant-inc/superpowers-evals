// Host-wide locking (kernel D3, R-LCK-1/2): the D2 lock-dir protocol idiom
// (atomic mkdir acquire; unforgeable owner-<uuid> token; release/reclaim
// rename-then-delete, never unlink a locked path in place) extended with
// heartbeat tokens and ESRCH/OS-birth-identity dead-holder staleness —
// mtime-only staleness is forbidden for hours-lived locks (REV-2 P-3).
// Ownership is the dispatcher process only; children are marked covered and
// never acquire.
//
// Plan-review C8 hardening (docs/experiments/2026-08-27-kernel-d3-plan-review.md
// Critical #8, locks-module portion): every heartbeat write is identity-
// guarded — the lock dir must still be the one we acquired (dev+ino) and the
// token inside must still be exactly ours, so a reclaimed old holder can
// never heartbeat into a successor's newly created lock directory; every
// post-acquisition failure rolls the acquisition fully back (no live
// heartbeat, no held directory); release is unconditional (a throwing
// heartbeat-cancel never leaks the lease); lock polling reads the injected
// Clock through clockNowMs, never Date.now().

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
import { dirname, join } from 'node:path';
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

function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** readdirSync that never throws (null on error) — the emptiness probe. */
function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function readOwnerToken(
  lockPath: string,
): { file: string; token: LockToken } | null {
  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!OWNER_NAME_RE.test(name)) continue;
    try {
      const token = parseLockToken(readFileSync(join(lockPath, name), 'utf8'));
      if (token !== null) return { file: join(lockPath, name), token };
    } catch {
      // unreadable owner file: fall through to staleness handling
    }
  }
  return null;
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

function severAndRemove(lockPath: string): void {
  const trash = `${lockPath}.trash-${randomUUID()}`;
  try {
    renameSync(lockPath, trash);
  } catch {
    return; // raced away: nothing of ours to remove
  }
  const st = tryLstat(trash);
  if (st === null) return;
  if (!st.isDirectory()) {
    try {
      rmSync(trash, { force: true }); // a swapped symlink: remove the link itself
    } catch {}
    return;
  }
  for (const name of readdirSync(trash)) {
    try {
      rmSync(join(trash, name), { force: true });
    } catch {}
  }
  try {
    rmdirSync(trash);
  } catch {}
}

/** Sever the lock dir ONLY if it is still the directory `mine` identifies
 *  (dev+ino) — release and acquisition-rollback both go through here so a
 *  successor's freshly created lock at the same path is never touched. */
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
  severAndRemove(lockPath);
}

export interface LeaseHandle {
  readonly lockPath: string;
  readonly ownerFile: string;
  /** Atomically rewrite this holder's token with a fresh heartbeat
   *  timestamp (pinned cadence lives at the caller). Identity-guarded
   *  (C8): refuses loudly when the dir or token is no longer ours. */
  heartbeat(): void;
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
  readonly scheduler?: HeartbeatScheduler;
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
        severeIfOurs(lockPath, mine);
        throw err;
      }
    }
    // Contended (or the path is not a directory we just created): inspect
    // the holder.
    const owner = readOwnerToken(lockPath);
    if (owner === null) {
      const st = tryLstat(lockPath);
      const empty =
        st?.isDirectory() === true && readdirSafe(lockPath).length === 0;
      if (empty) {
        const graceNowMs = clockNowMs(clock);
        emptySince = emptySince ?? graceNowMs;
        if (graceNowMs - emptySince <= EMPTY_GRACE_MS) {
          // Physical backoff only — the grace DECISION above reads the
          // injected Clock (C8: no wall-clock reads in lock polling).
          Bun.sleepSync(POLL_MS); // contender mid-acquire: poll, never touch
          continue;
        }
        severAndRemove(lockPath); // crashed mid-acquire: sever and retry
        emptySince = null;
        continue;
      }
      throw new LockError(
        `${args.label}: no parseable owner token in ${lockPath} and the dir is not mid-acquire — refusing to touch foreign lock state`,
      );
    }
    const nowMs = clockNowMs(clock);
    const heartbeatAge = nowMs - owner.token.last_heartbeat_ts_ms;
    if (heartbeatAge <= staleAfterMs) {
      throw holderRefusal(args.label, owner.token, heartbeatAge, lockPath);
    }
    // Stale heartbeat — the dead-holder identity check gates reclamation.
    if (holderDisposition(owner.token, identity) === 'live') {
      throw holderRefusal(args.label, owner.token, heartbeatAge, lockPath);
    }
    severAndRemove(lockPath); // dead/reused holder: sever, retry acquire
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
      // C8 identity guard: prove the lock dir (dev+ino) AND the token
      // inside are still ours BEFORE writing — a reclaimed old holder must
      // never heartbeat into the successor's newly created lock directory.
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
      let observed: LockToken | null = null;
      try {
        observed = parseLockToken(readFileSync(ownerFile, 'utf8'));
      } catch {
        observed = null; // unreadable token: ownership unprovable
      }
      if (
        observed === null ||
        observed.pid !== current.pid ||
        observed.birth_ts_ms !== current.birth_ts_ms ||
        observed.last_heartbeat_ts_ms !== current.last_heartbeat_ts_ms
      ) {
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
      current = fresh;
    },
    release(): void {
      if (released) return;
      released = true;
      // C8: release is unconditional — a throwing cancel must not leak the
      // held dir. The beat is stopped first; a beat racing the release
      // observes `released` and does nothing.
      try {
        cancelHeartbeat();
      } catch {
        // severance proceeds regardless; the beat wrapper is released-guarded
      }
      // D2 severance discipline: confirm identity (dev+ino), rename to
      // unique trash, delete only beneath the severed name. Anything else
      // at the path (a successor's lock) is left untouched.
      severeIfOurs(lockPath, acquired);
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
  if (explicit !== undefined && explicit !== '') return explicit;
  const home = getEnv('HOME') ?? '';
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
}): LiveSpendLock {
  const lockPath = args.lockPath ?? defaultLiveSpendLockPath();
  mkdirSync(dirname(lockPath), { recursive: true });
  const lease = acquireLease({
    lockPath,
    clock: args.clock,
    identity: args.identity,
    label: 'live-spend lock',
  });
  if (args.campaignId === undefined) {
    return { ...lease, campaignId: null };
  }
  try {
    writeFileSync(join(lockPath, CAMPAIGN_ID_FILE), `${args.campaignId}\n`);
  } catch (err) {
    lease.release(); // C8: a post-acquisition failure unwinds the lease
    throw err;
  }
  return { ...lease, campaignId: args.campaignId };
}

export function readLiveSpendHolder(
  lockPath: string,
): (LockToken & { campaignId: string | null }) | null {
  const owner = readOwnerToken(lockPath);
  if (owner === null) return null;
  return { ...owner.token, campaignId: readCampaignId(lockPath) };
}
