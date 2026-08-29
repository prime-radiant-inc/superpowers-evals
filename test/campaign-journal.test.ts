import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  electWriter,
  initJournalDb,
  JOURNAL_DB_FILENAME,
  JournalError,
  type JournalWriter,
  openJournalRead,
  WriterDeposedError,
  WriterPoisonedError,
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

// Fixture-literal casts (only the membership fields the writer reads are
// populated): the default campaign gives b1 the s1/s2 membership the core
// tests append against; review F4 made membership-dependent appends refuse
// unknown references instead of fabricating empty strings.
const BASE_CAMPAIGN = {
  blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 's2'] }],
  samples: [
    { sample_id: 's1', cell: 'c1:scn', arm: 'base', replicate: 1 },
    { sample_id: 's2', cell: 'c1:scn', arm: 'treat', replicate: 1 },
  ],
} as unknown as Campaign;

function writer(dir: string, clock = new FakeClock(1)): JournalWriter {
  return electWriter({
    campaignDir: dir,
    clock,
    identity: new LocalIdentity(),
    campaign: BASE_CAMPAIGN,
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
  // Minor (review): durable assertions on the ACTUAL writer connection —
  // synchronous and busy_timeout are per-connection, so only the writer's
  // own connection can observe the pin.
  expect(w.pragmaState()).toEqual({
    journal_mode: 'wal',
    synchronous: 2,
    busy_timeout: 0,
  });
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

// Review F1: a realistic primary+reserve fixture — the legacy derivation
// resolves the FROZEN RESERVE block's own samples and pairs same-arm with
// the predecessor's samples (spec E7.2 + the kind-'replacement' membership
// rule: membership derives from the registered universe, never invented).
const RESERVE_CAMPAIGN = {
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
} as unknown as Campaign;

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

test('legacy block_replaced derives the frozen reserve block roster with same-arm supersedes (E7.2)', () => {
  const dir = camp();
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: new LocalIdentity(),
    campaign: RESERVE_CAMPAIGN,
  });
  w.appendEvent(OPENED);
  w.appendEvent({
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  });
  // Legacy arm: no roster/reserve_activation — the derivation must produce
  // the reserve block's own samples, each superseding the same-arm
  // predecessor sample (total pairing, one sample per arm per cell).
  w.appendEvent({
    type: 'block_replaced',
    payload: {
      block_id: 'b1',
      replacement_block_id: 'bres',
      cause: 'subject_spawn_failed',
    },
  });
  // The derived roster exactly — asserted, not sampled:
  const rostersLine = w
    .snapshotTables()
    .split('\n')
    .find((line) => line.startsWith('block_rosters='));
  expect(
    JSON.parse(rostersLine?.slice('block_rosters='.length) ?? '[]'),
  ).toEqual([
    { block_id: 'bres', sample_id: 's3', arm: 'base', supersedes: 's1' },
    { block_id: 'bres', sample_id: 's4', arm: 'treat', supersedes: 's2' },
  ]);
  // Successor membership is the reserve block's OWN samples: a post-mint
  // attempt resolves to the activated reserve; predecessor samples stay
  // resolved to their frozen home.
  w.appendEvent({
    type: 'attempt_created',
    payload: { sample_id: 's3', attempt_id: 'a2' },
  });
  expect(w.readAttempt('a2').block_id).toBe('bres');
  w.appendEvent({
    type: 'attempt_created',
    payload: { sample_id: 's1', attempt_id: 'a3' },
  });
  expect(w.readAttempt('a3').block_id).toBe('b1');
  // The derivation is a pure function of campaign + events — parity across
  // a drop + replay rebuild:
  const tables = w.snapshotTables();
  w.rebuildProjectionsFrom(RESERVE_UNIVERSE);
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

test('deposed writer under an active successor write-lock throws WriterDeposedError, current writer throws raw busy (R-LCK-1)', () => {
  const dir = camp();
  const a = writer(dir); // gen 1
  a.appendEvent(OPENED);
  a.abandonLease();
  const b = writer(dir); // gen 2 — the live writer
  // A third connection holds the WAL write lock (an in-flight successor
  // transaction): with busy_timeout = 0 every BEGIN IMMEDIATE is instantly
  // busy. The DEPOSED writer must read as deposed, never as a generic lock
  // error; the CURRENT writer's busy is genuine contention and stays raw.
  const holder = new Database(join(dir, JOURNAL_DB_FILENAME));
  holder.exec('BEGIN IMMEDIATE');
  try {
    expect(() =>
      a.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } }),
    ).toThrow(WriterDeposedError);
    expect(() =>
      b.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } }),
    ).toThrow(/database is locked|SQLITE_BUSY/i);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  // The lock is free again: B appends fine, A is still deposed on the fence.
  expect(
    b.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } }).seq,
  ).toBe(2);
  expect(() =>
    a.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } }),
  ).toThrow(WriterDeposedError);
  b.release();
});

test('initJournalDb refuses existing journals with a foreign schema_version or foreign tables (R-JRN-2)', () => {
  const dir = camp();
  const db = new Database(join(dir, JOURNAL_DB_FILENAME));
  db.query("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
  db.close();
  expect(() => initJournalDb(dir)).toThrow(/schema_version.*999/);
  // The refusal mutated nothing: the version row is still 999.
  const after = new Database(join(dir, JOURNAL_DB_FILENAME));
  const row = after
    .query('SELECT value FROM meta WHERE key = ?')
    .get('schema_version') as {
    value: string;
  };
  expect(row.value).toBe('999');
  after.close();
  // A foreign database (tables, no meta) is refused, never grafted onto.
  const foreignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  const foreign = new Database(join(foreignDir, JOURNAL_DB_FILENAME));
  foreign.exec('CREATE TABLE foreign_data(x)');
  foreign.close();
  expect(() => initJournalDb(foreignDir)).toThrow(/foreign|refus/i);
  // A healthy journal re-inits idempotently; a zero-byte crash shell repairs.
  expect(() => initJournalDb(camp())).not.toThrow();
  const crashDir = mkdtempSync(join(tmpdir(), 'camp-'));
  writeFileSync(join(crashDir, JOURNAL_DB_FILENAME), '');
  expect(() => initJournalDb(crashDir)).not.toThrow();
});

test('membership-dependent appends fail closed on unknown references — no fabricated rows (F4)', () => {
  const dir = camp();
  const w = writer(dir); // campaign fixture: b1 covers s1/s2
  w.appendEvent(OPENED);
  expect(() =>
    w.appendEvent({
      type: 'block_admitted',
      payload: { block_id: 'bX', pools: ['p'] },
    }),
  ).toThrow(/bX/);
  expect(() =>
    w.appendEvent({
      type: 'attempt_created',
      payload: { sample_id: 'ghost', attempt_id: 'aX' },
    }),
  ).toThrow(/ghost/);
  // Both refusals rolled back whole: no seq consumed, no rows fabricated.
  expect(w.readEvents().map((e) => e.seq)).toEqual([1]);
  w.release();
  // Without the campaign document the same appends refuse naming why.
  const bare = electWriter({
    campaignDir: camp(),
    clock: new FakeClock(1),
    identity: new LocalIdentity(),
  });
  expect(() =>
    bare.appendEvent({
      type: 'block_admitted',
      payload: { block_id: 'b1', pools: ['p'] },
    }),
  ).toThrow(/campaign/);
  bare.release();
});

test('a failed rebuild rolls back the tables AND restores in-memory membership (F5)', () => {
  const dir = camp();
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: new LocalIdentity(),
    campaign: RESERVE_CAMPAIGN,
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
  const before = w.snapshotTables();
  // A universe with NO membership: re-projection of attempt_created fails
  // mid-replay (F4's fail-closed refusal) — a real in-transaction failure.
  expect(() => w.rebuildProjectionsFrom({ samples: [], blocks: [] })).toThrow(
    JournalError,
  );
  expect(w.snapshotTables()).toBe(before); // tables restored by the rollback
  // The in-memory maps were restored too: the writer keeps appending with
  // membership consistent with the restored tables (a1 resolves again).
  const a2 = w.appendEvent({
    type: 'attempt_created',
    payload: { sample_id: 's1', attempt_id: 'a2' },
  });
  expect(w.readAttempt('a2').block_id).toBe('b1');
  expect(a2.seq).toBe(4);
  w.release();
});

test('initJournalDb refuses a foreign journal WITHOUT mutating it — journal_mode unchanged (R-JRN-2)', () => {
  const foreignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  const foreignPath = join(foreignDir, JOURNAL_DB_FILENAME);
  const foreign = new Database(foreignPath);
  foreign.exec('CREATE TABLE foreign_data(x)');
  foreign.close();
  expect(() => initJournalDb(foreignDir)).toThrow(/foreign/);
  const probe = new Database(foreignPath);
  const mode = probe.query('PRAGMA journal_mode').get() as {
    journal_mode: string;
  };
  expect(mode.journal_mode).toBe('delete'); // refusal left the file untouched
  probe.close();
  // A wrong-version journal authored by another schema generation (rollback
  // journal mode, meta row present): refused, still unmutated.
  const otherDir = mkdtempSync(join(tmpdir(), 'camp-'));
  const otherPath = join(otherDir, JOURNAL_DB_FILENAME);
  const other = new Database(otherPath);
  other.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  other.query("INSERT INTO meta VALUES ('schema_version', '999')").run();
  other.close();
  expect(() => initJournalDb(otherDir)).toThrow(/schema_version/);
  const probe2 = new Database(otherPath);
  const mode2 = probe2.query('PRAGMA journal_mode').get() as {
    journal_mode: string;
  };
  expect(mode2.journal_mode).toBe('delete');
  probe2.close();
});

test('a failed reseed poisons the writer — every later mutation throws WriterPoisonedError until re-election', () => {
  const dir = camp();
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: new LocalIdentity(),
    campaign: RESERVE_CAMPAIGN,
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
  // A real double failure is unreachable through the public surface — the
  // fold is deterministic over frozen inputs, so a reseed that fails now
  // would have failed construction. The injected throw stands in for the
  // I/O class of reseed failures; the poison machinery under test is real.
  (w as unknown as { reseedMembership(): void }).reseedMembership = () => {
    throw new Error('injected: reseed I/O failure');
  };
  // Rebuild fails for real (membership-less universe -> F4 refusal), the
  // reseed fails too -> the writer is poisoned, typed, naming re-election.
  expect(() => w.rebuildProjectionsFrom({ samples: [], blocks: [] })).toThrow(
    WriterPoisonedError,
  );
  expect(() => w.appendEvent({ type: 'storage_paused', payload: {} })).toThrow(
    WriterPoisonedError,
  );
  expect(() => w.rebuildProjectionsFrom(RESERVE_UNIVERSE)).toThrow(
    WriterPoisonedError,
  );
  // Reads stay available for diagnosis; release() is the recovery.
  expect(w.readEvents().length).toBe(3);
  w.release();
  const fresh = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: new LocalIdentity(),
    campaign: RESERVE_CAMPAIGN,
  });
  expect(fresh.appendEvent({ type: 'storage_paused', payload: {} }).seq).toBe(
    4,
  );
  fresh.release();
});

// The read-only view opens a SQLite handle BEFORE it validates the schema
// version. A refusal must not strand that handle: the process's open
// descriptors are the observable, counted through /dev/fd (the same set on
// Darwin and Linux).
function openDescriptorCount(): number {
  return readdirSync('/dev/fd').length;
}

test('openJournalRead closes its handle when schema validation refuses', () => {
  const dir = camp();
  new Database(join(dir, JOURNAL_DB_FILENAME))
    .query('UPDATE meta SET value = ? WHERE key = ?')
    .run('999', 'schema_version');
  // Warm-up refusal: the first open pays any one-off descriptor cost (lazy
  // module state), so the measured window sees only the handle under test.
  expect(() => openJournalRead(dir)).toThrow(JournalError);
  const before = openDescriptorCount();
  for (let i = 0; i < 8; i++) {
    expect(() => openJournalRead(dir)).toThrow(JournalError);
  }
  expect(openDescriptorCount()).toBe(before);
});
