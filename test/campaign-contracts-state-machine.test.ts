// test/campaign-contracts-state-machine.test.ts
import { expect, test } from 'bun:test';
import { resolveCrashWindows } from '../src/contracts/campaign/crash-windows.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';
import {
  applyCampaignEvent,
  applySampleEvent,
  SAMPLE_STATES,
  type SampleState,
  TERMINAL_STATES,
} from '../src/contracts/campaign/state-machine.ts';

test('the happy path walks planned -> admitted -> spawned -> exposed -> completed', () => {
  let state: SampleState = 'planned';
  for (const [event, next] of [
    ['block_admitted', 'admitted'],
    ['run_allocated', 'spawned'],
    ['exposure_started', 'exposed'],
    ['run_completed', 'completed'],
  ] as const) {
    const outcome = applySampleEvent(state, event);
    expect(outcome).toEqual({ result: 'apply', next });
    state = next;
  }
});

test('attempt_created binds without changing state', () => {
  expect(applySampleEvent('admitted', 'attempt_created')).toEqual({
    result: 'apply',
    next: 'admitted',
  });
});

test('admission-bypass edges: slot_exhausted and budget_stopped', () => {
  expect(applySampleEvent('planned', 'slot_exhausted')).toEqual({
    result: 'apply',
    next: 'exhausted',
  });
  expect(applySampleEvent('planned', 'budget_stopped')).toEqual({
    result: 'apply',
    next: 'budget_stopped',
  });
  // Extension pinned by the D1 spec (proposed parent erratum E3).
  expect(applySampleEvent('admitted', 'budget_stopped')).toEqual({
    result: 'apply',
    next: 'budget_stopped',
  });
});

test('the retained-evidence late sequences are ignore-late, not reject', () => {
  // A skew-excluded sample's run still completes (runs are retained).
  expect(applySampleEvent('skew_excluded', 'run_completed')).toEqual({
    result: 'ignore-late',
  });
  // Fast arm completes, then its block is replaced: the innocent arm's
  // disposition overrides a completed state.
  expect(applySampleEvent('completed', 'sample_disposition')).toEqual({
    result: 'apply',
    next: 'excluded_block_replaced',
  });
  expect(applySampleEvent('spawned', 'sample_disposition')).toEqual({
    result: 'apply',
    next: 'excluded_block_replaced',
  });
  // instrument_failure after a replacement disposition was already adjudged.
  expect(
    applySampleEvent('excluded_block_replaced', 'instrument_failure'),
  ).toEqual({
    result: 'ignore-late',
  });
  // First arm can expose after the block is already skew-excluded.
  expect(applySampleEvent('skew_excluded', 'exposure_started')).toEqual({
    result: 'ignore-late',
  });
});

test('instrument_failure applies from spawned or exposed only', () => {
  expect(applySampleEvent('spawned', 'instrument_failure')).toEqual({
    result: 'apply',
    next: 'instrument_failed',
  });
  expect(applySampleEvent('exposed', 'instrument_failure')).toEqual({
    result: 'apply',
    next: 'instrument_failed',
  });
  expect(applySampleEvent('planned', 'instrument_failure').result).toBe(
    'reject',
  );
});

test('abort reaches admitted, spawned, exposed — never terminals', () => {
  for (const state of ['admitted', 'spawned', 'exposed'] as const) {
    expect(applySampleEvent(state, 'aborted')).toEqual({
      result: 'apply',
      next: 'aborted',
    });
  }
  expect(applySampleEvent('completed', 'aborted').result).toBe('reject');
});

test('every (state x event) pair is decided — no undefined outcomes', () => {
  const events = [
    'block_admitted',
    'attempt_created',
    'run_allocated',
    'exposure_started',
    'run_completed',
    'instrument_failure',
    'block_replaced',
    'sample_disposition',
    'slot_exhausted',
    'budget_stopped',
    'skew_excluded',
    'pool_blocked',
    'budget_event',
    'amendment',
    'adjudication',
    'aborted',
    'storage_paused',
    'campaign_cancelled',
    'sealed',
    'campaign_opened',
  ] as const;
  for (const state of SAMPLE_STATES) {
    for (const event of events) {
      const outcome = applySampleEvent(state, event);
      expect(['apply', 'ignore-late', 'reject']).toContain(outcome.result);
      if (outcome.result === 'apply') {
        expect(SAMPLE_STATES).toContain(outcome.next);
      }
    }
  }
  // Terminals never apply further state changes (ignore-late only), except
  // the pinned innocent-arm override: sample_disposition applies from
  // completed to excluded_block_replaced (asserted in the retained-evidence
  // test above).
  for (const terminal of TERMINAL_STATES) {
    for (const event of events) {
      if (terminal === 'completed' && event === 'sample_disposition') continue;
      const outcome = applySampleEvent(terminal, event);
      if (outcome.result === 'apply') {
        expect(outcome.next).toBe(terminal); // bind-only at most
      }
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

function event(
  seq: number,
  type: JournalEvent['type'],
  payload: unknown,
): JournalEvent {
  return { seq, ts_ms: seq, type, payload } as JournalEvent;
}

test('crash windows: pre-run_allocated voids, post-run_allocated reruns', () => {
  const windows = resolveCrashWindows([
    event(1, 'campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    event(2, 'block_admitted', { block_id: 'b1', pools: ['p'] }),
    event(3, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(4, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 4242 }),
    event(5, 'attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    // Crash: a1 has run_allocated without a terminal; a2 never allocated.
  ]);
  expect(windows.attempts).toEqual([
    { attempt_id: 'a1', resolution: 'kill_pgid_rerun_block', pgid: 4242 },
    { attempt_id: 'a2', resolution: 'void_attempt_readmit' },
  ]);
  expect(windows.campaign).toBe('none');
});

test('crash windows: completed attempts need nothing', () => {
  const windows = resolveCrashWindows([
    event(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    event(3, 'run_completed', { attempt_id: 'a1', outcome: 'pass' }),
  ]);
  expect(windows.attempts).toEqual([]);
});

test('crash windows: all-samples-terminal without sealed means regenerate report', () => {
  const windows = resolveCrashWindows([
    event(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    event(3, 'run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    // No sealed event: the process died post-predicate pre-report.
  ]);
  expect(windows.campaign).toBe('regenerate_report');
  const sealed = resolveCrashWindows([
    event(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    event(3, 'run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    event(4, 'sealed', { report_digest: 'e'.repeat(64) }),
  ]);
  expect(sealed.campaign).toBe('none');
});

test("crash windows: budget_stopped retires the stopped sample's attempt", () => {
  // budget_stopped is sample-terminal (budget_stopped ∈ TERMINAL_STATES), so
  // recovery must not kill and rerun a block the budget policy already
  // stopped — that would be a double-spend recommendation.
  const windows = resolveCrashWindows([
    event(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    event(3, 'budget_stopped', { sample_ids: ['s1'] }),
    // Crash.
  ]);
  expect(windows.attempts).toEqual([]);
});

test("crash windows: sample_disposition retires the disposed sample's attempt", () => {
  const windows = resolveCrashWindows([
    event(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    event(3, 'sample_disposition', {
      sample_id: 's1',
      disposition: 'excluded_block_replaced',
      superseded_by: 'r2',
    }),
    // Crash.
  ]);
  expect(windows.attempts).toEqual([]);
});

test('crash windows: block-scoped aborted does not retire attempts at this layer', () => {
  // aborted carries only block_id; this layer has no block->samples map, so
  // the attempt still yields its rerun window and D3's block rule owns abort
  // retirement during recovery.
  const windows = resolveCrashWindows([
    event(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    event(3, 'aborted', { block_id: 'b1' }),
    // Crash.
  ]);
  expect(windows.attempts).toEqual([
    { attempt_id: 'a1', resolution: 'kill_pgid_rerun_block', pgid: 42 },
  ]);
});

test('crash windows: sample-scoped terminals without a known attempt are no-ops', () => {
  // Malformed prefix (missing attempt_created binding): lookups miss the
  // sample->attempt map and must not throw.
  const windows = resolveCrashWindows([
    event(1, 'budget_stopped', { sample_ids: ['s-unknown'] }),
    event(2, 'sample_disposition', {
      sample_id: 's-unknown',
      disposition: 'included',
    }),
  ]);
  expect(windows.attempts).toEqual([]);
  expect(windows.campaign).toBe('none');
});
