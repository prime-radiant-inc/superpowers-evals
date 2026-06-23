import { expect, test } from 'bun:test';
import type {
  ChildResult,
  MatrixEntry,
  SkippedReason,
} from '../src/contracts/batch.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import type { SchedulerEvent } from '../src/scheduler/index.ts';
import { runSchedule } from '../src/scheduler/index.ts';

// A deferred promise the test resolves by hand, so a stub invoke can hold a
// child "in flight" until the test decides it completes.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Build a minimal runnable MatrixEntry for a (scenario, agent) pair. The
// scheduler only reads scenario / codingAgent / scenarioDir off the entry.
// limiterKey defaults to agent (credential-less fallback) for scheduler tests.
function cell(
  scenario: string,
  agent: string,
  limiterKey?: string,
): MatrixEntry {
  const skippedReason: SkippedReason = null;
  return {
    scenario,
    codingAgent: agent,
    scenarioDir: `/fake/scenarios/${scenario}`,
    skippedReason,
    tier: 'full',
    status: 'active',
    credential: '',
    limiterKey: limiterKey ?? agent,
  };
}

// A trivially-successful ChildResult for `agent`, numbered by call order.
function okResult(runId: string): ChildResult {
  return { run_id: runId, exit_code: 0, error: null };
}

// Let pending microtasks settle so the dispatcher reaches its parked state.
async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// Advance a FakeClock to its earliest parked waiter and let the dispatcher's
// awaited sleep wake, repeatedly, until no waiter remains or `max` ticks pass.
// Settles microtasks between advances so the dispatcher fully re-dispatches and
// re-parks before the next waiter is read (instant-completing invokes hop
// through several microtasks per wake).
async function drainClock(clock: FakeClock, max = 100): Promise<void> {
  for (let i = 0; i < max; i++) {
    await settle();
    const next = clock.earliestWaiter();
    if (next === null) {
      return;
    }
    clock.setTo(next);
  }
}

// Pull cell_started / terminal events into a flat shape for assertions.
function startedEntries(events: readonly SchedulerEvent[]): MatrixEntry[] {
  return events.filter((e) => e.kind === 'cell_started').map((e) => e.entry);
}

// ---------------------------------------------------------------------------
// Test 1: Global cap — total in-flight never exceeds `jobs`, even when
// per-harness lanes exist (the incumbent's exact failure).
// ---------------------------------------------------------------------------
test('1: global cap is never exceeded even with per-harness caps', async () => {
  const clock = new FakeClock();
  // 3 harnesses; A is capped at 1, B and C unbounded. jobs=2. If lanes leaked
  // (incumbent bug), A's lane plus the main pool could put 3 in flight.
  const cells = [
    cell('s1', 'a'),
    cell('s2', 'a'),
    cell('s1', 'b'),
    cell('s2', 'b'),
    cell('s1', 'c'),
    cell('s2', 'c'),
  ];
  const pending: Array<(r: ChildResult) => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const { done } = runSchedule({
    cells,
    jobs: 2,
    capFor: (h) => (h === 'a' ? 1 : null),
    spacingFor: () => 0,
    clock,
    invoke: () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const d = deferred<ChildResult>();
      pending.push((r) => {
        inFlight -= 1;
        d.resolve(r);
      });
      return d.promise;
    },
    isRateLimited: () => false,
    onEvent: () => {},
  });

  // Drain: repeatedly release the oldest in-flight child until all complete.
  while (inFlight > 0 || pending.length > 0) {
    await Promise.resolve();
    const release = pending.shift();
    if (release !== undefined) {
      release(okResult('x'));
    }
    await Promise.resolve();
  }
  await done;

  expect(maxInFlight).toBeLessThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// Test 2: Harness cap — per-harness in-flight never exceeds max_concurrency.
// ---------------------------------------------------------------------------
test('2: per-harness in-flight never exceeds its cap', async () => {
  const clock = new FakeClock();
  const cells = [
    cell('s1', 'a'),
    cell('s2', 'a'),
    cell('s3', 'a'),
    cell('s1', 'b'),
    cell('s2', 'b'),
  ];
  const pending: Array<{ agent: string; release: () => void }> = [];
  const inFlightByAgent = new Map<string, number>();
  const maxByAgent = new Map<string, number>();

  const { done } = runSchedule({
    cells,
    jobs: 8,
    capFor: (h) => (h === 'a' ? 2 : null),
    spacingFor: () => 0,
    clock,
    invoke: (c) => {
      const agent = c.codingAgent;
      const cur = (inFlightByAgent.get(agent) ?? 0) + 1;
      inFlightByAgent.set(agent, cur);
      maxByAgent.set(agent, Math.max(maxByAgent.get(agent) ?? 0, cur));
      const d = deferred<ChildResult>();
      pending.push({
        agent,
        release: () => {
          inFlightByAgent.set(agent, (inFlightByAgent.get(agent) ?? 1) - 1);
          d.resolve(okResult('x'));
        },
      });
      return d.promise;
    },
    isRateLimited: () => false,
    onEvent: () => {},
  });

  while (
    pending.length > 0 ||
    [...inFlightByAgent.values()].some((v) => v > 0)
  ) {
    await Promise.resolve();
    const next = pending.shift();
    if (next !== undefined) {
      next.release();
    }
    await Promise.resolve();
  }
  await done;

  expect(maxByAgent.get('a')).toBeLessThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// Test 3: Spacing — consecutive starts of one harness are >= spacing apart,
// measured start-to-start.
// ---------------------------------------------------------------------------
test('3: consecutive starts of one harness honor launch spacing', async () => {
  const clock = new FakeClock();
  const cells = [cell('s1', 'a'), cell('s2', 'a'), cell('s3', 'a')];
  const startTimes: number[] = [];

  const { done } = runSchedule({
    cells,
    jobs: 8,
    capFor: () => null,
    spacingFor: (h) => (h === 'a' ? 30 : 0),
    clock,
    invoke: () => {
      startTimes.push(clock.now());
      // Each run completes instantly so only spacing — not the cap — gates.
      return Promise.resolve(okResult('x'));
    },
    isRateLimited: () => false,
    onEvent: () => {},
  });

  await drainClock(clock);
  await done;

  expect(startTimes).toHaveLength(3);
  for (let i = 1; i < startTimes.length; i++) {
    const gap = (startTimes[i] ?? 0) - (startTimes[i - 1] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(30);
  }
});

// ---------------------------------------------------------------------------
// Test 4: No wasted slots — the STATE assertion. jobs=2, A cap=1 with one
// running + more queued, B unbounded queued; once dispatch quiesces assert
// inflight[B] == 1, free_slots == 0, A's remaining cells still undispatched.
// ---------------------------------------------------------------------------
test('4: no wasted slots — a cap-blocked harness never holds a free slot', async () => {
  const clock = new FakeClock();
  // A has 2 cells (cap=1 -> one runs, one is blocked by the cap). B has 1 cell
  // (unbounded). jobs=2. The blocked A cell must NOT occupy the second slot;
  // B must take it instead.
  const cells = [cell('s1', 'a'), cell('s2', 'a'), cell('s1', 'b')];
  const started: string[] = [];

  const { done } = runSchedule({
    cells,
    jobs: 2,
    capFor: (h) => (h === 'a' ? 1 : null),
    spacingFor: () => 0,
    clock,
    // Children never complete (deferred, never resolved) so the batch stays at
    // its quiesced steady state for the assertion.
    invoke: (c) => {
      started.push(c.codingAgent);
      return new Promise<ChildResult>(() => {});
    },
    isRateLimited: () => false,
    onEvent: () => {},
  });

  // Let the dispatcher reach steady state (no completions will ever fire).
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }

  // Exactly one A and one B started; the second A is blocked by A's cap and the
  // global pool is full, so it stays undispatched.
  const aStarts = started.filter((h) => h === 'a').length;
  const bStarts = started.filter((h) => h === 'b').length;
  expect(aStarts).toBe(1); // inflight[A] == 1 (cap), the other A undispatched
  expect(bStarts).toBe(1); // inflight[B] == 1 — B took the second slot
  expect(started).toHaveLength(2); // free_slots == 0, nothing else dispatched

  // The promise stays pending (children never resolve); the test asserts the
  // quiesced state, not completion. Mark `done` consumed so no floating promise.
  void done;
});

// ---------------------------------------------------------------------------
// Test 5: Latch — a rate-limited completion immediately skips all of that
// harness's undispatched cells (rate-limited); other harnesses proceed.
// ---------------------------------------------------------------------------
test('5: a rate-limited completion eagerly skips that harness undispatched cells', async () => {
  const clock = new FakeClock();
  const cells = [
    cell('s1', 'a'),
    cell('s2', 'a'),
    cell('s3', 'a'),
    cell('s1', 'b'),
  ];
  const events: SchedulerEvent[] = [];
  // a's runs are cap=1 (serial); the first completes rate-limited.
  let aCalls = 0;

  const { done } = runSchedule({
    cells,
    jobs: 8,
    capFor: (h) => (h === 'a' ? 1 : null),
    spacingFor: () => 0,
    clock,
    invoke: (c) => {
      if (c.codingAgent === 'a') {
        aCalls += 1;
        // The first a-run reports rate-limited; isRateLimited keys off run_id.
        return Promise.resolve(okResult(aCalls === 1 ? 'a-rl' : 'a-ok'));
      }
      return Promise.resolve(okResult('b-ok'));
    },
    isRateLimited: (r) => r.run_id === 'a-rl',
    onEvent: (e) => {
      events.push(e);
    },
  });

  await drainClock(clock);
  await done;

  // Exactly one a-run was invoked (the first); the latch skipped the rest.
  expect(aCalls).toBe(1);

  const skipped = events.filter((e) => e.kind === 'cell_skipped');
  const rateLimitedSkips = skipped.filter(
    (e) => e.skipped_reason === 'rate-limited',
  );
  // s2/a and s3/a — the two undispatched a-cells — were skipped rate-limited.
  expect(rateLimitedSkips.map((e) => e.entry.scenario).sort()).toEqual([
    's2',
    's3',
  ]);
  for (const e of rateLimitedSkips) {
    expect(e.entry.codingAgent).toBe('a');
  }

  // b proceeded: it finished, never skipped.
  const bFinished = events.some(
    (e) => e.kind === 'cell_finished' && e.entry.codingAgent === 'b',
  );
  expect(bFinished).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 6: Stop — setting stop immediately skips all undispatched cells
// (stopped); nothing new spawns.
// ---------------------------------------------------------------------------
test('6: stop eagerly skips all undispatched cells and spawns nothing new', async () => {
  const clock = new FakeClock();
  const cells = [
    cell('s1', 'a'),
    cell('s2', 'a'),
    cell('s1', 'b'),
    cell('s2', 'b'),
  ];
  const events: SchedulerEvent[] = [];
  let totalInvoked = 0;

  // jobs=1 so exactly one cell starts; the other three are still queued. The
  // started child stays in flight (deferred, never resolved) — when stop is
  // requested, the three undispatched cells must skip immediately, and the one
  // in-flight child is the consumer's concern (left to drain).
  const inFlight = deferred<ChildResult>();
  const { done, requestStop } = runSchedule({
    cells,
    jobs: 1,
    capFor: () => null,
    spacingFor: () => 0,
    clock,
    invoke: () => {
      totalInvoked += 1;
      return inFlight.promise;
    },
    isRateLimited: () => false,
    onEvent: (e) => {
      events.push(e);
    },
  });

  // Let the one slot fill, then request stop.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  expect(totalInvoked).toBe(1);

  requestStop();
  // Let the eager-skip cascade run.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }

  // Nothing new spawned after the stop: still exactly one invocation.
  expect(totalInvoked).toBe(1);

  // The three undispatched cells were skipped with reason 'stopped'.
  const stoppedSkips = events.filter(
    (e) => e.kind === 'cell_skipped' && e.skipped_reason === 'stopped',
  );
  expect(stoppedSkips).toHaveLength(3);

  // Release the in-flight child so the batch can drain and finish.
  inFlight.resolve(okResult('x'));
  await done;

  // batch_done fired exactly once, last.
  const batchDone = events.filter((e) => e.kind === 'batch_done');
  expect(batchDone).toHaveLength(1);
  expect(events.at(-1)?.kind).toBe('batch_done');
});

// ---------------------------------------------------------------------------
// Test 7: Termination — exactly one terminal event per runnable cell;
// batch_done exactly once, last.
// ---------------------------------------------------------------------------
test('7: exactly one terminal event per cell and batch_done strictly last', async () => {
  const clock = new FakeClock();
  const cells = [
    cell('s1', 'a'),
    cell('s2', 'a'),
    cell('s1', 'b'),
    cell('s2', 'b'),
    cell('s1', 'c'),
  ];
  const events: SchedulerEvent[] = [];

  const { done } = runSchedule({
    cells,
    jobs: 2,
    capFor: (h) => (h === 'a' ? 1 : null),
    spacingFor: (h) => (h === 'b' ? 5 : 0),
    clock,
    invoke: () => Promise.resolve(okResult('x')),
    isRateLimited: () => false,
    onEvent: (e) => {
      events.push(e);
    },
  });

  await drainClock(clock);
  await done;

  // Every runnable cell emits cell_queued exactly once, before any start.
  const queued = events.filter((e) => e.kind === 'cell_queued');
  expect(queued).toHaveLength(cells.length);
  const firstStartIdx = events.findIndex((e) => e.kind === 'cell_started');
  const lastQueuedIdx = events.reduce(
    (acc, e, i) => (e.kind === 'cell_queued' ? i : acc),
    -1,
  );
  expect(lastQueuedIdx).toBeLessThan(firstStartIdx);

  // Exactly one terminal (finished | skipped) per cell.
  const terminalByIdx = new Map<number, number>();
  for (const e of events) {
    if (e.kind === 'cell_finished' || e.kind === 'cell_skipped') {
      terminalByIdx.set(e.idx, (terminalByIdx.get(e.idx) ?? 0) + 1);
    }
  }
  expect(terminalByIdx.size).toBe(cells.length);
  for (const count of terminalByIdx.values()) {
    expect(count).toBe(1);
  }

  // A started cell finishes (started precedes its finished); no skipped cell
  // ever started.
  const startedIdxs = new Set(
    events.filter((e) => e.kind === 'cell_started').map((e) => e.idx),
  );
  const skippedIdxs = new Set(
    events.filter((e) => e.kind === 'cell_skipped').map((e) => e.idx),
  );
  for (const idx of skippedIdxs) {
    expect(startedIdxs.has(idx)).toBe(false);
  }

  // batch_done fires exactly once and is the strictly last event.
  const batchDone = events.filter((e) => e.kind === 'batch_done');
  expect(batchDone).toHaveLength(1);
  expect(events.at(-1)?.kind).toBe('batch_done');
});

// ---------------------------------------------------------------------------
// Test 8: No fairness — greedy/unfair interleavings are permitted. This asserts
// only properties 1–7 hold; it does NOT constrain dispatch order. We run a
// harness mix and confirm all cells started (greedy fills slots) without
// asserting WHICH order they started in.
// ---------------------------------------------------------------------------
test('8: no fairness — greedy unfair interleaving is permitted (order unconstrained)', async () => {
  const clock = new FakeClock();
  const cells = [
    cell('s1', 'a'),
    cell('s2', 'a'),
    cell('s1', 'b'),
    cell('s2', 'b'),
  ];
  const events: SchedulerEvent[] = [];

  const { done } = runSchedule({
    cells,
    jobs: 8, // every cell can run at once: greedy fills all slots
    capFor: () => null,
    spacingFor: () => 0,
    clock,
    invoke: () => Promise.resolve(okResult('x')),
    isRateLimited: () => false,
    onEvent: (e) => {
      events.push(e);
    },
  });

  await drainClock(clock);
  await done;

  // All four cells started — greedy dispatch filled the (ample) slots. We make
  // NO assertion about the relative order of a-vs-b starts (no fairness).
  expect(startedEntries(events)).toHaveLength(4);
  const finished = events.filter((e) => e.kind === 'cell_finished');
  expect(finished).toHaveLength(4);
});

// ---------------------------------------------------------------------------
// Test 9: Cross-agent limiterKey sharing — two cells with the same limiterKey
// but different codingAgent values share the cap (cap=1 => they serialize).
// ---------------------------------------------------------------------------
test('9: two cells with the same limiterKey but different agents share the cap', async () => {
  const clock = new FakeClock();
  // Both cells share limiterKey "shared-endpoint|anthropic" but have different
  // codingAgents. Cap=1 on that limiterKey => they must serialize.
  const sharedKey = 'shared-endpoint|anthropic';
  const cells = [
    cell('s1', 'claude', sharedKey),
    cell('s1', 'claude-haiku', sharedKey),
  ];
  let maxInFlight = 0;
  let inFlight = 0;
  // Resolvers queued in invoke order; test releases them one by one.
  const releases: Array<() => void> = [];

  const { done } = runSchedule({
    cells,
    jobs: 8,
    capFor: (lk) => (lk === sharedKey ? 1 : null),
    spacingFor: () => 0,
    clock,
    invoke: () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const d = deferred<ChildResult>();
      releases.push(() => {
        inFlight -= 1;
        d.resolve(okResult('x'));
      });
      return d.promise;
    },
    isRateLimited: () => false,
    onEvent: () => {},
  });

  // Release each child as it becomes available. With cap=1 on the shared key
  // we must release one before the second can start. Settle between releases so
  // the scheduler can dispatch the next cell.
  await settle();
  // First cell should have started.
  expect(releases).toHaveLength(1);
  releases[0]?.();
  await settle();
  // Second cell should now have started.
  expect(releases).toHaveLength(2);
  releases[1]?.();
  await done;

  // The shared cap of 1 must have prevented concurrent runs.
  expect(maxInFlight).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 10: Rate-limit latch blast-radius — a latch on one cell skips ALL queued
// cells sharing that limiterKey (across different agents), and does NOT skip
// cells with a different limiterKey.
// ---------------------------------------------------------------------------
test('10: rate-limit latch skips queued cells of the same limiterKey across agents, not different limiterKey', async () => {
  const clock = new FakeClock();
  const sharedKey = 'shared-endpoint|anthropic';
  const otherKey = 'other-endpoint|anthropic';

  // s1/claude + s2/claude-haiku share limiterKey (cap=1, serial). s1/codex has
  // a different limiterKey. The first shared-key cell completes rate-limited =>
  // s2/claude-haiku (same limiterKey, queued) must be skipped; s1/codex (different
  // limiterKey) must still run.
  const cells = [
    cell('s1', 'claude', sharedKey), // runs first, rate-limited
    cell('s2', 'claude-haiku', sharedKey), // same limiterKey -> latched out
    cell('s1', 'codex', otherKey), // different limiterKey -> proceeds
  ];
  const events: SchedulerEvent[] = [];
  let invocations = 0;

  const { done } = runSchedule({
    cells,
    jobs: 8,
    capFor: (lk) => (lk === sharedKey ? 1 : null),
    spacingFor: () => 0,
    clock,
    invoke: (c) => {
      invocations += 1;
      // The first invoke (claude, sharedKey) is rate-limited
      if (c.codingAgent === 'claude') {
        return Promise.resolve(okResult('rl-run'));
      }
      return Promise.resolve(okResult('ok-run'));
    },
    isRateLimited: (r) => r.run_id === 'rl-run',
    onEvent: (e) => {
      events.push(e);
    },
  });

  await drainClock(clock);
  await done;

  // claude-haiku must NOT have been invoked (latched out by blast-radius).
  // codex MUST have been invoked (different limiterKey).
  expect(invocations).toBe(2); // claude + codex only

  const rateLimitedSkips = events.filter(
    (e): e is Extract<SchedulerEvent, { kind: 'cell_skipped' }> =>
      e.kind === 'cell_skipped' && e.skipped_reason === 'rate-limited',
  );
  // Only claude-haiku (same limiterKey) was skipped rate-limited.
  expect(rateLimitedSkips).toHaveLength(1);
  expect(rateLimitedSkips[0]?.entry.codingAgent).toBe('claude-haiku');

  // codex finished normally (not skipped).
  const codexFinished = events.some(
    (e) => e.kind === 'cell_finished' && e.entry.codingAgent === 'codex',
  );
  expect(codexFinished).toBe(true);
});
