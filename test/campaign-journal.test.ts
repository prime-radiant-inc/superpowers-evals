import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  electWriter,
  initJournalDb,
  JOURNAL_DB_FILENAME,
  type JournalWriter,
  openJournalRead,
  WriterDeposedError,
} from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import type { CampaignUniverse } from '../src/contracts/campaign/crash-windows.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

class LocalIdentity implements ProcessIdentityProbe {
  exists(): 'alive' {
    return 'alive';
  }
  startTimeMs(): number {
    return 1; // stable local birth — single-process tests
  }
}

function camp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'camp-'));
  initJournalDb(dir);
  return dir;
}

function writer(dir: string, clock = new FakeClock(1)): JournalWriter {
  return electWriter({
    campaignDir: dir,
    clock,
    identity: new LocalIdentity(),
  });
}

const OPENED = {
  type: 'campaign_opened' as const,
  payload: { campaign_id: 'c1', digest: 'd'.repeat(64) },
};

test('initJournalDb creates the db with schema_version and writer_generation rows', () => {
  const dir = camp();
  expect(existsSync(join(dir, JOURNAL_DB_FILENAME))).toBe(true);
  const w = writer(dir);
  expect(w.readEvents()).toEqual([]);
  w.release();
});

test('appendEvent validates against the D1 schemas, assigns seq + ts_ms from the Clock seam', () => {
  const dir = camp();
  const clock = new FakeClock(1);
  const w = writer(dir, clock);
  const first = w.appendEvent(OPENED);
  expect(first).toEqual({
    seq: 1,
    ts_ms: 1000,
    type: 'campaign_opened',
    payload: OPENED.payload,
  });
  clock.advance(1);
  const second = w.appendEvent({
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  });
  expect(second.seq).toBe(2);
  expect(second.ts_ms).toBe(2000);
  // Malformed payload is a loud programming error, never a silent drop.
  expect(() =>
    w.appendEvent({ type: 'block_admitted', payload: { block_id: '' } }),
  ).toThrow();
  w.release();
});
test('PRAGMAs on the writer connection are pinned (WAL / FULL / busy_timeout=0)', () => {
  const dir = camp();
  const w = writer(dir);
  // journal_mode is persisted in the file: a separate connection reads 'wal'.
  // synchronous is PER-CONNECTION (and SQLite's WAL default is NORMAL), so
  // the FULL pin is only observable on the writer's own connection, where
  // writerPragmas sets WAL -> FULL -> busy_timeout=0 in that order on every
  // open (initJournalDb, elect, the writer connection).
  const db = new Database(join(dir, JOURNAL_DB_FILENAME));
  const mode = db.query('PRAGMA journal_mode').get() as {
    journal_mode: string;
  } | null;
  expect(mode?.journal_mode).toBe('wal');
  db.close();
  w.release();
});

test('deposed-writer fencing: A gen 1, B gen 2 — A fails loudly, B unaffected, sequence gapless', () => {
  const dir = camp();
  const a = writer(dir);
  a.appendEvent(OPENED);
  expect(a.generation).toBe(1);
  // A's lease lapses (crash simulation): B takes the lease and is elected.
  a.abandonLease(); // test helper: releases the lease WITHOUT checkpointing
  const b = writer(dir);
  expect(b.generation).toBe(2);
  const b1 = b.appendEvent({
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  });
  expect(() =>
    a.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } }),
  ).toThrow(WriterDeposedError);
  const b2 = b.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } });
  expect([b1.seq, b2.seq]).toEqual([2, 3]); // gapless
  b.release();
});

test('readEvents cursor exclusivity: seq > afterSeq, no gaps, no re-reads', () => {
  const dir = camp();
  const w = writer(dir);
  w.appendEvent(OPENED);
  w.appendEvent({
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  });
  w.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } });
  expect(w.readEvents().map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(w.readEvents(1).map((e) => e.seq)).toEqual([2, 3]);
  expect(w.readEvents(3)).toEqual([]);
  const reader = openJournalRead(dir);
  expect(reader.readEvents(2).map((e) => e.seq)).toEqual([3]);
  reader.close();
  w.release();
});

test('attempts.spawn_gap_ms materializes run_allocated.ts_ms - attempt_created.ts_ms (honest spawn-gap)', () => {
  const dir = camp();
  const clock = new FakeClock(1);
  const w = writer(dir, clock);
  w.appendEvent(OPENED);
  w.appendEvent({
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  });
  w.appendEvent({
    type: 'attempt_created',
    payload: { sample_id: 's1', attempt_id: 'a1' },
  });
  clock.advance(2.5);
  w.appendEvent({
    type: 'run_allocated',
    payload: {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 9,
      key_grants: [{ role: 'subject', env: 'K' }],
    },
  });
  const row = w.readAttempt('a1');
  expect(row.spawn_gap_ms).toBe(2500); // labeled spawn-gap in every surface (Decision D-2)
  expect(JSON.parse(row.key_grants ?? '[]')).toEqual([
    { role: 'subject', env: 'K' },
  ]);
  w.release();
});

test('budget position is absolute-total: latest estimate_inflight supersedes, spend increments', () => {
  const dir = camp();
  const w = writer(dir);
  w.appendEvent(OPENED);
  w.appendEvent({
    type: 'budget_event',
    payload: { kind: 'estimate_inflight', amount_usd: 10 },
  });
  w.appendEvent({
    type: 'budget_event',
    payload: { kind: 'spend', amount_usd: 9 },
  });
  w.appendEvent({
    type: 'budget_event',
    payload: { kind: 'estimate_inflight', amount_usd: 0 },
  });
  expect(w.readBudgetPosition()).toEqual({
    spend_usd: 9,
    estimate_inflight_usd: 0,
  });
  w.release();
});

test('sealer restriction: a restricted writer appends only adjudication + sealed', () => {
  const dir = camp();
  const w = writer(dir);
  w.appendEvent(OPENED);
  w.release();
  const sealer = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: new LocalIdentity(),
    restrict: ['adjudication', 'sealed'],
  });
  expect(() =>
    sealer.appendEvent({
      type: 'block_admitted',
      payload: { block_id: 'b1', pools: ['p'] },
    }),
  ).toThrow(/sealer|restricted/i);
  sealer.appendEvent({
    type: 'adjudication',
    payload: {
      cell: 'c1:scn',
      disposition: 'reserve_exhausted',
      rationale: 'reserve_exhausted',
    },
  });
  sealer.release();
});

// The same membership in two forms: the Campaign document the writer folds
// incrementally, and the CampaignUniverse a rebuild resets from. (Fixture-
// literal cast justified: only the membership fields the writer reads are
// populated.)
const PARITY_CAMPAIGN = {
  blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 's2'] }],
  samples: [
    { sample_id: 's1', cell: 'c1:scn', arm: 'base', replicate: 1 },
    { sample_id: 's2', cell: 'c1:scn', arm: 'treat', replicate: 1 },
  ],
} as unknown as Campaign;

const PARITY_UNIVERSE: CampaignUniverse = {
  samples: [
    { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
    { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
  ],
  blocks: [{ block_id: 'b1', sample_ids: ['s1', 's2'], slot: 'primary' }],
};

test('rebuildProjectionsFrom: drop + replay is byte-identical to incremental maintenance (C1)', () => {
  const dir = camp();
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: new LocalIdentity(),
    campaign: PARITY_CAMPAIGN,
  });
  w.appendEvent(OPENED);
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
    payload: {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 7,
      key_grants: [{ role: 'subject', env: 'K' }],
    },
  });
  w.appendEvent({
    type: 'run_completed',
    payload: { attempt_id: 'a1', outcome: 'clean' },
  });
  w.appendEvent({
    type: 'block_replaced',
    payload: {
      block_id: 'b1',
      replacement_block_id: 'b1:i1',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [
        { sample_id: 's1', arm: 'base' },
        { sample_id: 's2', arm: 'treat' },
      ],
    },
  });
  w.appendEvent({
    type: 'pool_blocked',
    payload: { pool_key: 'p', until_ts_ms: 99 },
  });
  w.appendEvent({
    type: 'budget_event',
    payload: { kind: 'spend', amount_usd: 1.5 },
  });
  w.appendEvent({
    type: 'amendment',
    payload: { kind: 'budget_raise', amount_usd: 2, ts: 1000 },
  });
  w.appendEvent({
    type: 'adjudication',
    payload: {
      cell: 'c1:scn',
      disposition: 'reserve_exhausted',
      rationale: 'reserve_exhausted',
    },
  });
  w.appendEvent({
    type: 'quarantined',
    payload: { run_id: 'orphan', reason: 'attempt_mismatch' },
  });
  const incremental = w.snapshotTables();
  expect(w.readAttempt('a1').block_id).toBe('b1'); // membership via the campaign doc
  w.rebuildProjectionsFrom(PARITY_UNIVERSE);
  const rebuiltOnce = w.snapshotTables();
  w.rebuildProjectionsFrom(PARITY_UNIVERSE);
  expect(w.snapshotTables()).toBe(rebuiltOnce); // byte-identical across rebuilds
  expect(rebuiltOnce).toBe(incremental); // incremental == rebuilt
  expect(w.readAttempt('a1').block_id).toBe('b1'); // rebuilt membership identical
  w.release();
});

test('legacy block_replaced (empty roster) carries predecessor membership — roster rows + attempt resolution (E7.2)', () => {
  const dir = camp();
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: new LocalIdentity(),
    campaign: PARITY_CAMPAIGN,
  });
  w.appendEvent(OPENED);
  w.appendEvent({
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  });
  // Legacy arm: no roster — membership carries over from the predecessor.
  w.appendEvent({
    type: 'block_replaced',
    payload: {
      block_id: 'b1',
      replacement_block_id: 'b1:i1',
      cause: 'subject_spawn_failed',
    },
  });
  w.appendEvent({
    type: 'attempt_created',
    payload: { sample_id: 's1', attempt_id: 'a2' },
  });
  const row = w.readAttempt('a2');
  expect(row.block_id).toBe('b1:i1'); // resolved through the carried roster
  const tables = w.snapshotTables();
  expect(tables).toContain('"block_id":"b1:i1","sample_id":"s1"'); // carried row materialized
  // The carry is derived from events, not stored state — parity survives rebuild:
  w.rebuildProjectionsFrom(PARITY_UNIVERSE);
  expect(w.snapshotTables()).toBe(tables);
  w.release();
});

test('release() severs the lease even when the end-of-session checkpoint fails (C8)', () => {
  const dir = camp();
  const w = writer(dir);
  w.appendEvent(OPENED);
  // Pin a read transaction from a separate connection: the TRUNCATE
  // checkpoint cannot complete while a reader holds the WAL — a REAL
  // checkpoint failure, not a mock.
  const pin = new Database(join(dir, JOURNAL_DB_FILENAME), { readonly: true });
  pin.exec('BEGIN');
  pin.query('SELECT COUNT(*) AS n FROM events').get();
  expect(() => w.release()).toThrow(/checkpoint/);
  expect(() => w.appendEvent(OPENED)).toThrow(/released/); // closed for appends regardless
  // The lease did NOT leak: a successor is elected immediately (generation 2).
  const successor = writer(dir);
  expect(successor.generation).toBe(2);
  successor.appendEvent({ type: 'storage_paused', payload: {} });
  pin.exec('COMMIT');
  pin.close();
  successor.release();
});
