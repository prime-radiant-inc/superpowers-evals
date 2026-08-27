import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_RESOURCE_FLOORS,
  PreflightError,
  preflightResourceFloors,
} from '../src/campaign/host-stats.ts';
import {
  acquireLease,
  acquireLiveSpendLock,
  COVERED_BY_LOCK_ENV,
  DEFAULT_HEARTBEAT_MS,
  defaultLiveSpendLockPath,
  formatLockToken,
  type HeartbeatScheduler,
  type LeaseHandle,
  LockError,
  type ProcessIdentityProbe,
  parseLockToken,
  readLiveSpendHolder,
  realHeartbeatScheduler,
} from '../src/campaign/locks.ts';
import { deleteProcessEnv, getEnv, setProcessEnv } from '../src/env.ts';
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

test('R2: live-spend acquisition is a pure lock claim — resource floors are a separate admission step (REV sol #8c)', () => {
  const lockPath = tmpLockPath();
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  // The same below-floor sample that the standalone preflight refuses must
  // NOT block acquisition: kill/reconcile of orphan spenders runs under the
  // lock regardless of the floor debate. Spender verbs pin the order
  // acquire → kill/reconcile → preflight → admit; the probe is not even a
  // parameter of acquisition.
  expect(() =>
    preflightResourceFloors(
      {
        ts_ms: 0,
        load1: 0.1,
        mem_available_bytes: 8 * 2 ** 30,
        mem_total_bytes: 16 * 2 ** 30,
        swap_used_bytes: 0,
        swap_total_bytes: 2 * 2 ** 30,
        process_count: 200,
        pid_max: 4_194_304,
        disk_free_bytes: 1,
        disk_total_bytes: 494 * 2 ** 30,
      },
      DEFAULT_RESOURCE_FLOORS,
    ),
  ).toThrow(PreflightError);
  const lock = acquireLiveSpendLock({
    lockPath,
    campaignId: 'abc123',
    clock: new FakeClock(5),
    identity,
  });
  expect(existsSync(lockPath)).toBe(true); // acquired despite the floors
  const holder = readLiveSpendHolder(lockPath);
  expect(holder?.campaignId).toBe('abc123');
  lock.release();
  expect(existsSync(lockPath)).toBe(false);
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

// --- Review fix round 1: 2 Critical + 5 Important --------------------------------

// --- Review fix round 3: heartbeat publication + reclaim severance races ----

/** A FakeClock whose next now() runs an adversary first: the deterministic
 *  interleave point between the heartbeat's last ownership check and its
 *  write (clockNowMs is the final call before publication). */
class TrapClock extends FakeClock {
  trap: (() => void) | null = null;
  override now(): number {
    const t = this.trap;
    if (t !== null) {
      this.trap = null;
      t();
    }
    return super.now();
  }
}

test('HB-1: a replacement landing between the ownership check and the write receives nothing — the beat lands only on our own token', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'hb-trap-'));
  const lockPath = join(workdir, 'test.lock.d');
  const advTrash = join(workdir, 'displaced-by-adversary');
  const clock = new TrapClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  const lease = acquireLease({
    lockPath,
    clock,
    identity,
    label: 'test lease',
  });
  const successorName = 'owner-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const successorToken = formatLockToken({
    pid: HOLDER_PID,
    birth_ts_ms: BIRTH + 9,
    last_heartbeat_ts_ms: 4_242,
  });
  clock.advance(30);
  clock.trap = () => {
    // Reclamation replaces the directory at the worst possible moment: after
    // every pre-write ownership check has passed, before the write.
    renameSync(lockPath, advTrash);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, successorName), successorToken);
  };
  expect(() => lease.heartbeat()).toThrow(LockError);
  // The successor's directory was never touched...
  expect(readdirSync(lockPath)).toEqual([successorName]);
  expect(readFileSync(join(lockPath, successorName), 'utf8')).toBe(
    successorToken,
  );
  // ...and the fresh heartbeat landed on OUR OWN token, wherever the
  // directory went — publication is bound to the holder's inode, never to
  // the mutable lock path.
  const ownName = readdirSync(advTrash).find((e) => e.startsWith('owner-'))!;
  expect(
    parseLockToken(readFileSync(join(advTrash, ownName), 'utf8'))!
      .last_heartbeat_ts_ms,
  ).toBe(40_000);
});

test('HB-2: two owner tokens in the lock dir is corruption — the heartbeat fails closed and stops beating', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  const beats: (() => void)[] = [];
  const cancelled: boolean[] = [];
  const scheduler: HeartbeatScheduler = {
    every(_ms, cb) {
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
  const planted = 'owner-11111111-1111-4111-8111-111111111111';
  const plantedBody = formatLockToken({
    pid: HOLDER_PID,
    birth_ts_ms: BIRTH,
    last_heartbeat_ts_ms: 12_000,
  });
  writeFileSync(join(lockPath, planted), plantedBody);
  clock.advance(30);
  expect(() => beats[0]!()).toThrow(/multiple owner tokens/i);
  // Fail-closed: nothing was written and the beat driver was cancelled.
  expect(
    parseLockToken(readFileSync(lease.ownerFile, 'utf8'))!.last_heartbeat_ts_ms,
  ).toBe(10_000);
  expect(readFileSync(join(lockPath, planted), 'utf8')).toBe(plantedBody);
  expect(cancelled).toEqual([true]);
});

test('HB-3: a token file swapped for a different file with identical bytes is never beaten through — ownership is the inode, not the content', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  const lease = acquireFirst(lockPath, clock, identity);
  const bytes = readFileSync(lease.ownerFile, 'utf8');
  rmSync(lease.ownerFile);
  writeFileSync(lease.ownerFile, bytes); // same name, same bytes, new inode
  clock.advance(30);
  expect(() => lease.heartbeat()).toThrow(LockError);
  expect(readFileSync(lease.ownerFile, 'utf8')).toBe(bytes); // untouched
});

// Real thread + Atomics barrier: the parent swaps the judged token for a FIFO
// EXACTLY between the contender's dead-holder judgment and its severance. A
// reclaim that re-reads the token through the mutable lock path parks on the
// FIFO forever; the rename-first claim never re-reads through the path — it
// verifies the severed directory under its private trash name and fails
// loudly on the non-regular token.
test('RC-1: reclaim never re-reads the judged token through the mutable lock path between judgment and severance', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'reclaim-race-'));
  const lockPath = join(workdir, 'test.lock.d');
  const tokenName = 'owner-00000000-0000-4000-8000-000000000000';
  plantStaleHolder(lockPath, 10_000);
  const workerFile = join(workdir, 'worker.ts');
  writeFileSync(
    workerFile,
    `
    import { parentPort, workerData } from 'node:worker_threads';
    import { acquireLease } from '${join(import.meta.dir, '..', 'src', 'campaign', 'locks.ts')}';
    import { FakeClock } from '${join(import.meta.dir, '..', 'src', 'scheduler', 'clock.ts')}';
    const { lockPath, sab } = workerData as { lockPath: string; sab: SharedArrayBuffer };
    const flag = new Int32Array(sab);
    const identity = {
      exists(pid: number): 'alive' | 'esrch' | 'unknown' {
        if (pid === process.pid) return 'alive';
        parentPort?.postMessage({ kind: 'at-judgment' });
        Atomics.wait(flag, 0, 0); // parked until the parent swaps the token
        return 'esrch';
      },
      startTimeMs(pid: number): number | null {
        return pid === process.pid ? ${BIRTH} : null;
      },
    };
    try {
      acquireLease({ lockPath, clock: new FakeClock(210), identity, label: 'test lease' });
      parentPort?.postMessage({ kind: 'done', threw: false });
    } catch (err) {
      parentPort?.postMessage({
        kind: 'done',
        threw: true,
        name: (err as Error).name,
        message: (err as Error).message,
      });
    }
  `,
  );
  const sab = new SharedArrayBuffer(4);
  const worker = new Worker(workerFile, { workerData: { lockPath, sab } });
  interface WorkerMsg {
    kind: 'at-judgment' | 'done';
    threw?: boolean;
    name?: string;
    message?: string;
  }
  const waitFor = (kind: WorkerMsg['kind']) =>
    new Promise<WorkerMsg>((resolve) => {
      const on = (m: WorkerMsg) => {
        if (m.kind === kind) {
          worker.off('message', on);
          resolve(m);
        }
      };
      worker.on('message', on);
    });
  await waitFor('at-judgment');
  // The interleave: the judged token stops being a regular file while the
  // contender sits between its judgment and its severance.
  rmSync(join(lockPath, tokenName));
  spawnSync('mkfifo', [join(lockPath, tokenName)]);
  const flag = new Int32Array(sab);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  const result = await waitFor('done');
  await worker.terminate();
  expect(result.threw).toBe(true);
  expect(result.name).toBe('LockError');
  expect(result.message).toMatch(/regular file|parked/i);
  // The claim freed the lock path; the severed state is parked under a
  // private trash name for the operator.
  expect(existsSync(lockPath)).toBe(false);
  expect(
    readdirSync(workdir).some((e) => e.startsWith('test.lock.d.trash-')),
  ).toBe(true);
}, 15_000);

test('RB-1: a rollback that cannot free the lock surfaces BOTH the original failure and the held path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-'));
  const lockPath = join(dir, 'test.lock.d');
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  const exploding: HeartbeatScheduler = {
    every() {
      chmodSync(dir, 0o500); // the rollback's severing rename will fail EACCES
      throw new Error('driver registration failed');
    },
  };
  let thrown: Error | null = null;
  try {
    acquireLease({
      lockPath,
      clock: new FakeClock(10),
      identity,
      label: 'test lease',
      scheduler: exploding,
    });
  } catch (err) {
    thrown = err as Error;
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(thrown).toBeInstanceOf(LockError);
  expect(thrown!.message).toContain('driver registration failed');
  expect(thrown!.message).toContain(lockPath);
  expect(thrown!.message).toMatch(/still be held|could not free/i);
  expect(existsSync(lockPath)).toBe(true); // genuinely held — reported, not hidden
});

test("Cr-2: a delayed stale contender never severs the successor's fresh dir", () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  clock.advance(200);
  plantStaleHolder(lockPath, 10_000);
  const plain = new FakeIdentity();
  plain.set(process.pid, 'alive', BIRTH);
  plain.set(HOLDER_PID, 'esrch', null);
  let successor: LeaseHandle | null = null;
  let raced = false;
  // The delayed contender's identity probe is the interleave point: the
  // quick contender severs the dead holder and acquires WHILE the delayed
  // one sits between its observation and its sever.
  const delayed: ProcessIdentityProbe = {
    exists: (pid) => {
      if (pid === HOLDER_PID && !raced) {
        raced = true;
        successor = acquireLease({
          lockPath,
          clock,
          identity: plain,
          label: 'successor lease',
        });
      }
      return plain.exists(pid);
    },
    startTimeMs: (pid) => plain.startTimeMs(pid),
  };
  expect(() =>
    acquireLease({ lockPath, clock, identity: delayed, label: 'test lease' }),
  ).toThrow(LockError);
  expect(successor).not.toBeNull();
  expect(existsSync(successor!.ownerFile)).toBe(true); // never severed
  // The successor survived any displacement intact: its identity (dev+ino)
  // is preserved, so its heartbeat still proves ownership.
  clock.advance(1);
  successor!.heartbeat();
  expect(
    parseLockToken(readFileSync(successor!.ownerFile, 'utf8'))!
      .last_heartbeat_ts_ms,
  ).toBe(211_000);
  successor!.release();
});

test('I2a+b: ambiguous or corrupt holder tokens refuse loudly', () => {
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  // (a) two canonical owner tokens = ambiguous holder state
  const two = tmpLockPath();
  mkdirSync(two);
  writeFileSync(
    join(two, 'owner-00000000-0000-4000-8000-000000000000'),
    formatLockToken({ pid: 1, birth_ts_ms: 1, last_heartbeat_ts_ms: 1 }),
  );
  writeFileSync(
    join(two, 'owner-11111111-1111-4111-8111-111111111111'),
    formatLockToken({ pid: 2, birth_ts_ms: 2, last_heartbeat_ts_ms: 2 }),
  );
  expect(() =>
    acquireLease({
      lockPath: two,
      clock: new FakeClock(10),
      identity,
      label: 'test lease',
    }),
  ).toThrow(/multiple owner tokens/i);
  // (b) exactly one owner token whose body is garbage
  const corrupt = tmpLockPath();
  mkdirSync(corrupt);
  writeFileSync(
    join(corrupt, 'owner-00000000-0000-4000-8000-000000000000'),
    'garbage',
  );
  expect(() =>
    acquireLease({
      lockPath: corrupt,
      clock: new FakeClock(10),
      identity,
      label: 'test lease',
    }),
  ).toThrow(/unparseable/i);
});

test('I5: no absolute lock path available refuses loudly', () => {
  const hadHome = getEnv('HOME');
  const hadOverride = getEnv('QUORUM_LIVE_SPEND_LOCK');
  try {
    deleteProcessEnv('HOME');
    deleteProcessEnv('QUORUM_LIVE_SPEND_LOCK');
    expect(() => defaultLiveSpendLockPath()).toThrow(LockError);
    setProcessEnv('QUORUM_LIVE_SPEND_LOCK', 'relative/lock.d');
    expect(() => defaultLiveSpendLockPath()).toThrow(/absolute/i);
    setProcessEnv('QUORUM_LIVE_SPEND_LOCK', '/tmp/abs-lock.d');
    expect(defaultLiveSpendLockPath()).toBe('/tmp/abs-lock.d');
    setProcessEnv('HOME', 'relative/home');
    deleteProcessEnv('QUORUM_LIVE_SPEND_LOCK');
    expect(() => defaultLiveSpendLockPath()).toThrow(/absolute/i);
  } finally {
    if (hadHome === undefined) deleteProcessEnv('HOME');
    else setProcessEnv('HOME', hadHome);
    if (hadOverride === undefined) deleteProcessEnv('QUORUM_LIVE_SPEND_LOCK');
    else setProcessEnv('QUORUM_LIVE_SPEND_LOCK', hadOverride);
  }
});

test('I3: release surfaces cleanup failure loudly and stays retryable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-'));
  const lockPath = join(dir, 'test.lock.d');
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  const lease = acquireLease({
    lockPath,
    clock,
    identity,
    label: 'test lease',
  });
  chmodSync(dir, 0o500); // block the severing rename: the parent is unwritable
  try {
    expect(() => lease.release()).toThrow(/cannot sever|still held/i);
    // The handle stays retryable and the lease genuinely still held:
    // heartbeats keep proving ownership.
    clock.advance(5);
    expect(() => lease.heartbeat()).not.toThrow();
    expect(
      parseLockToken(readFileSync(lease.ownerFile, 'utf8'))!
        .last_heartbeat_ts_ms,
    ).toBe(15_000);
  } finally {
    chmodSync(dir, 0o700);
  }
  lease.release();
  expect(existsSync(lockPath)).toBe(false);
});

test('I4: campaign-id sidecar failure rolls the lease back — heartbeat stopped, path absent', () => {
  const lockPath = tmpLockPath();
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  const beats: (() => void)[] = [];
  const scheduler: HeartbeatScheduler = {
    every(_ms, cb) {
      chmodSync(lockPath, 0o500); // deterministic sidecar-write failure
      beats.push(cb);
      return () => {};
    },
  };
  expect(() =>
    acquireLiveSpendLock({
      lockPath,
      campaignId: 'abc123',
      clock: new FakeClock(5),
      identity,
      scheduler,
    }),
  ).toThrow(/EACCES/);
  expect(existsSync(lockPath)).toBe(false); // the lease unwound fully
  expect(beats).toHaveLength(1);
  beats[0]!(); // a beat after the rollback must be a no-op
  expect(existsSync(lockPath)).toBe(false);
});

test('I1: empty-dir polling runs on the injected clock — a FakeClock terminates deterministically with no wall-time waiting', () => {
  const lockPath = tmpLockPath();
  mkdirSync(lockPath); // a contender "mid-acquire" whose token never lands
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  const clock = new FakeClock(10);
  const t0 = performance.now();
  const lease = acquireLease({
    lockPath,
    clock,
    identity,
    label: 'test lease',
  });
  const elapsedMs = performance.now() - t0;
  expect(existsSync(lease.ownerFile)).toBe(true);
  // The grace decision AND the waiting both ride the injected clock: the
  // fake clock advanced itself past the grace window without one physical
  // sleep — wall time is never proof of crash.
  expect(clock.now()).toBeGreaterThan(10);
  expect(elapsedMs).toBeLessThan(100);
  lease.release();
  expect(existsSync(lockPath)).toBe(false);
});

test('I2c: an unreadable lock dir is never judged blind', () => {
  const lockPath = tmpLockPath();
  plantStaleHolder(lockPath, 10_000);
  chmodSync(lockPath, 0o000);
  try {
    const identity = new FakeIdentity();
    identity.set(process.pid, 'alive', BIRTH);
    expect(() =>
      acquireLease({
        lockPath,
        clock: new FakeClock(210),
        identity,
        label: 'test lease',
      }),
    ).toThrow(/cannot inspect/i);
  } finally {
    chmodSync(lockPath, 0o700);
  }
});

// --- Review fix round 4: fail-closed claim inspection + three-contender ----

/** A FakeClock that runs an adversary inside the FIRST now() read past the
 *  empty-grace window: the deterministic interleave point between the last
 *  successful observation of the empty dir and the severing claim. */
class ExpiryTrapClock extends FakeClock {
  adversary: (() => void) | null = null;
  override now(): number {
    const t = super.now();
    if (t > 10.12 && this.adversary !== null) {
      const a = this.adversary;
      this.adversary = null;
      a();
    }
    return t;
  }
}

test('FC-1: a severed directory that cannot be inspected is never treated as empty — nothing deleted, loud refusal', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'fc1-'));
  const lockPath = join(workdir, 'test.lock.d');
  mkdirSync(lockPath); // a contender "mid-acquire", judged empty past grace
  const slowName = 'owner-abababab-abab-4bab-8bab-abababababab';
  const clock = new ExpiryTrapClock(10);
  clock.adversary = () => {
    // A slow acquisition lands AND the directory becomes uninspectable in
    // the window between the last empty observation and the severing claim.
    writeFileSync(join(lockPath, slowName), 'a live acquisition landed');
    chmodSync(lockPath, 0o000);
  };
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  try {
    expect(() =>
      acquireLease({ lockPath, clock, identity, label: 'test lease' }),
    ).toThrow(/cannot inspect/i);
  } finally {
    for (const e of readdirSync(workdir)) {
      if (e.startsWith('test.lock.d')) chmodSync(join(workdir, e), 0o700);
    }
  }
  // The uninspectable claim deleted NOTHING: the landed token survives,
  // parked under the private trash name for the operator.
  const trash = readdirSync(workdir).find((e) =>
    e.startsWith('test.lock.d.trash-'),
  )!;
  expect(trash).toBeDefined();
  expect(readFileSync(join(workdir, trash, slowName), 'utf8')).toBe(
    'a live acquisition landed',
  );
});

test('FC-2: a judged token that cannot be inspected after the claim refuses loudly — never judged as corruption blind', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'fc2-'));
  const lockPath = join(workdir, 'test.lock.d');
  const tokenName = 'owner-00000000-0000-4000-8000-000000000000';
  plantStaleHolder(lockPath, 10_000);
  const plain = new FakeIdentity();
  plain.set(process.pid, 'alive', BIRTH);
  plain.set(HOLDER_PID, 'esrch', null);
  // The interleave point: the directory becomes uninspectable between the
  // dead-holder judgment and the severing claim.
  const identity: ProcessIdentityProbe = {
    exists: (pid) => {
      if (pid === HOLDER_PID) chmodSync(lockPath, 0o000);
      return plain.exists(pid);
    },
    startTimeMs: (pid) => plain.startTimeMs(pid),
  };
  try {
    expect(() =>
      acquireLease({
        lockPath,
        clock: new FakeClock(210),
        identity,
        label: 'test lease',
      }),
    ).toThrow(/cannot inspect/i);
  } finally {
    for (const e of readdirSync(workdir)) {
      if (e.startsWith('test.lock.d')) chmodSync(join(workdir, e), 0o700);
    }
  }
  // Nothing was deleted through the uninspectable state: the judged token
  // survives under the parked trash name.
  const trash = readdirSync(workdir).find((e) =>
    e.startsWith('test.lock.d.trash-'),
  )!;
  expect(readdirSync(join(workdir, trash))).toEqual([tokenName]);
});

// Three contenders, real thread + Atomics barrier (the adjudicated D2
// closure): C2's freshly created dir is parked out from under it (C1's
// mistaken grab) while C2 sits between its mkdir and its token write, and
// C3 re-takes the path. C2's post-create identity re-proof must refuse —
// a parked fresh owner never acts as holder — and its rollback must remove
// the stray token it wrote into C3's directory, leaving C3 undisturbed.
test('TC-1: a parked fresh owner refuses to act while the third contender holds', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'tc1-'));
  const lockPath = join(workdir, 'test.lock.d');
  const parked = join(workdir, 'parked-by-c1');
  const workerFile = join(workdir, 'worker.ts');
  writeFileSync(
    workerFile,
    `
    import { parentPort, workerData } from 'node:worker_threads';
    import { acquireLease } from '${join(import.meta.dir, '..', 'src', 'campaign', 'locks.ts')}';
    const { lockPath, sab } = workerData as { lockPath: string; sab: SharedArrayBuffer };
    const flag = new Int32Array(sab);
    let nowCalls = 0;
    // First now() read = the token-timestamp read between mkdir and the
    // token write: the barrier parks C2 exactly there.
    const clock = {
      now(): number {
        nowCalls += 1;
        if (nowCalls === 1) {
          parentPort?.postMessage({ kind: 'mid-create' });
          Atomics.wait(flag, 0, 0);
        }
        return 10;
      },
      sleepUntil: () => Promise.resolve(),
      sleepSync: (_s: number) => {},
    };
    const identity = {
      exists: () => 'alive' as const,
      startTimeMs: (pid: number) => (pid === process.pid ? ${BIRTH} : null),
    };
    try {
      acquireLease({ lockPath, clock, identity, label: 'test lease' });
      parentPort?.postMessage({ kind: 'done', threw: false });
    } catch (err) {
      parentPort?.postMessage({
        kind: 'done',
        threw: true,
        name: (err as Error).name,
        message: (err as Error).message,
      });
    }
  `,
  );
  const sab = new SharedArrayBuffer(4);
  const worker = new Worker(workerFile, { workerData: { lockPath, sab } });
  interface WorkerMsg {
    kind: 'mid-create' | 'done';
    threw?: boolean;
    name?: string;
    message?: string;
  }
  const waitFor = (kind: WorkerMsg['kind']) =>
    new Promise<WorkerMsg>((resolve) => {
      const on = (m: WorkerMsg) => {
        if (m.kind === kind) {
          worker.off('message', on);
          resolve(m);
        }
      };
      worker.on('message', on);
    });
  await waitFor('mid-create');
  // C1's mistaken grab parks C2's fresh dir; C3 re-takes the path.
  renameSync(lockPath, parked);
  mkdirSync(lockPath);
  const c3Name = 'owner-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const c3Token = formatLockToken({
    pid: HOLDER_PID,
    birth_ts_ms: BIRTH + 3,
    last_heartbeat_ts_ms: 999_000,
  });
  writeFileSync(join(lockPath, c3Name), c3Token);
  const flag = new Int32Array(sab);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  const result = await waitFor('done');
  await worker.terminate();
  // The parked fresh owner discovered the displacement at its post-create
  // identity re-proof and refused to act as holder.
  expect(result.threw).toBe(true);
  expect(result.name).toBe('LockError');
  expect(result.message).toMatch(/vanished mid-acquire/i);
  // C3 holds, undisturbed: its dir contains ONLY its token (C2's stray,
  // written through the re-taken path, was rolled back by unique name).
  expect(readdirSync(lockPath)).toEqual([c3Name]);
  expect(readFileSync(join(lockPath, c3Name), 'utf8')).toBe(c3Token);
  // C2's parked dir is orphan-inert (C2 never wrote into it).
  expect(readdirSync(parked)).toEqual([]);
}, 15_000);

test('RB-2: a stray token that cannot be removed from a replacement directory surfaces loudly with the original failure', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'rb2-'));
  const lockPath = join(workdir, 'test.lock.d');
  const displaced = join(workdir, 'displaced');
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  let strayPath = '';
  const exploding: HeartbeatScheduler = {
    every() {
      // The dir is replaced mid-acquisition and the replacement holds a
      // foreign file under OUR token's name, in a read-only dir: the
      // rollback's stray removal must fail — and must say so.
      const ownerName = readdirSync(lockPath).find((e) =>
        e.startsWith('owner-'),
      )!;
      strayPath = join(lockPath, ownerName);
      renameSync(lockPath, displaced);
      mkdirSync(lockPath);
      writeFileSync(strayPath, 'foreign stray');
      chmodSync(lockPath, 0o555);
      throw new Error('driver registration failed');
    },
  };
  let thrown: Error | null = null;
  try {
    acquireLease({
      lockPath,
      clock: new FakeClock(10),
      identity,
      label: 'test lease',
      scheduler: exploding,
    });
  } catch (err) {
    thrown = err as Error;
  } finally {
    chmodSync(lockPath, 0o700);
  }
  expect(thrown).toBeInstanceOf(LockError);
  expect(thrown!.message).toContain('driver registration failed');
  expect(thrown!.message).toContain(strayPath);
  expect(thrown!.message).toMatch(/could not be removed|stray/i);
  // The stray is still there — reported, not silently abandoned.
  expect(readFileSync(strayPath, 'utf8')).toBe('foreign stray');
});
