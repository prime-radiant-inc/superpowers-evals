// test/campaign-contracts-journal.test.ts
import { expect, test } from 'bun:test';
import {
  JOURNAL_EVENT_TYPES,
  type JournalEvent,
  JournalEventSchema,
  type JournalEventType,
} from '../src/contracts/campaign/journal-events.ts';
import {
  FAILURE_CLASSES,
  INSTRUMENT_CAUSES,
} from '../src/contracts/campaign/typed-failures.ts';

// Deferred-ledger repair: JournalEventType is a closed literal union, not a
// widened string — a non-vocabulary literal must not typecheck.
// @ts-expect-error — 'invented_event' is outside the closed event union
const _closedUnion: JournalEventType = 'invented_event';
void _closedUnion;

test("the typed-failure codomain is the parent's four classes", () => {
  expect(FAILURE_CLASSES).toEqual([
    'instrument',
    'evidence',
    'aborted',
    'shortfall',
  ]);
});

test('the initial instrument-cause vocabulary covers the named grader causes', () => {
  expect(INSTRUMENT_CAUSES).toContain('grader_billing_exhausted');
  expect(INSTRUMENT_CAUSES).toContain('grader_rate_limited');
});

test("the vocabulary holds the parent's 19 events, campaign_cancelled (E5), and quarantined (E7)", () => {
  expect(JOURNAL_EVENT_TYPES).toHaveLength(21);
  for (const type of [
    'campaign_opened',
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
    'quarantined',
    'sealed',
  ] as const) {
    expect(JOURNAL_EVENT_TYPES).toContain(type);
  }
});

test('every event type round-trips through the envelope', () => {
  const rows: JournalEvent[] = [
    {
      seq: 1,
      ts_ms: 1,
      type: 'campaign_opened',
      payload: { campaign_id: 'c', digest: 'd'.repeat(64) },
    },
    {
      seq: 2,
      ts_ms: 2,
      type: 'block_admitted',
      payload: { block_id: 'b1', pools: ['p|api|model'] },
    },
    {
      seq: 3,
      ts_ms: 3,
      type: 'attempt_created',
      payload: { sample_id: 's1', attempt_id: 'a1' },
    },
    {
      seq: 4,
      ts_ms: 4,
      type: 'run_allocated',
      payload: { attempt_id: 'a1', run_id: 'r1', pgid: 4242 },
    },
    {
      seq: 5,
      ts_ms: 5,
      type: 'run_allocated',
      payload: {
        attempt_id: 'a1',
        run_id: 'r1',
        pgid: 4242,
        key_env: 'GRADER_KEY_2',
      },
    },
    {
      seq: 6,
      ts_ms: 6,
      type: 'exposure_started',
      payload: { sample_id: 's1', ts: 6 },
    },
    {
      seq: 7,
      ts_ms: 7,
      type: 'run_completed',
      payload: { attempt_id: 'a1', outcome: 'pass' },
    },
    {
      seq: 8,
      ts_ms: 8,
      type: 'instrument_failure',
      payload: { attempt_id: 'a1', cause: 'grader_rate_limited' },
    },
    {
      seq: 9,
      ts_ms: 9,
      type: 'block_replaced',
      payload: {
        block_id: 'b1',
        replacement_block_id: 'b2',
        cause: 'grader_rate_limited',
      },
    },
    {
      seq: 10,
      ts_ms: 10,
      type: 'sample_disposition',
      payload: {
        sample_id: 's1',
        disposition: 'excluded_block_replaced',
        superseded_by: 's3',
      },
    },
    {
      seq: 11,
      ts_ms: 11,
      type: 'slot_exhausted',
      payload: { sample_id: 's9' },
    },
    {
      seq: 12,
      ts_ms: 12,
      type: 'budget_stopped',
      payload: { sample_ids: ['s4', 's5'] },
    },
    { seq: 13, ts_ms: 13, type: 'skew_excluded', payload: { block_id: 'b3' } },
    {
      seq: 14,
      ts_ms: 14,
      type: 'pool_blocked',
      payload: { pool_key: 'p', until_ts_ms: 99 },
    },
    {
      seq: 15,
      ts_ms: 15,
      type: 'budget_event',
      payload: { kind: 'spend', amount_usd: 1.5 },
    },
    {
      seq: 16,
      ts_ms: 16,
      type: 'amendment',
      payload: { kind: 'budget_raise', amount_usd: 20, ts: 16 },
    },
    {
      seq: 17,
      ts_ms: 17,
      type: 'adjudication',
      payload: {
        cell: 'scn@c1',
        disposition: 'resolved',
        rationale: 'tripwire explained',
      },
    },
    { seq: 18, ts_ms: 18, type: 'aborted', payload: { block_id: 'b1' } },
    { seq: 19, ts_ms: 19, type: 'storage_paused', payload: {} },
    {
      seq: 20,
      ts_ms: 20,
      type: 'campaign_cancelled',
      payload: { reason: 'operator' },
    },
    {
      seq: 21,
      ts_ms: 21,
      type: 'sealed',
      payload: { report_digest: 'e'.repeat(64) },
    },
  ];
  for (const row of rows) {
    expect(JournalEventSchema.parse(row)).toEqual(row);
  }
});

test('run_completed caveats are typed (R-SNS-4 exploratory caveat, operator amendment 2026-08-27)', () => {
  const caveated: JournalEvent = {
    seq: 7,
    ts_ms: 7,
    type: 'run_completed',
    payload: {
      attempt_id: 'a1',
      outcome: 'pass',
      caveat: 'exploratory_exposure_unestablished',
    },
  };
  expect(JournalEventSchema.parse(caveated)).toEqual(caveated);
  expect(() =>
    JournalEventSchema.parse({
      seq: 7,
      ts_ms: 7,
      type: 'run_completed',
      payload: { attempt_id: 'a1', outcome: 'pass', caveat: 'vibes' },
    }),
  ).toThrow();
});

test('instrument_failure causes are typed', () => {
  expect(() =>
    JournalEventSchema.parse({
      seq: 1,
      ts_ms: 1,
      type: 'instrument_failure',
      payload: { attempt_id: 'a1', cause: 'vibes' },
    }),
  ).toThrow();
});

test('envelope rejects unknown types and missing fields', () => {
  expect(() =>
    JournalEventSchema.parse({
      seq: 1,
      ts_ms: 1,
      type: 'invented',
      payload: {},
    }),
  ).toThrow();
  expect(() =>
    JournalEventSchema.parse({
      ts_ms: 1,
      type: 'aborted',
      payload: { block_id: 'b' },
    }),
  ).toThrow();
  expect(() =>
    JournalEventSchema.parse({
      seq: 1,
      type: 'aborted',
      payload: { block_id: 'b' },
    }),
  ).toThrow();
});

test('run_allocated key_env carries the name only (schema forbids values)', () => {
  // The payload shape is {attempt_id, run_id, pgid, key_env?}: a value-shaped
  // key_env object fails the string schema.
  expect(() =>
    JournalEventSchema.parse({
      seq: 1,
      ts_ms: 1,
      type: 'run_allocated',
      payload: {
        attempt_id: 'a1',
        run_id: 'r1',
        pgid: 1,
        key_env: { value: 'secret' },
      },
    }),
  ).toThrow();
});

test('key_env must be an environment-variable name, never a secret-shaped string', () => {
  const allocated = (keyEnv: string) => ({
    seq: 1,
    ts_ms: 1,
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 1, key_env: keyEnv },
  });
  expect(JournalEventSchema.parse(allocated('GRADER_KEY_2'))).toMatchObject({
    type: 'run_allocated',
  });
  // Secret-shaped and non-environment names violate the shared env-name
  // regex (^[A-Za-z_][A-Za-z0-9_]*$).
  expect(() =>
    JournalEventSchema.parse(allocated('sk-ant-api03-abc123')),
  ).toThrow();
  expect(() => JournalEventSchema.parse(allocated('KEY=value'))).toThrow();
  expect(() => JournalEventSchema.parse(allocated('9LEADING'))).toThrow();
});

test('the envelope is strict: unknown top-level keys reject, never strip', () => {
  expect(() =>
    JournalEventSchema.parse({
      seq: 18,
      ts_ms: 18,
      type: 'aborted',
      payload: { block_id: 'b1' },
      operator_note: 'smuggled',
    }),
  ).toThrow();
});

test('sample_disposition requires superseded_by exactly for excluded_block_replaced', () => {
  const disposition = (payload: Record<string, unknown>) => ({
    seq: 10,
    ts_ms: 10,
    type: 'sample_disposition' as const,
    payload: { sample_id: 's1', ...payload },
  });
  // included is a plain inclusion record: no supersession pointer allowed.
  const included: JournalEvent = {
    seq: 10,
    ts_ms: 10,
    type: 'sample_disposition',
    payload: { sample_id: 's1', disposition: 'included' },
  };
  expect(JournalEventSchema.parse(included)).toEqual(included);
  expect(() =>
    JournalEventSchema.parse(
      disposition({ disposition: 'included', superseded_by: 's3' }),
    ),
  ).toThrow();
  // The replacement disposition must name its superseding sample.
  expect(() =>
    JournalEventSchema.parse(
      disposition({ disposition: 'excluded_block_replaced' }),
    ),
  ).toThrow();
});

test('budget amounts are finite (YAML .inf must not journal)', () => {
  expect(() =>
    JournalEventSchema.parse({
      seq: 15,
      ts_ms: 15,
      type: 'budget_event',
      payload: { kind: 'spend', amount_usd: Number.POSITIVE_INFINITY },
    }),
  ).toThrow();
  expect(() =>
    JournalEventSchema.parse({
      seq: 16,
      ts_ms: 16,
      type: 'amendment',
      payload: {
        kind: 'budget_raise',
        amount_usd: Number.POSITIVE_INFINITY,
        ts: 16,
      },
    }),
  ).toThrow();
});

test('JOURNAL_EVENT_TYPES exactly covers the schema union (no missing, no extra)', () => {
  const schemaTypes = JournalEventSchema.options.map(
    (option) => option.shape.type.value,
  );
  expect(new Set(JOURNAL_EVENT_TYPES)).toEqual(new Set(schemaTypes));
  expect(JOURNAL_EVENT_TYPES).toHaveLength(schemaTypes.length);
});
