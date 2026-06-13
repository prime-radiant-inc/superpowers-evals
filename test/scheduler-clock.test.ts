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

test('RealClock now() advances with wall time', () => {
  const clock = new RealClock();
  const a = clock.now();
  expect(a).toBeGreaterThan(0);
  expect(clock.now()).toBeGreaterThanOrEqual(a);
});
