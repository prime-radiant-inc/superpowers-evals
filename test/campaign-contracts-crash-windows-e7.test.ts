import { expect, test } from 'bun:test';
import {
  type CampaignUniverse,
  resolveCrashWindows,
  sealPredicateHolds,
} from '../src/contracts/campaign/crash-windows.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';

// Frozen universe: one two-arm cell, one primary block b1 (samples s1/s2),
// one reserve block x1 (samples x1s1/x1s2), cell key k = c1:scn.
const UNIVERSE: CampaignUniverse = {
  samples: [
    { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
    { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
    { sample_id: 'x1s1', arm: 'base', cell: 'c1:scn' },
    { sample_id: 'x1s2', arm: 'treat', cell: 'c1:scn' },
  ],
  blocks: [
    { block_id: 'b1', sample_ids: ['s1', 's2'], slot: 'primary' },
    { block_id: 'x1', sample_ids: ['x1s1', 'x1s2'], slot: 'reserve' },
  ],
};

let SEQ = 0;
function ev<T extends JournalEvent['type']>(
  type: T,
  payload: unknown,
): JournalEvent {
  SEQ += 1;
  return { seq: SEQ, ts_ms: SEQ * 1000, type, payload } as JournalEvent;
}

function openAndAdmit(): JournalEvent[] {
  return [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
  ];
}

test('instance-complete seal: unactivated reserve imposes nothing; primaries must terminal', () => {
  const events = openAndAdmit();
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(false);
  // Terminal s1+s2 via attempts; reserve x1 stays unactivated.
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    ev('run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev('run_allocated', { attempt_id: 'a2', run_id: 'r2', pgid: 2 }),
    ev('run_completed', { attempt_id: 'a2', outcome: 'pass' }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(true);
});

test('replacement chain conservation: superseded predecessor resolves through the included superseder', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    ev('instrument_failure', { attempt_id: 'a1', cause: 'grader_crashed' }),
    // Mint: reserve x1 activates, roster supersedes s1/s2 (same-arm).
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
      ],
    }),
    // s2 was still admitted at mint time -> excluded_block_replaced.
    ev('sample_disposition', {
      sample_id: 's2',
      disposition: 'excluded_block_replaced',
      superseded_by: 'x1s2',
    }),
    ev('block_admitted', { block_id: 'x1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 'x1s1', attempt_id: 'xa1' }),
    ev('run_allocated', { attempt_id: 'xa1', run_id: 'xr1', pgid: 3 }),
    ev('run_completed', { attempt_id: 'xa1', outcome: 'pass' }),
    ev('attempt_created', { sample_id: 'x1s2', attempt_id: 'xa2' }),
    ev('run_allocated', { attempt_id: 'xa2', run_id: 'xr2', pgid: 4 }),
    ev('run_completed', { attempt_id: 'xa2', outcome: 'pass' }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(true);
});

test('an instrument_failure without its replacement/suppression/exhaustion carrier refuses seal (clause 3)', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    ev('instrument_failure', { attempt_id: 'a1', cause: 'grader_crashed' }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev('run_completed', { attempt_id: 'a2', outcome: 'pass' }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(false);
  // The reserve-exhaustion carrier discharges it as named shortfall.
  events.push(
    ev('adjudication', {
      cell: 'c1:scn',
      disposition: 'reserve_exhausted',
      rationale: 'reserve_exhausted',
    }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(true);
});

test('rerun successor-local witnesses: predecessor-era terminals never count', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    ev('run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev('run_allocated', { attempt_id: 'a2', run_id: 'r2', pgid: 2 }),
    ev('aborted', { block_id: 'b1' }), // fans out: s1 ignore-late, s2 aborted
    // Rerun mint reusing the SAME sample ids.
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'b1:i1',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [
        { sample_id: 's1', arm: 'base' },
        { sample_id: 's2', arm: 'treat' },
      ],
    }),
  );
  // Predecessor-era terminal for s1 must NOT discharge the successor.
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(false);
  events.push(
    ev('block_admitted', { block_id: 'b1:i1', pools: ['p'], rerun_of: 'b1' }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a3' }),
    ev('run_allocated', { attempt_id: 'a3', run_id: 'r3', pgid: 3 }),
    ev('run_completed', { attempt_id: 'a3', outcome: 'pass' }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a4' }),
    ev('run_allocated', { attempt_id: 'a4', run_id: 'r4', pgid: 4 }),
    ev('run_completed', { attempt_id: 'a4', outcome: 'pass' }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(true);
});

test('a minted-but-unadmitted successor refuses seal (zero witnesses)', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    ev('aborted', { block_id: 'b1' }),
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'b1:i1',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [
        { sample_id: 's1', arm: 'base' },
        { sample_id: 's2', arm: 'treat' },
      ],
    }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(false);
});

test('resolver override: a superseded predecessor gets no readmit/rerun action', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    // Mint supersedes b1 BEFORE the crash; a1 never terminaled.
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
      ],
    }),
  );
  const report = resolveCrashWindows(UNIVERSE, events);
  expect(report.attempts).toEqual([]); // suppressed — recovery completes the mint instead
});

test('resolver still emits kill_pgid_rerun_block for a post-run_allocated crash without a mint', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
  );
  const report = resolveCrashWindows(UNIVERSE, events);
  expect(report.attempts).toEqual([
    { attempt_id: 'a1', resolution: 'kill_pgid_rerun_block', pgid: 1 },
  ]);
});
