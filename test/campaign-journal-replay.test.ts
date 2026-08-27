import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  electWriter,
  initJournalDb,
  JournalCorruptionError,
  rebuildMaterialized,
  replayEvents,
} from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import type { CampaignUniverse } from '../src/contracts/campaign/crash-windows.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

const UNIVERSE: CampaignUniverse = {
  samples: [
    { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
    { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
  ],
  blocks: [{ block_id: 'b1', sample_ids: ['s1', 's2'], slot: 'primary' }],
};

let SEQ = 0;
function ev(type: JournalEvent['type'], payload: unknown): JournalEvent {
  SEQ += 1;
  return { seq: SEQ, ts_ms: SEQ * 1000, type, payload } as JournalEvent;
}

test('routing table: sample-scoped events apply per named sample; block_replaced never touches the sample reducer', () => {
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
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
  ];
  const state = replayEvents(UNIVERSE, events);
  expect(state.campaignState).toBe('running');
  expect(state.sampleStates.get('s1')).toBe('admitted'); // fan-out admitted it
  // The mint recorded the instance chain + roster without reducer calls:
  expect(state.rosters.get('b1:i1')).toEqual([
    { sample_id: 's1', arm: 'base' },
    { sample_id: 's2', arm: 'treat' },
  ]);
});

test('routing table: cross-machine rejects BY DESIGN are not corruption; misrouted garbage IS', () => {
  // pool_blocked is accounting-class: applying it to a sample would reject in
  // the reducer by design — replay routes it to projections only, no error.
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('pool_blocked', { pool_key: 'p', until_ts_ms: 9 }),
  ];
  expect(() => replayEvents(UNIVERSE, events)).not.toThrow();
  // Corruption: run_allocated naming an attempt that was never created.
  const corrupt = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('run_allocated', { attempt_id: 'ghost', run_id: 'r1', pgid: 1 }),
  ];
  expect(() => replayEvents(UNIVERSE, corrupt)).toThrow(JournalCorruptionError);
});

// The same membership as UNIVERSE in Campaign-document form: the writer's
// incremental projection resolves attempt->block through it exactly as the
// rebuild resolves through UNIVERSE. (Fixture-literal cast justified: only
// the membership fields the writer's fold reads are populated.)
const CAMPAIGN_DOC = {
  blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 's2'] }],
  samples: [
    { sample_id: 's1', cell: 'c1:scn', arm: 'base', replicate: 1 },
    { sample_id: 's2', cell: 'c1:scn', arm: 'treat', replicate: 1 },
  ],
} as unknown as import('../src/contracts/campaign/campaign.ts').Campaign;

test('replay determinism: rebuild materialized tables twice — byte-identical; incremental == rebuilt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'camp-'));
  initJournalDb(dir);
  const identity: ProcessIdentityProbe = {
    exists: () => 'alive',
    startTimeMs: () => 1,
  };
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity,
    campaign: CAMPAIGN_DOC,
  });
  w.appendEvent({
    type: 'campaign_opened',
    payload: { campaign_id: 'c', digest: 'd'.repeat(64) },
  });
  w.appendEvent({
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  });
  w.appendEvent({
    type: 'attempt_created',
    payload: { sample_id: 's1', attempt_id: 'a1' },
  });
  w.appendEvent({
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 5, key_grants: [] },
  });
  const incremental = w.snapshotTables(); // serialized dump of all projections
  rebuildMaterialized(w, UNIVERSE);
  const rebuiltOnce = w.snapshotTables();
  rebuildMaterialized(w, UNIVERSE);
  const rebuiltTwice = w.snapshotTables();
  expect(rebuiltOnce).toBe(rebuiltTwice); // byte-identical across rebuilds
  expect(rebuiltOnce).toBe(incremental); // incremental == rebuilt
  w.release();
});

test('storage-pause derivation: first activity after storage_paused resumes running (R-JRN-11)', () => {
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('storage_paused', {}),
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
  ];
  expect(replayEvents(UNIVERSE, events).campaignState).toBe('running');
});

test('quarantined is binding-only: projection row, no state change, never reject', () => {
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('quarantined', { run_id: 'orphan', reason: 'attempt_mismatch' }),
  ];
  const state = replayEvents(UNIVERSE, events);
  // (The brief's `attempt_id: undefined` literal split in two: the repo's
  // exactOptionalPropertyTypes rejects an explicit undefined for the
  // optional property; same assertion strength.)
  const record = state.quarantine.get('orphan');
  expect(record?.attempt_id).toBeUndefined();
  expect(record).toEqual({ run_id: 'orphan', reason: 'attempt_mismatch' });
});

// ————— C5: the transient sealing transition —————
// `sealing` is entered by predicate-guarded beginSealing, never by an event
// (state-machine.ts); the journal witnesses only `sealed`. Replay must model
// the running -> sealing -> sealed hop or every validly sealed journal
// replays as corruption.

test('a valid sealed journal replays through the transient sealing hop to sealed (C5)', () => {
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    // aborted fans out admitted -> aborted: every universe sample terminal,
    // so the seal predicate holds over the prefix.
    ev('aborted', { block_id: 'b1' }),
    ev('sealed', { report_digest: 'e'.repeat(64) }),
  ];
  const state = replayEvents(UNIVERSE, events);
  expect(state.campaignState).toBe('sealed');
});

test('sealed whose prefix fails the seal predicate is corruption — the journal witnesses an impossible seal (C5)', () => {
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    // No sample ever terminal: beginSealing could never have applied.
    ev('sealed', { report_digest: 'e'.repeat(64) }),
  ];
  expect(() => replayEvents(UNIVERSE, events)).toThrow(JournalCorruptionError);
});

test('sealed from a non-running campaign state is corruption — no transient hop exists (C5)', () => {
  const events = [
    // From registered: campaign_opened never happened.
    ev('sealed', { report_digest: 'e'.repeat(64) }),
  ];
  expect(() => replayEvents(UNIVERSE, events)).toThrow(JournalCorruptionError);
});

// ————— E7.2: legacy block_replaced replay derivation —————
// The successor of a legacy (roster-less) mint is an unactivated frozen
// reserve block: its OWN samples form the roster, each superseding the
// same-arm predecessor sample (total pairing — one sample per arm per
// cell). Predecessor carry-over would fabricate membership the registered
// universe contradicts.

const RESERVE_UNIVERSE: CampaignUniverse = {
  samples: [
    { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
    { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
    { sample_id: 's3', arm: 'base', cell: 'c1:scn' },
    { sample_id: 's4', arm: 'treat', cell: 'c1:scn' },
  ],
  blocks: [
    { block_id: 'b1', sample_ids: ['s1', 's2'], slot: 'primary' },
    { block_id: 'bres', sample_ids: ['s3', 's4'], slot: 'reserve' },
  ],
};

test('legacy block_replaced replays the frozen reserve roster with same-arm supersedes — never predecessor carry-over (E7.2)', () => {
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'bres',
      cause: 'subject_spawn_failed',
    }),
  ];
  const state = replayEvents(RESERVE_UNIVERSE, events);
  expect(state.rosters.get('bres')).toEqual([
    { sample_id: 's3', arm: 'base', supersedes: 's1' },
    { sample_id: 's4', arm: 'treat', supersedes: 's2' },
  ]);
  expect(state.supersededBlocks.has('b1')).toBe(true);
  expect(state.blockStates.get('bres')).toBe('minted');
});

test('legacy block_replaced naming a successor that is not a frozen reserve block is corruption (E7.2)', () => {
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'b1:i1', // not a universe block at all
      cause: 'subject_spawn_failed',
    }),
  ];
  expect(() => replayEvents(RESERVE_UNIVERSE, events)).toThrow(
    JournalCorruptionError,
  );
});

// The same membership in Campaign-document form for the writer-parity check.
const RESERVE_CAMPAIGN_DOC = {
  blocks: [
    { block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 's2'] },
    {
      block_id: 'bres',
      comparison_id: 'c1',
      sample_ids: ['s3', 's4'],
      slot: 'reserve',
    },
  ],
  samples: [
    { sample_id: 's1', cell: 'c1:scn', arm: 'base', replicate: 1 },
    { sample_id: 's2', cell: 'c1:scn', arm: 'treat', replicate: 1 },
    { sample_id: 's3', cell: 'c1:scn', arm: 'base', replicate: 2 },
    { sample_id: 's4', cell: 'c1:scn', arm: 'treat', replicate: 2 },
  ],
} as unknown as import('../src/contracts/campaign/campaign.ts').Campaign;

test('replay legacy-roster derivation matches the writer projection exactly (parity with 3a)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'camp-'));
  initJournalDb(dir);
  const identity: ProcessIdentityProbe = {
    exists: () => 'alive',
    startTimeMs: () => 1,
  };
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity,
    campaign: RESERVE_CAMPAIGN_DOC,
  });
  w.appendEvent({
    type: 'campaign_opened',
    payload: { campaign_id: 'c', digest: 'd'.repeat(64) },
  });
  w.appendEvent({
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  });
  w.appendEvent({
    type: 'block_replaced',
    payload: {
      block_id: 'b1',
      replacement_block_id: 'bres',
      cause: 'subject_spawn_failed',
    },
  });
  const state = replayEvents(RESERVE_UNIVERSE, w.readEvents());
  const rostersLine = w
    .snapshotTables()
    .split('\n')
    .find((line) => line.startsWith('block_rosters='));
  const projected = JSON.parse(
    rostersLine?.slice('block_rosters='.length) ?? '[]',
  ) as Array<{
    block_id: string;
    sample_id: string;
    arm: string;
    supersedes: string | null;
  }>;
  const projectedEntries: {
    sample_id: string;
    arm: string;
    supersedes?: string | undefined;
  }[] = projected
    .filter((row) => row.block_id === 'bres')
    .map(({ sample_id, arm, supersedes }) => ({
      sample_id,
      arm,
      ...(supersedes === null ? {} : { supersedes }),
    }));
  expect(projectedEntries).toEqual(state.rosters.get('bres') ?? []);
  w.release();
});
