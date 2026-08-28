import { expect, test } from 'bun:test';
import { FakeClock, RealClock } from '../src/scheduler/clock.ts';

test('FakeClock now() reflects advance() and setTo()', () => {
  const clock = new FakeClock(10);
  expect(clock.now()).toBe(10);
  clock.advance(5);
  expect(clock.now()).toBe(15);
  clock.setTo(40);
  expect(clock.now()).toBe(40);
});

test('FakeClock refuses to move backwards', () => {
  const clock = new FakeClock(10);
  expect(() => clock.setTo(5)).toThrow(/backwards/);
});

test('FakeClock sleepUntil resolves only once time reaches the target', async () => {
  const clock = new FakeClock(0);
  let woke = false;
  const sleep = clock.sleepUntil(30).then(() => {
    woke = true;
  });

  // Before the target: a parked waiter, not yet resolved.
  expect(clock.earliestWaiter()).toBe(30);
  clock.advance(10);
  await Promise.resolve();
  expect(woke).toBe(false);

  // Reaching the target releases the waiter.
  clock.advance(20);
  await sleep;
  expect(woke).toBe(true);
  expect(clock.earliestWaiter()).toBeNull();
});

test('FakeClock sleepUntil for an already-past target resolves immediately', async () => {
  const clock = new FakeClock(100);
  let woke = false;
  await clock.sleepUntil(50).then(() => {
    woke = true;
  });
  expect(woke).toBe(true);
});

test('FakeClock sleepUntilCancellable: cancel removes the waiter and resolves expired=false; reaching the target resolves expired=true', async () => {
  const clock = new FakeClock(0);
  const cancelled = clock.sleepUntilCancellable(30);
  expect(clock.earliestWaiter()).toBe(30);
  cancelled.cancel();
  expect(clock.earliestWaiter()).toBeNull(); // no parked waiter survives a cancel
  expect(await cancelled.expired).toBe(false);
  // A second cancel is a no-op; the answer never flips.
  cancelled.cancel();
  expect(await cancelled.expired).toBe(false);

  const expired = clock.sleepUntilCancellable(50);
  clock.advance(50);
  expect(await expired.expired).toBe(true);
  expired.cancel(); // late cancel after expiry changes nothing
  expect(await expired.expired).toBe(true);
});

test('RealClock sleepUntilCancellable: a cancelled sleep clears its timer, so the process is not held open', async () => {
  // The referenced setTimeout behind sleepUntil keeps Bun alive until it
  // fires; cancel() must clear it. Proven the way it fails: a child process
  // that starts a long cancellable sleep, cancels it, and must exit at once.
  const script = `
    import { RealClock } from '${new URL('../src/scheduler/clock.ts', import.meta.url).pathname}';
    const clock = new RealClock();
    const sleep = clock.sleepUntilCancellable(clock.now() + 5);
    sleep.cancel();
    console.log('expired=' + String(await sleep.expired));
  `;
  const startedAt = Date.now();
  const child = Bun.spawnSync(['bun', '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const elapsedMs = Date.now() - startedAt;
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain('expired=false');
  expect(elapsedMs).toBeLessThan(3_000); // 5s timer cleared, not awaited
});

test('RealClock now() advances with wall time', () => {
  const clock = new RealClock();
  const a = clock.now();
  expect(a).toBeGreaterThan(0);
  expect(clock.now()).toBeGreaterThanOrEqual(a);
});
