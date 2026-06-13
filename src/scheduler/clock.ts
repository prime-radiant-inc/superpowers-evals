// The injectable clock the scheduler reads for BOTH eligibility
// (now >= next_start[h]) and its sleep target. The spec mandates all time reads
// go through one clock; mixing the injected clock with wall time for sleeps
// fails the verification contract's determinism requirement.
//
// Units are SECONDS (matching the spec's launch_spacing_seconds), fractional
// allowed. now() is a point in time; sleepUntil(target) resolves once now() has
// reached target. A target already in the past resolves on the next tick.

export interface Clock {
  // The current time, in seconds. Monotonic within a process.
  now(): number;
  // Resolve once now() >= targetSeconds. Already-past targets resolve promptly.
  sleepUntil(targetSeconds: number): Promise<void>;
}

// Wall-clock implementation: now() is the real epoch in seconds, sleepUntil
// schedules a real setTimeout for the remaining delay. Used in production
// (run-all / the dashboard); never in the deterministic tests.
export class RealClock implements Clock {
  now(): number {
    return Date.now() / 1000;
  }

  sleepUntil(targetSeconds: number): Promise<void> {
    const remainingMs = Math.max(0, targetSeconds - this.now()) * 1000;
    return new Promise<void>((resolveP) => {
      setTimeout(resolveP, remainingMs);
    });
  }
}

// One pending sleepUntil waiter: the target it is waiting for and the resolver
// to fire once time reaches it.
interface Waiter {
  readonly target: number;
  readonly resolve: () => void;
}

// Deterministic clock for tests. Time advances only via advance(seconds) (or
// setTo). sleepUntil() registers a waiter resolved synchronously-then-async when
// advance() carries now() to/past its target — NO real setTimeout, so a test
// drives the dispatcher's whole timeline by hand.
export class FakeClock implements Clock {
  private current: number;
  private waiters: Waiter[];

  constructor(start = 0) {
    this.current = start;
    this.waiters = [];
  }

  now(): number {
    return this.current;
  }

  sleepUntil(targetSeconds: number): Promise<void> {
    if (targetSeconds <= this.current) {
      return Promise.resolve();
    }
    return new Promise<void>((resolveP) => {
      this.waiters.push({ target: targetSeconds, resolve: resolveP });
    });
  }

  // Move time forward by `seconds` and release every waiter whose target is now
  // reached. Resolvers fire via the microtask queue (the Promise contract), so a
  // test awaits a tick after advance() to let the dispatcher react.
  advance(seconds: number): void {
    this.setTo(this.current + seconds);
  }

  // Move time to an absolute point (must not go backwards) and release reached
  // waiters.
  setTo(targetSeconds: number): void {
    if (targetSeconds < this.current) {
      throw new Error(
        `FakeClock cannot move backwards: ${targetSeconds} < ${this.current}`,
      );
    }
    this.current = targetSeconds;
    const due = this.waiters.filter((w) => w.target <= this.current);
    this.waiters = this.waiters.filter((w) => w.target > this.current);
    for (const w of due) {
      w.resolve();
    }
  }

  // The earliest target any waiter is parked on, or null when none are sleeping.
  // Tests use it to advance straight to the next wake without guessing.
  earliestWaiter(): number | null {
    if (this.waiters.length === 0) {
      return null;
    }
    return Math.min(...this.waiters.map((w) => w.target));
  }
}
