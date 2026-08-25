// test/campaign-contracts-state-machine.test.ts
import { expect, test } from 'bun:test';
import {
  type CampaignUniverse,
  resolveCrashWindows,
  sealPredicateHolds,
} from '../src/contracts/campaign/crash-windows.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';
import {
  applyCampaignEvent,
  applySampleEvent,
  beginSealing,
  type CampaignState,
  type JournalEventInput,
  SAMPLE_STATES,
  type SampleState,
  type TransitionOutcome,
} from '../src/contracts/campaign/state-machine.ts';

// One typed {type, payload} input per event variant the reducer can see —
// including BOTH sample_disposition payload variants, which drive different
// edges (the reducer is payload-sensitive, not name-sensitive).
const EV = {
  campaign_opened: {
    type: 'campaign_opened',
    payload: { campaign_id: 'c', digest: 'd'.repeat(64) },
  },
  block_admitted: {
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  },
  attempt_created: {
    type: 'attempt_created',
    payload: { sample_id: 's1', attempt_id: 'a1' },
  },
  run_allocated: {
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 42 },
  },
  exposure_started: {
    type: 'exposure_started',
    payload: { sample_id: 's1', ts: 5 },
  },
  run_completed: {
    type: 'run_completed',
    payload: { attempt_id: 'a1', outcome: 'pass' },
  },
  instrument_failure: {
    type: 'instrument_failure',
    payload: { attempt_id: 'a1', cause: 'grader_rate_limited' },
  },
  block_replaced: {
    type: 'block_replaced',
    payload: {
      block_id: 'b1',
      replacement_block_id: 'b2',
      cause: 'grader_rate_limited',
    },
  },
  disposition_included: {
    type: 'sample_disposition',
    payload: { sample_id: 's1', disposition: 'included' },
  },
  disposition_replaced: {
    type: 'sample_disposition',
    payload: {
      sample_id: 's1',
      disposition: 'excluded_block_replaced',
      superseded_by: 's3',
    },
  },
  slot_exhausted: { type: 'slot_exhausted', payload: { sample_id: 's1' } },
  budget_stopped: { type: 'budget_stopped', payload: { sample_ids: ['s1'] } },
  skew_excluded: { type: 'skew_excluded', payload: { block_id: 'b1' } },
  pool_blocked: {
    type: 'pool_blocked',
    payload: { pool_key: 'p', until_ts_ms: 9 },
  },
  budget_event: {
    type: 'budget_event',
    payload: { kind: 'spend', amount_usd: 1 },
  },
  amendment: {
    type: 'amendment',
    payload: { kind: 'budget_raise', amount_usd: 5, ts: 9 },
  },
  adjudication: {
    type: 'adjudication',
    payload: { cell: 'scn@c1', disposition: 'resolved', rationale: 'r' },
  },
  aborted: { type: 'aborted', payload: { block_id: 'b1' } },
  storage_paused: { type: 'storage_paused', payload: {} },
  campaign_cancelled: { type: 'campaign_cancelled', payload: {} },
  sealed: { type: 'sealed', payload: { report_digest: 'e'.repeat(64) } },
} satisfies Record<string, JournalEventInput>;

const A = (next: SampleState): TransitionOutcome => ({
  result: 'apply',
  next,
});
const LATE: TransitionOutcome = { result: 'ignore-late' };

test('the happy path walks planned -> admitted -> spawned -> exposed -> completed', () => {
  let state: SampleState = 'planned';
  for (const [event, next] of [
    [EV.block_admitted, 'admitted'],
    [EV.run_allocated, 'spawned'],
    [EV.exposure_started, 'exposed'],
    [EV.run_completed, 'completed'],
  ] as const) {
    const outcome = applySampleEvent(state, event);
    expect(outcome).toEqual({ result: 'apply', next });
    state = next;
  }
});

test('attempt_created binds only from admitted (journaled between admission and spawn)', () => {
  expect(applySampleEvent('admitted', EV.attempt_created)).toEqual({
    result: 'apply',
    next: 'admitted',
  });
  for (const state of SAMPLE_STATES.filter((s) => s !== 'admitted')) {
    expect(applySampleEvent(state, EV.attempt_created).result).toBe('reject');
  }
});

test('admission-bypass edges: slot_exhausted and budget_stopped', () => {
  expect(applySampleEvent('planned', EV.slot_exhausted)).toEqual(
    A('exhausted'),
  );
  expect(applySampleEvent('planned', EV.budget_stopped)).toEqual(
    A('budget_stopped'),
  );
  // Extension pinned by the D1 spec (proposed parent erratum E3).
  expect(applySampleEvent('admitted', EV.budget_stopped)).toEqual(
    A('budget_stopped'),
  );
});

test('the retained-evidence late sequences are ignore-late, not reject', () => {
  // A skew-excluded sample's run still completes (runs are retained).
  expect(applySampleEvent('skew_excluded', EV.run_completed)).toEqual(LATE);
  // Fast arm completes, then its block is replaced: the innocent arm's
  // disposition overrides a completed state.
  expect(applySampleEvent('completed', EV.disposition_replaced)).toEqual(
    A('excluded_block_replaced'),
  );
  expect(applySampleEvent('spawned', EV.disposition_replaced)).toEqual(
    A('excluded_block_replaced'),
  );
  // instrument_failure after a replacement disposition was already adjudged.
  expect(
    applySampleEvent('excluded_block_replaced', EV.instrument_failure),
  ).toEqual(LATE);
  // First arm can expose after the block is already skew-excluded.
  expect(applySampleEvent('skew_excluded', EV.exposure_started)).toEqual(LATE);
});

test('sample_disposition is payload-sensitive: included never takes the replacement edge', () => {
  // included is a seal-time inclusion record on a completed sample — a
  // non-mutating bind, never a state change.
  expect(applySampleEvent('completed', EV.disposition_included)).toEqual(
    A('completed'),
  );
  for (const state of SAMPLE_STATES.filter((s) => s !== 'completed')) {
    expect(applySampleEvent(state, EV.disposition_included).result).toBe(
      'reject',
    );
  }
});

test('the replacement edge requires superseded_by (malformed payload rejects)', () => {
  const malformed = {
    type: 'sample_disposition',
    payload: { sample_id: 's1', disposition: 'excluded_block_replaced' },
  } as unknown as JournalEventInput;
  for (const state of SAMPLE_STATES) {
    expect(applySampleEvent(state, malformed).result).toBe('reject');
  }
});

test('instrument_failure applies from spawned or exposed only', () => {
  expect(applySampleEvent('spawned', EV.instrument_failure)).toEqual(
    A('instrument_failed'),
  );
  expect(applySampleEvent('exposed', EV.instrument_failure)).toEqual(
    A('instrument_failed'),
  );
  expect(applySampleEvent('planned', EV.instrument_failure).result).toBe(
    'reject',
  );
});

test('abort reaches admitted, spawned, exposed — never terminals', () => {
  for (const state of ['admitted', 'spawned', 'exposed'] as const) {
    expect(applySampleEvent(state, EV.aborted)).toEqual(A('aborted'));
  }
  expect(applySampleEvent('completed', EV.aborted).result).toBe('reject');
});

// The exact transition table: for each event variant, the states where the
// outcome is NOT reject. Every remaining (state x event) cell must reject.
const EXACT: ReadonlyArray<{
  event: keyof typeof EV;
  expected: Partial<Record<SampleState, TransitionOutcome>>;
}> = [
  { event: 'block_admitted', expected: { planned: A('admitted') } },
  { event: 'attempt_created', expected: { admitted: A('admitted') } },
  { event: 'run_allocated', expected: { admitted: A('spawned') } },
  {
    event: 'exposure_started',
    expected: { spawned: A('exposed'), skew_excluded: LATE },
  },
  {
    event: 'run_completed',
    expected: {
      exposed: A('completed'),
      completed: LATE,
      instrument_failed: LATE,
      aborted: LATE,
      skew_excluded: LATE,
      excluded_block_replaced: LATE,
      exhausted: LATE,
      budget_stopped: LATE,
    },
  },
  {
    event: 'instrument_failure',
    expected: {
      spawned: A('instrument_failed'),
      exposed: A('instrument_failed'),
      excluded_block_replaced: LATE,
    },
  },
  { event: 'disposition_included', expected: { completed: A('completed') } },
  {
    event: 'disposition_replaced',
    expected: {
      spawned: A('excluded_block_replaced'),
      exposed: A('excluded_block_replaced'),
      completed: A('excluded_block_replaced'),
    },
  },
  { event: 'slot_exhausted', expected: { planned: A('exhausted') } },
  {
    event: 'budget_stopped',
    expected: {
      planned: A('budget_stopped'),
      admitted: A('budget_stopped'),
    },
  },
  {
    event: 'skew_excluded',
    expected: { spawned: A('skew_excluded'), exposed: A('skew_excluded') },
  },
  {
    event: 'aborted',
    expected: {
      admitted: A('aborted'),
      spawned: A('aborted'),
      exposed: A('aborted'),
    },
  },
  // Campaign-scoped and accounting events never touch sample state.
  { event: 'block_replaced', expected: {} },
  { event: 'pool_blocked', expected: {} },
  { event: 'budget_event', expected: {} },
  { event: 'amendment', expected: {} },
  { event: 'adjudication', expected: {} },
  { event: 'storage_paused', expected: {} },
  { event: 'campaign_cancelled', expected: {} },
  { event: 'sealed', expected: {} },
  { event: 'campaign_opened', expected: {} },
];

test('exact (state x event) expectations: every cell decided, default reject', () => {
  // Every constructed variant appears exactly once in the table.
  expect(new Set(EXACT.map((row) => row.event)).size).toBe(
    Object.keys(EV).length,
  );
  for (const row of EXACT) {
    for (const state of SAMPLE_STATES) {
      const outcome = applySampleEvent(state, EV[row.event]);
      const expected = row.expected[state] ?? { result: 'reject' };
      expect({ event: row.event, state, outcome }).toEqual({
        event: row.event,
        state,
        outcome: expected,
      });
    }
  }
});

test('campaign machine: opened, cancelled, sealed, and storage pauses', () => {
  expect(applyCampaignEvent('registered', 'campaign_opened')).toEqual({
    result: 'apply',
    next: 'running',
  });
  expect(applyCampaignEvent('running', 'campaign_cancelled')).toEqual({
    result: 'apply',
    next: 'cancelled',
  });
  expect(applyCampaignEvent('running', 'storage_paused')).toEqual({
    result: 'apply',
    next: 'storage_paused',
  });
  // Derivation rule: first activity after storage_paused resumes running.
  expect(applyCampaignEvent('storage_paused', 'block_admitted')).toEqual({
    result: 'apply',
    next: 'running',
  });
  expect(applyCampaignEvent('sealing', 'sealed')).toEqual({
    result: 'apply',
    next: 'sealed',
  });
  // Sealed and cancelled are terminal.
  expect(applyCampaignEvent('sealed', 'campaign_cancelled').result).toBe(
    'reject',
  );
  expect(applyCampaignEvent('cancelled', 'campaign_opened').result).toBe(
    'reject',
  );
});

function ev<T extends JournalEvent['type']>(
  seq: number,
  type: T,
  payload: Extract<JournalEvent, { type: T }>['payload'],
): JournalEvent {
  return { seq, ts_ms: seq, type, payload } as JournalEvent;
}

const TWO_SAMPLE_UNIVERSE: CampaignUniverse = {
  samples: [{ sample_id: 's1' }, { sample_id: 's2' }],
  blocks: [{ block_id: 'b1', sample_ids: ['s1', 's2'] }],
};
const ONE_SAMPLE_UNIVERSE: CampaignUniverse = {
  samples: [{ sample_id: 's1' }],
  blocks: [{ block_id: 'b1', sample_ids: ['s1'] }],
};

function completedPrefix(): JournalEvent[] {
  return [
    ev(1, 'campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev(2, 'block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev(3, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev(4, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    ev(5, 'exposure_started', { sample_id: 's1', ts: 5 }),
    ev(6, 'run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    ev(7, 'attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev(8, 'run_allocated', { attempt_id: 'a2', run_id: 'r2', pgid: 43 }),
    ev(9, 'exposure_started', { sample_id: 's2', ts: 9 }),
    ev(10, 'run_completed', { attempt_id: 'a2', outcome: 'fail' }),
  ];
}

test('sealing is reachable: registered -> running -> beginSealing -> sealed', () => {
  let state: CampaignState = 'registered';
  const opened = applyCampaignEvent(state, 'campaign_opened');
  if (opened.result !== 'apply') throw new Error('campaign_opened must apply');
  state = opened.next;
  expect(state).toBe('running');
  const sealing = beginSealing(state, TWO_SAMPLE_UNIVERSE, completedPrefix());
  expect(sealing).toEqual({ result: 'apply', next: 'sealing' });
  expect(applyCampaignEvent('sealing', 'sealed')).toEqual({
    result: 'apply',
    next: 'sealed',
  });
});

test('beginSealing is guarded by the full seal predicate', () => {
  // An incomplete prefix (s2 never terminal) must not begin sealing.
  const incomplete = completedPrefix().slice(0, 6);
  expect(beginSealing('running', TWO_SAMPLE_UNIVERSE, incomplete).result).toBe(
    'reject',
  );
  expect(sealPredicateHolds(TWO_SAMPLE_UNIVERSE, incomplete)).toBe(false);
  expect(sealPredicateHolds(TWO_SAMPLE_UNIVERSE, completedPrefix())).toBe(true);
  // Only running campaigns seal — never registered, cancelled, or sealed.
  for (const state of [
    'registered',
    'sealing',
    'sealed',
    'cancelled',
    'storage_paused',
  ] as const) {
    expect(
      beginSealing(state, TWO_SAMPLE_UNIVERSE, completedPrefix()).result,
    ).toBe('reject');
  }
  // An empty universe never satisfies the predicate (vacuous completeness).
  expect(sealPredicateHolds({ samples: [], blocks: [] }, [])).toBe(false);
});

test('crash windows: pre-run_allocated voids, post-run_allocated reruns', () => {
  const windows = resolveCrashWindows(TWO_SAMPLE_UNIVERSE, [
    ev(1, 'campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev(2, 'block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev(3, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev(4, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 4242 }),
    ev(5, 'attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    // Crash: a1 has run_allocated without a terminal; a2 never allocated.
  ]);
  expect(windows.attempts).toEqual([
    { attempt_id: 'a1', resolution: 'kill_pgid_rerun_block', pgid: 4242 },
    { attempt_id: 'a2', resolution: 'void_attempt_readmit' },
  ]);
  expect(windows.campaign).toBe('none');
});

test('crash windows: completed attempts need nothing', () => {
  const windows = resolveCrashWindows(ONE_SAMPLE_UNIVERSE, [
    ev(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    ev(3, 'run_completed', { attempt_id: 'a1', outcome: 'pass' }),
  ]);
  expect(windows.attempts).toEqual([]);
});

test('crash windows: complete prefix without sealed means regenerate report', () => {
  // EVERY registered sample is terminal and no sealed event exists: the
  // process died post-predicate pre-report.
  const complete = resolveCrashWindows(TWO_SAMPLE_UNIVERSE, completedPrefix());
  expect(complete.attempts).toEqual([]);
  expect(complete.campaign).toBe('regenerate_report');
  const sealed = resolveCrashWindows(TWO_SAMPLE_UNIVERSE, [
    ...completedPrefix(),
    ev(11, 'sealed', { report_digest: 'e'.repeat(64) }),
  ]);
  expect(sealed.campaign).toBe('none');
});

test('crash windows: an incomplete campaign never claims the report window', () => {
  // Every OBSERVED attempt is terminal, but registered sample s2 was never
  // attempted — the campaign is mid-flight, not post-predicate. (This was
  // the one-attempt-prefix false positive.)
  const windows = resolveCrashWindows(TWO_SAMPLE_UNIVERSE, [
    ev(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    ev(3, 'run_completed', { attempt_id: 'a1', outcome: 'pass' }),
  ]);
  expect(windows.attempts).toEqual([]);
  expect(windows.campaign).toBe('none');
});

test('crash windows: cancellation retires every window (no rerun, no report)', () => {
  // A cancelled campaign is terminal: an in-flight allocated attempt must
  // not be rerun and no report is regenerated. D3's recovery still kills
  // journaled pgids first, unconditionally.
  const windows = resolveCrashWindows(TWO_SAMPLE_UNIVERSE, [
    ev(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    ev(3, 'campaign_cancelled', {}),
  ]);
  expect(windows.attempts).toEqual([]);
  expect(windows.campaign).toBe('none');
});

test("crash windows: budget_stopped retires the stopped sample's attempt", () => {
  // budget_stopped is sample-terminal (budget_stopped ∈ TERMINAL_STATES), so
  // recovery must not kill and rerun a block the budget policy already
  // stopped — that would be a double-spend recommendation.
  const windows = resolveCrashWindows(ONE_SAMPLE_UNIVERSE, [
    ev(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    ev(3, 'budget_stopped', { sample_ids: ['s1'] }),
    // Crash.
  ]);
  expect(windows.attempts).toEqual([]);
});

test("crash windows: the replacement disposition retires the disposed sample's attempt", () => {
  const windows = resolveCrashWindows(ONE_SAMPLE_UNIVERSE, [
    ev(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    ev(3, 'sample_disposition', {
      sample_id: 's1',
      disposition: 'excluded_block_replaced',
      superseded_by: 'r2',
    }),
    // Crash.
  ]);
  expect(windows.attempts).toEqual([]);
});

test('crash windows: an aborted block is terminal — its attempts are never rerun', () => {
  // aborted carries block_id only; the frozen universe supplies the
  // block -> samples mapping, so the block-terminal event retires the
  // attempt instead of recommending a rerun of an aborted block.
  const windows = resolveCrashWindows(ONE_SAMPLE_UNIVERSE, [
    ev(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    ev(3, 'aborted', { block_id: 'b1' }),
    // Crash.
  ]);
  expect(windows.attempts).toEqual([]);
});

test('crash windows: a skew-excluded block is terminal — its attempts are never rerun', () => {
  const windows = resolveCrashWindows(TWO_SAMPLE_UNIVERSE, [
    ev(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    ev(3, 'attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev(4, 'run_allocated', { attempt_id: 'a2', run_id: 'r2', pgid: 43 }),
    ev(5, 'skew_excluded', { block_id: 'b1' }),
    // Crash.
  ]);
  expect(windows.attempts).toEqual([]);
  // Both samples are terminal via the block event; the report regenerates.
  expect(windows.campaign).toBe('regenerate_report');
});

test('crash windows: events naming unknown samples or blocks are no-ops', () => {
  // Malformed prefix (missing attempt_created binding / unregistered ids):
  // lookups miss and must not throw — and unknown ids never complete the
  // registered universe.
  const windows = resolveCrashWindows(
    { samples: [{ sample_id: 's-registered' }], blocks: [] },
    [
      ev(1, 'budget_stopped', { sample_ids: ['s-unknown'] }),
      ev(2, 'sample_disposition', {
        sample_id: 's-unknown',
        disposition: 'included',
      }),
      ev(3, 'aborted', { block_id: 'b-unknown' }),
    ],
  );
  expect(windows.attempts).toEqual([]);
  expect(windows.campaign).toBe('none');
});
