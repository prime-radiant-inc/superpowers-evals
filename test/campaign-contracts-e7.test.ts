import { expect, test } from 'bun:test';
import {
  BlockReplacedEvent,
  JOURNAL_EVENT_TYPES,
  type JournalEvent,
  JournalEventSchema,
  normalizeBlockReplaced,
  QuarantinedEvent,
  RunAllocatedEvent,
  readRunAllocatedGrants,
} from '../src/contracts/campaign/journal-events.ts';
import {
  BLOCK_REPLACEMENT_REASONS,
  INSTRUMENT_CAUSES,
} from '../src/contracts/campaign/typed-failures.ts';

test('the closed InstrumentCause set is the ten pinned causes (D1 six + four additions)', () => {
  expect([...INSTRUMENT_CAUSES]).toEqual([
    'grader_billing_exhausted',
    'grader_rate_limited',
    'subject_spawn_failed',
    'subject_crashed',
    'capture_failed',
    'checks_crashed',
    'grader_crashed',
    'grader_misconfigured',
    'setup_failed',
    'subject_rate_limited',
  ]);
});

test('BlockReplacementReason is the closed block-scoped set (E7.2)', () => {
  expect([...BLOCK_REPLACEMENT_REASONS]).toEqual([
    ...INSTRUMENT_CAUSES,
    'dispatcher_restart',
    'snapshot_drift',
    'storage_failure',
    'skew_refill',
    'exposure_audit',
    'contention',
  ]);
});

test('quarantined is the 21st event: strict, binding-only payload', () => {
  expect(JOURNAL_EVENT_TYPES).toHaveLength(21);
  expect(JOURNAL_EVENT_TYPES).toContain('quarantined');
  const parsed = QuarantinedEvent.parse({
    seq: 1,
    ts_ms: 2,
    type: 'quarantined',
    payload: { run_id: 'r1', attempt_id: 'a1', reason: 'attempt_mismatch' },
  });
  expect(parsed.payload.reason).toBe('attempt_mismatch');
  expect(() =>
    QuarantinedEvent.parse({
      seq: 1,
      ts_ms: 2,
      type: 'quarantined',
      payload: { run_id: 'r1', reason: 'bogus' },
    }),
  ).toThrow();
  // attempt_id is optional; no state-machine edge (binding-only like attempt_created).
  expect(
    QuarantinedEvent.parse({
      seq: 1,
      ts_ms: 2,
      type: 'quarantined',
      payload: { run_id: 'r1', reason: 'late_terminal' },
    }).payload.attempt_id,
  ).toBeUndefined();
});

test('widened block_replaced: fresh rows carry reason/kind/reserve_activation/roster', () => {
  // A REPLACEMENT row carries the supersedes pairs — same-arm only, never
  // cross-arm; a rerun row (fixture below at the routing tests) is reserve-
  // and count-neutral and carries NO supersedes (E7.2).
  const fresh = BlockReplacedEvent.parse({
    seq: 3,
    ts_ms: 4,
    type: 'block_replaced',
    payload: {
      block_id: 'b1',
      replacement_block_id: 'c1:scn:x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
      ],
    },
  });
  const rec = normalizeBlockReplaced(fresh.payload);
  expect(rec).toEqual({
    block_id: 'b1',
    replacement_block_id: 'c1:scn:x1',
    reason: 'grader_crashed',
    kind: 'replacement',
    reserve_activation: true,
    roster: [
      { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
      { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
    ],
  });
});

test('widened block_replaced: legacy rows round-trip (E7.2 legacy rule)', () => {
  const legacy = BlockReplacedEvent.parse({
    seq: 3,
    ts_ms: 4,
    type: 'block_replaced',
    payload: {
      block_id: 'b1',
      replacement_block_id: 'b2',
      cause: 'grader_rate_limited',
    },
  });
  expect(normalizeBlockReplaced(legacy.payload)).toEqual({
    block_id: 'b1',
    replacement_block_id: 'b2',
    reason: 'grader_rate_limited',
    kind: 'replacement',
    reserve_activation: true,
    roster: [],
  });
  // An out-of-vocabulary cause still rejects.
  expect(() =>
    BlockReplacedEvent.parse({
      seq: 3,
      ts_ms: 4,
      type: 'block_replaced',
      payload: { block_id: 'b', replacement_block_id: 'c', cause: 'bogus' },
    }),
  ).toThrow();
});

test('run_allocated: the new arm requires key_grants and forbids key_env', () => {
  // RunAllocatedEvent.parse types .payload as the two-arm union exactly —
  // no cast needed to feed readRunAllocatedGrants.
  const fresh = RunAllocatedEvent.parse({
    seq: 1,
    ts_ms: 2,
    type: 'run_allocated',
    payload: {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 42,
      key_grants: [
        { role: 'subject', env: 'ANTHROPIC_API_KEY' },
        { role: 'grader', env: 'GRADER_KEY' },
      ],
    },
  });
  expect(readRunAllocatedGrants(fresh.payload)).toEqual([
    { role: 'subject', env: 'ANTHROPIC_API_KEY' },
    { role: 'grader', env: 'GRADER_KEY' },
  ]);
  // key_env forbidden on the new arm; duplicate role rejects; 3 entries reject.
  expect(() =>
    JournalEventSchema.parse({
      seq: 1,
      ts_ms: 2,
      type: 'run_allocated',
      payload: {
        attempt_id: 'a1',
        run_id: 'r1',
        pgid: 42,
        key_grants: [{ role: 'subject', env: 'K' }],
        key_env: 'OTHER',
      },
    }),
  ).toThrow();
  expect(() =>
    JournalEventSchema.parse({
      seq: 1,
      ts_ms: 2,
      type: 'run_allocated',
      payload: {
        attempt_id: 'a1',
        run_id: 'r1',
        pgid: 42,
        key_grants: [
          { role: 'subject', env: 'K1' },
          { role: 'subject', env: 'K2' },
        ],
      },
    }),
  ).toThrow();
});

test('run_allocated: legacy arm parses unchanged (key_env only / neither)', () => {
  const legacy = RunAllocatedEvent.parse({
    seq: 1,
    ts_ms: 2,
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 7, key_env: 'K' },
  });
  expect(readRunAllocatedGrants(legacy.payload)).toEqual([
    { role: 'subject', env: 'K' },
  ]);
  const neither = RunAllocatedEvent.parse({
    seq: 1,
    ts_ms: 2,
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 7 },
  });
  expect(readRunAllocatedGrants(neither.payload)).toEqual([]);
  const grantsEmpty = RunAllocatedEvent.parse({
    seq: 1,
    ts_ms: 2,
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 7, key_grants: [] },
  });
  expect(readRunAllocatedGrants(grantsEmpty.payload)).toEqual([]);
});

test('block_admitted gains additive rerun_of', () => {
  const row: JournalEvent = {
    seq: 1,
    ts_ms: 2,
    type: 'block_admitted',
    payload: { block_id: 'b:i1', pools: ['p'], rerun_of: 'b' },
  };
  expect(JournalEventSchema.parse(row)).toEqual(row);
});
/** Parses a block_replaced row (envelope + payload) for refinement tests. */
const parseReplaced = (payload: Record<string, unknown>) =>
  BlockReplacedEvent.parse({
    seq: 3,
    ts_ms: 4,
    type: 'block_replaced',
    payload,
  });

test('block_replaced E7.1/E7.2/E7.3a refinements reject at the schema (C5)', () => {
  const replaced = parseReplaced;
  // A valid rerun row: same samples, reserve-neutral, no supersedes.
  expect(
    normalizeBlockReplaced(
      replaced({
        block_id: 'b1',
        replacement_block_id: 'b1:i2',
        reason: 'dispatcher_restart',
        kind: 'rerun',
        reserve_activation: false,
        roster: [
          { sample_id: 's1', arm: 'base' },
          { sample_id: 's2', arm: 'treat' },
        ],
      }).payload,
    ),
  ).toEqual({
    block_id: 'b1',
    replacement_block_id: 'b1:i2',
    reason: 'dispatcher_restart',
    kind: 'rerun',
    reserve_activation: false,
    roster: [
      { sample_id: 's1', arm: 'base' },
      { sample_id: 's2', arm: 'treat' },
    ],
  });
  // rerun must be reserve-neutral and carry no supersedes.
  expect(() =>
    replaced({
      block_id: 'b1',
      replacement_block_id: 'b1:i2',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: true,
      roster: [{ sample_id: 's1', arm: 'base' }],
    }),
  ).toThrow();
  expect(() =>
    replaced({
      block_id: 'b1',
      replacement_block_id: 'b1:i2',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [{ sample_id: 's1', arm: 'base', supersedes: 's0' }],
    }),
  ).toThrow();
  // replacement must activate a reserve and pair every entry (total pairing).
  expect(() =>
    replaced({
      block_id: 'b1',
      replacement_block_id: 'c1:scn:x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: false,
      roster: [{ sample_id: 'x1s1', arm: 'base', supersedes: 's1' }],
    }),
  ).toThrow();
  expect(() =>
    replaced({
      block_id: 'b1',
      replacement_block_id: 'c1:scn:x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [{ sample_id: 'x1s1', arm: 'base' }],
    }),
  ).toThrow();
  // Graph-structural rules within one roster: successor one-to-one,
  // predecessor uniqueness, no intra-roster cycles.
  expect(() =>
    replaced({
      block_id: 'b1',
      replacement_block_id: 'c1:scn:x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s1', arm: 'base', supersedes: 's2' },
      ],
    }),
  ).toThrow();
  expect(() =>
    replaced({
      block_id: 'b1',
      replacement_block_id: 'c1:scn:x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s2', arm: 'treat', supersedes: 's1' },
      ],
    }),
  ).toThrow();
  expect(() =>
    replaced({
      block_id: 'b1',
      replacement_block_id: 'c1:scn:x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 'x1s2' },
        { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
      ],
    }),
  ).toThrow();
  // E7.2: validity-replacement reasons are never rerun kind.
  expect(() =>
    replaced({
      block_id: 'b1',
      replacement_block_id: 'b1:i2',
      reason: 'contention',
      kind: 'rerun',
      reserve_activation: false,
      roster: [{ sample_id: 's1', arm: 'base' }],
    }),
  ).toThrow();
  expect(
    () =>
      replaced({
        block_id: 'b1',
        replacement_block_id: 'c1:scn:x1',
        reason: 'contention',
        kind: 'replacement',
        reserve_activation: true,
        roster: [{ sample_id: 'x1s1', arm: 'base', supersedes: 's1' }],
      }).payload,
  ).toBeDefined();
});

test('reason/kind partition: all 16 reasons pin exactly one kind (R-DSP-5 + R-RCV-2)', () => {
  // Replacement consumes the per-cell reserve: every InstrumentCause plus
  // skew_refill, exposure_audit, contention (R-DSP-5). Rerun re-enters
  // killed/aborted blocks: dispatcher_restart, snapshot_drift,
  // storage_failure only (R-RCV-2).
  const rerunReasons = [
    'dispatcher_restart',
    'snapshot_drift',
    'storage_failure',
  ];
  for (const reason of BLOCK_REPLACEMENT_REASONS) {
    const expectedKind = rerunReasons.includes(reason)
      ? 'rerun'
      : 'replacement';
    const otherKind: 'replacement' | 'rerun' =
      expectedKind === 'rerun' ? 'replacement' : 'rerun';
    // Fully kind-consistent payloads, so reason×kind is the only dimension
    // under test.
    const byKind = {
      rerun: {
        block_id: 'b1',
        replacement_block_id: 'b1:i2',
        reason,
        kind: 'rerun' as const,
        reserve_activation: false,
        roster: [{ sample_id: 's1', arm: 'base' }],
      },
      replacement: {
        block_id: 'b1',
        replacement_block_id: 'c1:scn:x1',
        reason,
        kind: 'replacement' as const,
        reserve_activation: true,
        roster: [{ sample_id: 'x1s1', arm: 'base', supersedes: 's1' }],
      },
    };
    expect(() => parseReplaced(byKind[expectedKind])).not.toThrow();
    expect(() => parseReplaced(byKind[otherKind])).toThrow();
  }
});

test('block_replaced rejects self-cycles: block_id === replacement_block_id (E7.1)', () => {
  expect(() =>
    parseReplaced({
      block_id: 'b1',
      replacement_block_id: 'b1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [{ sample_id: 'x1s1', arm: 'base', supersedes: 's1' }],
    }),
  ).toThrow();
  expect(() =>
    parseReplaced({
      block_id: 'b1',
      replacement_block_id: 'b1',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [{ sample_id: 's1', arm: 'base' }],
    }),
  ).toThrow();
  // The legacy arm carries the same locally-detectable invalidity.
  expect(() =>
    BlockReplacedEvent.parse({
      seq: 3,
      ts_ms: 4,
      type: 'block_replaced',
      payload: {
        block_id: 'b1',
        replacement_block_id: 'b1',
        cause: 'grader_rate_limited',
      },
    }),
  ).toThrow();
});

test('block_replaced rosters hold one sample per arm (E7.1)', () => {
  expect(() =>
    parseReplaced({
      block_id: 'b1',
      replacement_block_id: 'c1:scn:x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s2', arm: 'base', supersedes: 's2' },
      ],
    }),
  ).toThrow();
  expect(() =>
    parseReplaced({
      block_id: 'b1',
      replacement_block_id: 'b1:i2',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [
        { sample_id: 's1', arm: 'base' },
        { sample_id: 's2', arm: 'base' },
      ],
    }),
  ).toThrow();
});
