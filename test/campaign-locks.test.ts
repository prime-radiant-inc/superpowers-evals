import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLease,
  acquireLiveSpendLock,
  COVERED_BY_LOCK_ENV,
  DEFAULT_HEARTBEAT_MS,
  defaultLiveSpendLockPath,
  formatLockToken,
  type HeartbeatScheduler,
  LockError,
  type ProcessIdentityProbe,
  parseLockToken,
  readLiveSpendHolder,
  realHeartbeatScheduler,
} from '../src/campaign/locks.ts';
import { deleteProcessEnv, setProcessEnv } from '../src/env.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

class FakeIdentity implements ProcessIdentityProbe {
  private readonly states = new Map<
    number,
    { exists: 'alive' | 'esrch' | 'unknown'; startMs: number | null }
  >();
  set(
    pid: number,
    exists: 'alive' | 'esrch' | 'unknown',
    startMs: number | null,
  ): void {
    this.states.set(pid, { exists, startMs });
  }
  exists(pid: number): 'alive' | 'esrch' | 'unknown' {
    return this.states.get(pid)?.exists ?? 'esrch';
  }
  startTimeMs(pid: number): number | null {
    return this.states.get(pid)?.startMs ?? null;
  }
}

function tmpLockPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'lock-')), 'test.lock.d');
}

const BIRTH = 1_000;
// A FOREIGN holder pid: reclamation scenarios must not share the contender's
// own pid (acquireLease reads its OWN OS birth first, so self-keyed fakes
// would trip the own-birth guard instead of the holder disposition).
const HOLDER_PID = 424_242;

function acquireFirst(
  lockPath: string,
  clock: FakeClock,
  identity: FakeIdentity,
) {
  identity.set(process.pid, 'alive', BIRTH);
  return acquireLease({ lockPath, clock, identity, label: 'test lease' });
}

/** Plant a foreign holder's token directly (no in-process lease handle). */
function plantStaleHolder(lockPath: string, lastHeartbeatMs: number): void {
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(
    join(lockPath, 'owner-00000000-0000-4000-8000-000000000000'),
    formatLockToken({
      pid: HOLDER_PID,
      birth_ts_ms: BIRTH,
      last_heartbeat_ts_ms: lastHeartbeatMs,
    }),
  );
}

test('token body format is pinned: pid, birth_ts_ms, last_heartbeat_ts_ms', () => {
  const body = formatLockToken({
    pid: 123,
    birth_ts_ms: 456,
    last_heartbeat_ts_ms: 789,
  });
  expect(body).toBe('123\n456\n789\n');
  expect(parseLockToken(body)).toEqual({
    pid: 123,
    birth_ts_ms: 456,
    last_heartbeat_ts_ms: 789,
  });
  expect(parseLockToken('garbage')).toBeNull();
  expect(parseLockToken('123\n')).toBeNull();
});

test('acquire creates the lock dir and the owner token', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  const lease = acquireFirst(lockPath, clock, identity);
  expect(existsSync(lockPath)).toBe(true);
  const entries = readdirSync(lockPath).filter((e) => e.startsWith('owner-'));
  expect(entries).toHaveLength(1);
  expect(
    parseLockToken(readFileSync(join(lockPath, entries[0]!), 'utf8')),
  ).toEqual({
    pid: process.pid,
    birth_ts_ms: BIRTH,
    last_heartbeat_ts_ms: 10_000,
  });
  lease.release();
  expect(existsSync(lockPath)).toBe(false);
});

test('a live holder refuses a contender, named in the error', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  const lease = acquireFirst(lockPath, clock, identity);
  // A different process holds the lock per the token: simulate by claiming
  // the holder pid is live with a matching birth.
  const holderBody = readFileSync(
    join(lockPath, readdirSync(lockPath).find((e) => e.startsWith('owner-'))!),
    'utf8',
  );
  const holder = parseLockToken(holderBody)!;
  identity.set(holder.pid, 'alive', holder.birth_ts_ms);
  expect(() =>
    acquireLease({ lockPath, clock, identity, label: 'test lease' }),
  ).toThrow(LockError);
  lease.release();
});

test('stale heartbeat + ESRCH: reclaimed; stale heartbeat + live same-birth pid: NEVER reclaimed', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH); // the contender's own birth read
  plantStaleHolder(lockPath, 10_000); // foreign holder, heartbeat at t=10s
  // Stale heartbeat (default 5x 30s = 150s past last heartbeat).
  clock.advance(200);
  identity.set(HOLDER_PID, 'alive', BIRTH); // same birth, still alive
  expect(() =>
    acquireLease({ lockPath, clock, identity, label: 'test lease' }),
  ).toThrow(LockError); // a merely-old token with a live pid is never reclaimed
  // Now the holder dies (ESRCH) -> stale reclamation proceeds WITHOUT any
  // release: the contender severs the dead holder's lock dir and acquires.
  identity.set(HOLDER_PID, 'esrch', null);
  const second = acquireLease({
    lockPath,
    clock,
    identity,
    label: 'test lease',
  });
  expect(existsSync(second.ownerFile)).toBe(true);
  second.release();
});

test('stale heartbeat + reused pid (different birth): reclaimed, replacement never signaled', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  plantStaleHolder(lockPath, 10_000);
  clock.advance(200);
  identity.set(HOLDER_PID, 'alive', BIRTH + 999_999); // PID reuse
  const second = acquireLease({
    lockPath,
    clock,
    identity,
    label: 'test lease',
  });
  expect(existsSync(second.ownerFile)).toBe(true);
  second.release();
});

test('identity unknown (unreadable start time / kill error) refuses reclamation loudly', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  plantStaleHolder(lockPath, 10_000);
  clock.advance(200);
  identity.set(HOLDER_PID, 'alive', null); // unreadable start time
  expect(() =>
    acquireLease({ lockPath, clock, identity, label: 'test lease' }),
  ).toThrow(/identity unknown/i);
  identity.set(HOLDER_PID, 'unknown', null); // EPERM-class kill result
  expect(() =>
    acquireLease({ lockPath, clock, identity, label: 'test lease' }),
  ).toThrow(/identity unknown/i);
});

test('heartbeat rewrites the token atomically with a fresh last_heartbeat_ts_ms', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  const lease = acquireFirst(lockPath, clock, identity);
  clock.advance(30);
  lease.heartbeat();
  const body = readFileSync(lease.ownerFile, 'utf8');
  expect(parseLockToken(body)!.last_heartbeat_ts_ms).toBe(40_000);
  lease.release();
});

test('acquisition schedules the heartbeat: an injected scheduler beat rewrites the token; release stops the beats (timer lifecycle)', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  const beats: (() => void)[] = [];
  const cancelled: boolean[] = [];
  const scheduler: HeartbeatScheduler = {
    every(ms, cb) {
      expect(ms).toBe(DEFAULT_HEARTBEAT_MS); // pinned cadence rides the driver
      beats.push(cb);
      return () => {
        cancelled.push(true);
      };
    },
  };
  const lease = acquireLease({
    lockPath,
    clock,
    identity,
    label: 'test lease',
    scheduler,
  });
  expect(beats).toHaveLength(1); // exactly one driver registered at acquisition
  // A beat at the pinned cadence rewrites the token with a fresh heartbeat —
  // this is what keeps a running campaign's lock from going stale (REV-2 P-3:
  // the P-3 fix exists so a live holder never becomes reclaimable).
  clock.advance(30);
  beats[0]!();
  expect(
    parseLockToken(readFileSync(lease.ownerFile, 'utf8'))!.last_heartbeat_ts_ms,
  ).toBe(40_000);
  // release() cancels the driver; a beat firing after release is a no-op.
  lease.release();
  expect(cancelled).toEqual([true]);
  beats[0]!();
  expect(existsSync(lockPath)).toBe(false);
});
// Real timers by design: this test verifies the production driver's own
// setInterval semantics (fires, cancels, unref'd) — fake time cannot.
test("the production heartbeat driver is an unref'd setInterval: fires, cancels, never holds the loop open", async () => {
  let fired = 0;
  const cancel = realHeartbeatScheduler.every(5, () => {
    fired += 1;
  });
  await Bun.sleep(30);
  expect(fired).toBeGreaterThan(0);
  cancel();
  const at = fired;
  await Bun.sleep(20);
  expect(fired).toBe(at); // cancelled: no further beats
  // Process-exit semantics: the timer is unref'd, so a process that exits
  // without release() does NOT wait on the heartbeat — its token simply
  // stops beating, goes stale (5 x cadence), and becomes reclaimable under
  // the stale-heartbeat + dead-holder identity check (the designed crash
  // path; a same-birth live holder is never reclaimed).
});

test('children never acquire: the covered-by-lock env marker refuses acquisition', () => {
  setProcessEnv(COVERED_BY_LOCK_ENV, '1');
  try {
    expect(() =>
      acquireLiveSpendLock({
        lockPath: tmpLockPath(),
        clock: new FakeClock(0),
        identity: new FakeIdentity(),
      }),
    ).toThrow(/never acquire/i);
  } finally {
    deleteProcessEnv(COVERED_BY_LOCK_ENV);
  }
});

test('live-spend lock: default path, campaign-id sidecar, holder inspection', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(5);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH); // the acquirer's own birth read
  const lock = acquireLiveSpendLock({
    lockPath,
    campaignId: 'abc123',
    clock,
    identity,
  });
  const holder = readLiveSpendHolder(lockPath);
  expect(holder).not.toBeNull();
  expect(holder!.pid).toBe(process.pid);
  expect(holder!.campaignId).toBe('abc123');
  lock.release();
  expect(readLiveSpendHolder(lockPath)).toBeNull();
  // Default path honors the env, else user-wide.
  setProcessEnv('QUORUM_LIVE_SPEND_LOCK', '/tmp/custom.lock.d');
  try {
    expect(defaultLiveSpendLockPath()).toBe('/tmp/custom.lock.d');
  } finally {
    deleteProcessEnv('QUORUM_LIVE_SPEND_LOCK');
  }
  expect(defaultLiveSpendLockPath()).toContain('.quorum/live-spend.lock.d');
});

test('two real processes contend for one lease (portable)', async () => {
  const lockPath = tmpLockPath(); // NOT pre-created: the holder child creates it
  // Holder child: acquires via this module, then sleeps holding the lease.
  const holderScript = `
    import { acquireLease } from '${join(import.meta.dir, '..', 'src', 'campaign', 'locks.ts')}';
    import { RealClock } from '${join(import.meta.dir, '..', 'src', 'scheduler', 'clock.ts')}';
    import { realProcessIdentityProbe } from '${join(import.meta.dir, '..', 'src', 'campaign', 'locks.ts')}';
    const lease = acquireLease({ lockPath: '${lockPath}', clock: new RealClock(), identity: realProcessIdentityProbe, label: 'test lease' });
    await Bun.sleep(30_000);
    lease.release();
  `;
  const child = Bun.spawn(['bun', '-e', holderScript], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    // Readiness = the owner token exists (guard the poll: the dir itself
    // appears only when the child's mkdir lands).
    let holderPid = 0;
    for (let i = 0; i < 100 && holderPid === 0; i++) {
      const entries = existsSync(lockPath) ? readdirSync(lockPath) : [];
      const owner = entries.find((e) => e.startsWith('owner-'));
      if (owner !== undefined) {
        holderPid =
          parseLockToken(readFileSync(join(lockPath, owner), 'utf8'))?.pid ?? 0;
      }
      // Real backoff by design: readiness is a separate process's mkdir +
      // token write on the real clock — fake timers cannot drive an external
      // process. The poll awaits the observable token, not a guessed duration.
      if (holderPid === 0) await Bun.sleep(50);
    }
    expect(holderPid).toBeGreaterThan(0);
    // Contender refuses, naming the live holder. Its OWN birth must be
    // readable too (acquireLease reads it before inspecting the holder).
    const identity = new FakeIdentity();
    identity.set(process.pid, 'alive', BIRTH);
    identity.set(holderPid, 'alive', 1); // live, any birth — live is live
    expect(() =>
      acquireLease({
        lockPath,
        clock: new FakeClock(0),
        identity,
        label: 'test lease',
      }),
    ).toThrow(new RegExp(String(holderPid)));
  } finally {
    child.kill();
    await child.exited.catch(() => {});
  }
}, 15_000);

// --- Plan-review Critical #8 hardening (locks-module portion) ---------------

test("C8 identity guard: a reclaimed holder never heartbeats into the successor's lock dir", () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  const old = acquireFirst(lockPath, clock, identity);
  // Simulate reclamation: the old holder's dir is severed out from under it
  // and a successor acquires a NEW lock dir at the same path.
  renameSync(lockPath, `${lockPath}.trash`);
  const successorName = 'owner-ffffffff-ffff-4fff-8fff-ffffffffffff';
  const successorToken = formatLockToken({
    pid: HOLDER_PID,
    birth_ts_ms: BIRTH + 5,
    last_heartbeat_ts_ms: 500,
  });
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, successorName), successorToken);
  // The old holder's next beat must refuse loudly (its dir is gone)...
  expect(() => old.heartbeat()).toThrow(LockError);
  // ...and must have written NOTHING into the successor's dir.
  expect(readdirSync(lockPath)).toEqual([successorName]);
  expect(readFileSync(join(lockPath, successorName), 'utf8')).toBe(
    successorToken,
  );
  // The old handle's release is a no-op on the successor's dir.
  old.release();
  expect(existsSync(lockPath)).toBe(true);
});

test('C8 token guard: heartbeat refuses when our own token no longer matches', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  const lease = acquireFirst(lockPath, clock, identity);
  // Same directory (dev+ino intact) but the token inside was replaced with
  // a foreign one: ownership is unprovable, the beat must not overwrite it.
  const foreign = formatLockToken({
    pid: 999,
    birth_ts_ms: 1,
    last_heartbeat_ts_ms: 1,
  });
  writeFileSync(lease.ownerFile, foreign);
  expect(() => lease.heartbeat()).toThrow(LockError);
  expect(readFileSync(lease.ownerFile, 'utf8')).toBe(foreign);
  lease.release();
  expect(existsSync(lockPath)).toBe(false);
});

test('C8 rollback: a post-acquisition failure unwinds fully — no live heartbeat, no held dir', () => {
  const lockPath = tmpLockPath();
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  const exploding: HeartbeatScheduler = {
    every() {
      throw new Error('driver registration failed');
    },
  };
  expect(() =>
    acquireLease({
      lockPath,
      clock: new FakeClock(10),
      identity,
      label: 'test lease',
      scheduler: exploding,
    }),
  ).toThrow(/driver registration failed/);
  expect(existsSync(lockPath)).toBe(false); // the held dir was severed
});

test('C8 unconditional release: a throwing heartbeat-cancel never leaks the held dir', () => {
  const lockPath = tmpLockPath();
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  const badCancel: HeartbeatScheduler = {
    every() {
      return () => {
        throw new Error('cancel failed');
      };
    },
  };
  const lease = acquireLease({
    lockPath,
    clock: new FakeClock(10),
    identity,
    label: 'test lease',
    scheduler: badCancel,
  });
  expect(() => lease.release()).not.toThrow();
  expect(existsSync(lockPath)).toBe(false);
});
