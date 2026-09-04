// The campaign journal (kernel D3, R-JRN-1..12): SQLite at
// <campaignDir>/journal.db, one writer elected via the journal.lease.d lock
// (Task 2) plus in-transaction writer_generation fencing — a deposed-but-
// alive writer's next append fails loudly. One transaction per event
// (fsync per event): BEGIN IMMEDIATE -> fencing check -> INSERT + projection
// updates -> COMMIT. PRAGMAs pinned on every writer connection. Payloads are
// JCS-canonical JSON of the D1 payload objects; envelopes validate against
// the D1 schemas before append (unknown type / malformed payload = loud
// programming error, never a silent drop).
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Campaign } from '../contracts/campaign/campaign.ts';
import type { CampaignUniverse } from '../contracts/campaign/crash-windows.ts';
import { jcsCanonicalize } from '../contracts/campaign/digest.ts';
import type {
  BlockReplacedRecord,
  BlockRosterEntry,
} from '../contracts/campaign/journal-events.ts';
import {
  type JournalEvent,
  JournalEventSchema,
  type JournalEventType,
  normalizeBlockReplaced,
  readRunAllocatedGrants,
} from '../contracts/campaign/journal-events.ts';
import {
  applyCampaignEvent,
  applySampleEvent,
  beginSealing,
  type CampaignState,
  type JournalEventInput,
  type SampleState,
} from '../contracts/campaign/state-machine.ts';
import type { Clock } from '../scheduler/clock.ts';
import { clockNowMs } from './host-stats.ts';
import {
  acquireLease,
  type LeaseHandle,
  type ProcessIdentityProbe,
} from './locks.ts';

export const JOURNAL_SCHEMA_VERSION = 1;
export const JOURNAL_DB_FILENAME = 'journal.db';
export const JOURNAL_LEASE_DIR = 'journal.lease.d';
export const DEFAULT_BALLAST_BYTES = 8 * 1024 * 1024;

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}
export class WriterDeposedError extends JournalError {
  constructor(message: string) {
    super(message);
    this.name = 'WriterDeposedError';
  }
}
export class JournalCorruptionError extends JournalError {
  constructor(message: string) {
    super(message);
    this.name = 'JournalCorruptionError';
  }
}
export class WriterPoisonedError extends JournalError {
  constructor(message: string) {
    super(message);
    this.name = 'WriterPoisonedError';
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks(
  block_id TEXT PRIMARY KEY,
  comparison_id TEXT NOT NULL,
  state TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT 'primary',
  instance_of TEXT,
  mint_seq INTEGER,
  reserve_activation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS block_rosters(
  block_id TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  arm TEXT NOT NULL,
  supersedes TEXT,
  PRIMARY KEY(block_id, sample_id)
);
CREATE TABLE IF NOT EXISTS attempts(
  attempt_id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  state TEXT NOT NULL,
  run_id TEXT,
  pgid INTEGER,
  key_grants TEXT,
  spawn_gap_ms INTEGER,
  UNIQUE(run_id)
);
CREATE TABLE IF NOT EXISTS pools(pool_key TEXT PRIMARY KEY, blocked_until_ms INTEGER);
CREATE TABLE IF NOT EXISTS spend(
  seq INTEGER PRIMARY KEY REFERENCES events(seq),
  kind TEXT NOT NULL,
  amount_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS amendments(
  seq INTEGER PRIMARY KEY REFERENCES events(seq),
  amount_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS adjudications(
  seq INTEGER PRIMARY KEY REFERENCES events(seq),
  cell TEXT NOT NULL,
  disposition TEXT NOT NULL,
  rationale TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quarantine(
  run_id TEXT PRIMARY KEY,
  attempt_id TEXT,
  reason TEXT NOT NULL,
  detail TEXT
);
`;

/** The materialized (rebuildable, Decision D-7) projection tables with their
 *  primary-key ordering — one source for the rebuild wipe and the
 *  deterministic snapshot dump. Internal constant names, never user input. */
const PROJECTION_TABLES = [
  ['blocks', 'block_id'],
  ['block_rosters', 'block_id, sample_id'],
  ['attempts', 'attempt_id'],
  ['pools', 'pool_key'],
  ['spend', 'seq'],
  ['amendments', 'seq'],
  ['adjudications', 'seq'],
  ['quarantine', 'run_id'],
] as const;

function writerPragmas(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 0');
}

export function initJournalDb(campaignDir: string): void {
  mkdirSync(campaignDir, { recursive: true });
  const dbPath = join(campaignDir, JOURNAL_DB_FILENAME);
  const db = new Database(dbPath, { create: true });
  try {
    // NO pragmas before the gate: journal_mode = WAL is PERSISTENT — on an
    // existing database the schema_version is proven BEFORE any persistent
    // mutation, so a refused foreign journal keeps its file byte-identical
    // (reading sqlite_master and meta needs no pragma at all).
    const tables = db
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((table) => table.name);
    if (names.includes('meta')) {
      checkSchemaVersion(db);
    } else if (names.length > 0) {
      throw new JournalError(
        `${dbPath} holds tables (${names.join(', ')}) but no meta.schema_version — foreign database, refusing to touch it; inspect the campaign directory by hand before initializing`,
      );
    }
    writerPragmas(db); // ours (or table-free): persistent WAL from here on
    db.exec(SCHEMA_SQL);
    db.exec('BEGIN IMMEDIATE');
    db.query('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(
      'schema_version',
      String(JOURNAL_SCHEMA_VERSION),
    );
    db.query('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(
      'writer_generation',
      '0',
    );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

function checkSchemaVersion(db: Database): void {
  const row = db
    .query('SELECT value FROM meta WHERE key = ?')
    .get('schema_version') as { value: string } | null;
  if (row === null || row.value !== String(JOURNAL_SCHEMA_VERSION)) {
    throw new JournalError(
      `journal schema_version ${row === null ? '<missing>' : row.value} != ${JOURNAL_SCHEMA_VERSION} — refusing to open (fail-closed); this journal belongs to another schema generation: open it with the tooling that wrote it, or move the campaign directory aside before initializing a new one`,
    );
  }
}

export interface EventInput {
  readonly type: JournalEventType;
  readonly payload: unknown;
  readonly ts_ms?: number;
}

export interface ElectWriterArgs {
  readonly campaignDir: string;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  /** The frozen campaign document: membership for block fan-out and
   *  attempt->block resolution. Absent only during registration's
   *  publication phase (campaign.json does not exist yet). */
  readonly campaign?: Campaign;
  /** Sealer mode (R-JRN-3): only the listed event types may append. */
  readonly restrict?: readonly JournalEventType[];
}

/** The materialized attempts row (matches the attempts DDL exactly). */
export interface AttemptRow {
  readonly attempt_id: string;
  readonly sample_id: string;
  readonly block_id: string;
  readonly state: string;
  readonly run_id: string | null;
  readonly pgid: number | null;
  readonly key_grants: string | null;
  readonly spawn_gap_ms: number | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function postSealEventClaim(eventType: JournalEventType, seq?: number): string {
  return `post-seal event ${eventType}${seq === undefined ? '' : ` (seq ${seq})`} rejected — campaign is sealed`;
}

/** E7.2 legacy same-arm pairing (ONE implementation for the writer's
 *  incremental fold and for replay, so derived rosters can never diverge):
 *  the successor's OWN samples form the roster, each superseding the
 *  predecessor sample of the same arm; the pairing must be total in both
 *  directions (one sample per arm per cell). `armSource` names the
 *  membership authority in failures; `fail` builds the caller's error type
 *  (JournalError on append, JournalCorruptionError on replay). */
function pairSameArmRoster(args: {
  readonly predecessorBlockId: string;
  readonly successorBlockId: string;
  readonly successorSampleIds: readonly string[];
  readonly predecessorSampleIds: readonly string[];
  readonly armOf: (sampleId: string) => string | undefined;
  readonly armSource: string;
  readonly fail: (message: string) => Error;
}): BlockRosterEntry[] {
  const predecessorByArm = new Map<string, string>();
  for (const sampleId of args.predecessorSampleIds) {
    const arm = args.armOf(sampleId);
    if (arm === undefined || arm === '') {
      throw args.fail(
        `predecessor sample ${sampleId} of block ${args.predecessorBlockId} has no arm in ${args.armSource} — cannot same-arm pair (E7.2)`,
      );
    }
    predecessorByArm.set(arm, sampleId);
  }
  const entries: BlockRosterEntry[] = [];
  for (const sampleId of args.successorSampleIds) {
    const arm = args.armOf(sampleId);
    if (arm === undefined || arm === '') {
      throw args.fail(
        `reserve sample ${sampleId} of block ${args.successorBlockId} has no arm in ${args.armSource} — cannot same-arm pair (E7.2)`,
      );
    }
    const supersedes = predecessorByArm.get(arm);
    if (supersedes === undefined) {
      throw args.fail(
        `same-arm pairing is not total: no sample of predecessor block ${args.predecessorBlockId} has arm ${arm} for reserve sample ${sampleId} — refusing (E7.2)`,
      );
    }
    entries.push({ sample_id: sampleId, arm, supersedes });
  }
  if (entries.length !== predecessorByArm.size) {
    throw args.fail(
      `same-arm pairing is not total: predecessor block ${args.predecessorBlockId} has an arm no reserve sample of ${args.successorBlockId} covers — refusing (E7.2)`,
    );
  }
  return entries;
}

export class JournalWriter {
  readonly generation: number;
  private readonly db: Database;
  private readonly lease: LeaseHandle;
  private readonly clock: Clock;
  private readonly restrict: readonly JournalEventType[] | undefined;
  private readonly campaign: Campaign | undefined;
  /** Incremental membership: universe blocks ∪ mint rosters (E7). */
  private readonly rosters = new Map<string, string[]>();
  private readonly attemptCreatedTs = new Map<string, number>();
  private readonly blockComparison = new Map<string, string>();
  private released = false;
  /** Set when a rebuild's reseed failed: in-memory membership is
   *  untrustworthy and every later mutation must refuse until
   *  release() + re-election. */
  private poison: string | undefined;

  private constructor(
    args: ElectWriterArgs,
    lease: LeaseHandle,
    generation: number,
  ) {
    this.clock = args.clock;
    this.restrict = args.restrict;
    this.campaign = args.campaign;
    this.lease = lease;
    this.generation = generation;
    this.db = new Database(join(args.campaignDir, JOURNAL_DB_FILENAME));
    // Version gate BEFORE any persistent PRAGMA — same R-JRN-2 rule as
    // initJournalDb: a refused foreign journal is never mutated on open.
    checkSchemaVersion(this.db);
    writerPragmas(this.db);
    // Seed in-memory membership exactly as a fresh election does (resumes).
    this.reseedMembership();
  }

  static elect(args: ElectWriterArgs): JournalWriter {
    const lease = acquireLease({
      lockPath: join(args.campaignDir, JOURNAL_LEASE_DIR),
      clock: args.clock,
      identity: args.identity,
      label: 'journal lease',
    });
    try {
      const db = new Database(join(args.campaignDir, JOURNAL_DB_FILENAME));
      let generation = 0;
      try {
        // Version gate BEFORE any persistent PRAGMA (R-JRN-2, as initJournalDb).
        checkSchemaVersion(db);
        writerPragmas(db);
        db.exec('BEGIN IMMEDIATE');
        const row = db
          .query('SELECT value FROM meta WHERE key = ?')
          .get('writer_generation') as {
          value: string;
        };
        generation = Number(row.value) + 1;
        db.query('UPDATE meta SET value = ? WHERE key = ?').run(
          String(generation),
          'writer_generation',
        );
        db.exec('COMMIT');
      } finally {
        db.close();
      }
      return new JournalWriter(args, lease, generation);
    } catch (err) {
      // The election failed after the lease was taken: never leak the lease
      // over a database we could not open (the same unconditional-release
      // rule release() follows).
      try {
        lease.release();
      } catch (leaseErr) {
        throw new JournalError(
          `journal writer election failed (${errorMessage(err)}) AND the lease failed to sever (${errorMessage(leaseErr)}) — inspect ${lease.lockPath} by hand`,
        );
      }
      throw err;
    }
  }

  appendEvent(input: EventInput): JournalEvent {
    const appended = this.appendEvents([input]);
    const first = appended[0];
    if (first === undefined)
      throw new JournalError(
        'appendEvents returned no event for a one-event append',
      );
    return first;
  }

  /** One dispatch critical section: each event keeps R-JRN-4's
   *  one-event transaction, appended in order, nothing interleaving. */
  appendEvents(inputs: readonly EventInput[]): JournalEvent[] {
    if (this.released) throw new JournalError('writer released');
    this.assertNotPoisoned();
    const out: JournalEvent[] = [];
    for (const input of inputs) {
      if (this.restrict !== undefined && !this.restrict.includes(input.type)) {
        throw new JournalError(
          `restricted writer (sealer) refused event type ${input.type} — only ${this.restrict.join(', ')} may append`,
        );
      }
      out.push(this.appendOne(input));
    }
    return out;
  }

  /** The in-transaction fence (R-LCK-1): every write transaction re-reads
   *  writer_generation FIRST; a mismatch means a successor was elected and
   *  this writer fails loudly instead of interleaving. Runs inside the open
   *  transaction; the caller's catch rolls back. */
  private assertFenced(): void {
    const row = this.db
      .query('SELECT value FROM meta WHERE key = ?')
      .get('writer_generation') as { value: string } | null;
    const current = row?.value;
    if (current === undefined || Number(current) !== this.generation) {
      throw new WriterDeposedError(
        `journal writer deposed: generation ${this.generation} != meta ${current ?? '<missing>'} — a newer writer holds the lease; refusing to interleave`,
      );
    }
  }

  private appendOne(input: EventInput): JournalEvent {
    const ts_ms = input.ts_ms ?? clockNowMs(this.clock);
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      // busy_timeout = 0 makes a contended BEGIN IMMEDIATE fail instantly.
      // A DEPOSED writer must read as deposed (R-LCK-1), never as a generic
      // lock error: re-check the generation on the committed snapshot — a
      // mismatch is deposition, a match is genuine contention for the
      // current writer and the raw busy error is the honest surface.
      this.assertFenced();
      throw err;
    }
    let envelope: JournalEvent;
    try {
      this.assertFenced();
      const sealed = this.db
        .query("SELECT 1 FROM events WHERE type = 'sealed' LIMIT 1")
        .get() as { '1': number } | null;
      if (sealed !== null) {
        throw new JournalError(postSealEventClaim(input.type));
      }
      const seqRow = this.db
        .query('SELECT COALESCE(MAX(seq), 0) AS seq FROM events')
        .get() as {
        seq: number;
      };
      const seq = seqRow.seq + 1;
      envelope = JournalEventSchema.parse({ seq, ts_ms, ...input });
      this.db
        .query(
          'INSERT INTO events(seq, ts_ms, type, payload) VALUES (?, ?, ?, ?)',
        )
        .run(seq, ts_ms, envelope.type, jcsCanonicalize(envelope.payload));
      this.project(envelope);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
    // Membership folds only after the event is durable — a fold failure can
    // never roll back a committed event, and the next writer's resume fold
    // rebuilds the same state from the events themselves.
    this.foldMembership(envelope);
    return envelope;
  }

  private foldMembership(event: JournalEvent): void {
    switch (event.type) {
      case 'block_replaced': {
        const roster = this.rosterEntriesFor(event);
        this.rosters.set(
          event.payload.replacement_block_id,
          roster.map((entry) => entry.sample_id),
        );
        const comparison = this.blockComparison.get(event.payload.block_id);
        if (comparison !== undefined) {
          this.blockComparison.set(
            event.payload.replacement_block_id,
            comparison,
          );
        }
        break;
      }
      case 'attempt_created':
        this.attemptCreatedTs.set(event.payload.attempt_id, event.ts_ms);
        break;
      default:
        break;
    }
  }

  /** The roster entries a mint carries: the event's explicit roster, or —
   *  for the E7.2 legacy arm (absent roster) — the derived frozen-reserve
   *  roster. One derivation for foldMembership and project, so in-memory
   *  membership and the block_rosters projection can never diverge. */
  private rosterEntriesFor(
    event: JournalEvent & { type: 'block_replaced' },
  ): BlockRosterEntry[] {
    const rec = normalizeBlockReplaced(event.payload);
    return rec.roster.length > 0
      ? [...rec.roster]
      : this.deriveLegacyRoster(rec);
  }

  /** E7.2 legacy round-trip + the kind-'replacement' membership rule: the
   *  successor is an unactivated frozen reserve block of the same cell; its
   *  OWN samples form the roster, each superseding the same-arm predecessor
   *  sample (the pairing is total — one sample per arm per cell). Membership
   *  derives from the registered campaign universe, never invented. */
  private deriveLegacyRoster(rec: BlockReplacedRecord): BlockRosterEntry[] {
    if (this.campaign === undefined) {
      throw new JournalError(
        `legacy block_replaced (predecessor ${rec.block_id}) cannot derive its roster without the frozen campaign document — re-elect the writer with campaign: the reserve block's membership is the authority`,
      );
    }
    const successor = this.campaign.blocks.find(
      (block) => block.block_id === rec.replacement_block_id,
    );
    if (successor === undefined || successor.slot !== 'reserve') {
      throw new JournalError(
        `replacement_block_id ${rec.replacement_block_id} is not a frozen reserve block of the campaign — refusing to invent membership; inspect the campaign document before minting`,
      );
    }
    const armBySample = new Map(
      this.campaign.samples.map((sample) => [sample.sample_id, sample.arm]),
    );
    return pairSameArmRoster({
      predecessorBlockId: rec.block_id,
      successorBlockId: successor.block_id,
      successorSampleIds: successor.sample_ids,
      predecessorSampleIds: this.rosters.get(rec.block_id) ?? [],
      armOf: (sampleId) => armBySample.get(sampleId),
      armSource: 'the campaign document',
      fail: (message) => new JournalError(message),
    });
  }

  /** Projection maintenance (mirrors replayEvents routing, Decision D-7).
   *  Runs INSIDE the append transaction. */
  private project(event: JournalEvent): void {
    const db = this.db;
    switch (event.type) {
      case 'block_admitted': {
        const comparison = this.blockComparison.get(event.payload.block_id);
        if (comparison === undefined) {
          throw new JournalError(
            `block_admitted names block ${event.payload.block_id} that no frozen or minted membership resolves — refusing to fabricate a comparison_id;${
              this.campaign === undefined
                ? ' this writer holds no campaign document (publication phase) — re-elect with campaign'
                : ' inspect the campaign document'
            }`,
          );
        }
        db.query(
          `INSERT INTO blocks(block_id, comparison_id, state, slot, instance_of, mint_seq, reserve_activation)
           VALUES (?, ?, 'admitted', 'primary', NULL, NULL, 0)
           ON CONFLICT(block_id) DO UPDATE SET state = 'admitted'`,
        ).run(event.payload.block_id, comparison);
        break;
      }
      case 'attempt_created': {
        const blockId = this.blockOfSample(event.payload.sample_id);
        if (blockId === undefined) {
          throw new JournalError(
            `attempt_created names sample ${event.payload.sample_id} that no frozen or minted roster resolves — refusing to fabricate a block_id;${
              this.campaign === undefined
                ? ' this writer holds no campaign document (publication phase) — re-elect with campaign'
                : ' inspect the campaign document'
            }`,
          );
        }
        db.query(
          `INSERT INTO attempts(attempt_id, sample_id, block_id, state)
           VALUES (?, ?, ?, 'created')`,
        ).run(event.payload.attempt_id, event.payload.sample_id, blockId);
        break;
      }
      case 'run_allocated': {
        const createdTs = this.attemptCreatedTs.get(event.payload.attempt_id);
        const spawnGap =
          createdTs === undefined ? null : event.ts_ms - createdTs;
        db.query(
          `UPDATE attempts SET state = 'allocated', run_id = ?, pgid = ?, key_grants = ?, spawn_gap_ms = ?
           WHERE attempt_id = ?`,
        ).run(
          event.payload.run_id,
          'pgid' in event.payload ? event.payload.pgid : null,
          JSON.stringify(readRunAllocatedGrants(event.payload)),
          spawnGap,
          event.payload.attempt_id,
        );
        break;
      }
      case 'exposure_started':
        this.setAttemptStateBySample(event.payload.sample_id, 'exposed');
        break;
      case 'run_completed':
        db.query(
          `UPDATE attempts SET state = 'completed' WHERE attempt_id = ?`,
        ).run(event.payload.attempt_id);
        break;
      case 'instrument_failure':
        db.query(
          `UPDATE attempts SET state = 'instrument_failed' WHERE attempt_id = ?`,
        ).run(event.payload.attempt_id);
        break;
      case 'sample_disposition':
        if (event.payload.disposition === 'excluded_block_replaced') {
          this.setAttemptStateBySample(
            event.payload.sample_id,
            'excluded_block_replaced',
          );
        }
        break;
      case 'slot_exhausted':
        this.setAttemptStateBySample(event.payload.sample_id, 'exhausted');
        break;
      case 'budget_stopped':
        for (const sampleId of event.payload.sample_ids) {
          this.setAttemptStateBySample(sampleId, 'budget_stopped');
        }
        break;
      case 'aborted':
        this.setBlockState(event.payload.block_id, 'aborted');
        break;
      case 'skew_excluded':
        this.setBlockState(event.payload.block_id, 'skew_excluded');
        break;
      case 'block_replaced': {
        const rec = normalizeBlockReplaced(event.payload);
        this.setBlockState(rec.block_id, 'replaced');
        const comparison = this.blockComparison.get(rec.block_id);
        if (comparison === undefined) {
          throw new JournalError(
            `block_replaced names predecessor ${rec.block_id} that no frozen or minted membership resolves — refusing to fabricate a comparison_id; inspect the campaign document before minting`,
          );
        }
        db.query(
          `INSERT INTO blocks(block_id, comparison_id, state, slot, instance_of, mint_seq, reserve_activation)
           VALUES (?, ?, 'minted', ?, ?, ?, ?)
           ON CONFLICT(block_id) DO UPDATE SET state = 'minted', mint_seq = excluded.mint_seq`,
        ).run(
          rec.replacement_block_id,
          comparison,
          rec.kind === 'replacement' ? 'reserve' : 'primary',
          rec.block_id,
          event.seq,
          rec.reserve_activation ? 1 : 0,
        );
        for (const entry of this.rosterEntriesFor(event)) {
          db.query(
            `INSERT OR REPLACE INTO block_rosters(block_id, sample_id, arm, supersedes) VALUES (?, ?, ?, ?)`,
          ).run(
            rec.replacement_block_id,
            entry.sample_id,
            entry.arm,
            entry.supersedes ?? null,
          );
        }
        break;
      }
      case 'pool_blocked':
        db.query(
          `INSERT INTO pools(pool_key, blocked_until_ms) VALUES (?, ?)
           ON CONFLICT(pool_key) DO UPDATE SET blocked_until_ms = excluded.blocked_until_ms`,
        ).run(event.payload.pool_key, event.payload.until_ts_ms);
        break;
      case 'budget_event':
        db.query(
          'INSERT INTO spend(seq, kind, amount_usd) VALUES (?, ?, ?)',
        ).run(event.seq, event.payload.kind, event.payload.amount_usd);
        break;
      case 'amendment':
        db.query('INSERT INTO amendments(seq, amount_usd) VALUES (?, ?)').run(
          event.seq,
          event.payload.amount_usd,
        );
        break;
      case 'adjudication':
        db.query(
          'INSERT INTO adjudications(seq, cell, disposition, rationale) VALUES (?, ?, ?, ?)',
        ).run(
          event.seq,
          event.payload.cell,
          event.payload.disposition,
          event.payload.rationale,
        );
        break;
      case 'quarantined':
        db.query(
          'INSERT OR REPLACE INTO quarantine(run_id, attempt_id, reason) VALUES (?, ?, ?)',
        ).run(
          event.payload.run_id,
          event.payload.attempt_id ?? null,
          event.payload.reason,
        );
        break;
      case 'campaign_opened':
      case 'campaign_cancelled':
      case 'storage_paused':
      case 'sealed':
        break; // campaign-scoped: state-machine carries them; no projection
      default:
        throw new JournalError(
          `no projection for event type ${(event as JournalEvent).type}`,
        );
    }
  }

  /** Reset the in-memory membership maps for a rebuild: rosters from the
   *  frozen universe (mints re-fold from events, E7), attempt clocks empty
   *  (attempt_created events re-fold), comparison ids re-seeded from the
   *  campaign document — the one projection datum the universe does not
   *  carry. */
  private resetMembership(universe: CampaignUniverse): void {
    this.rosters.clear();
    this.attemptCreatedTs.clear();
    this.blockComparison.clear();
    for (const block of universe.blocks) {
      this.rosters.set(block.block_id, [...block.sample_ids]);
    }
    if (this.campaign !== undefined) {
      for (const block of this.campaign.blocks) {
        this.blockComparison.set(block.block_id, block.comparison_id);
      }
    }
  }

  /** R-JRN-10 / D-7: materialized tables are rebuildable by drop + replay.
   *  One fenced transaction: DELETE every projection row, reset in-memory
   *  membership from the universe, then re-project + re-fold every event in
   *  seq order through the same pair the incremental append path runs — so
   *  rebuilt tables are byte-identical to incrementally maintained ones. */
  rebuildProjectionsFrom(universe: CampaignUniverse): void {
    if (this.released) throw new JournalError('writer released');
    this.assertNotPoisoned();
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      // Same rule as appendOne: a busy BEGIN must read as deposition for a
      // deposed writer, never as a generic lock error.
      this.assertFenced();
      throw err;
    }
    try {
      this.assertFenced();
      for (const [table] of PROJECTION_TABLES) {
        this.db.query(`DELETE FROM ${table}`).run();
      }
      this.resetMembership(universe);
      for (const event of this.readEvents()) {
        this.project(event);
        this.foldMembership(event);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      // The rollback restored the tables; restore the in-memory maps the
      // same way a fresh election builds them (campaign seed + fold of the
      // unchanged events), so a caller that catches the error can never
      // keep appending against membership inconsistent with the tables.
      try {
        this.reseedMembership();
      } catch (reseedErr) {
        // The maps are UNTRUSTWORTHY now: poison the writer — every later
        // mutation refuses; the only recovery is release() + re-election.
        this.poison = `journal writer poisoned: rebuild failed (${errorMessage(err)}) and the membership reseed failed too (${errorMessage(reseedErr)}) — in-memory state is untrustworthy; the only recovery is release() followed by re-electing a writer`;
        throw new WriterPoisonedError(this.poison);
      }
      throw err;
    }
  }

  /** Seed in-memory membership exactly as a fresh election does: frozen
   *  campaign blocks first, then fold every journaled event in seq order —
   *  the events are the truth. Used at construction (resumes) and to
   *  restore in-memory state after a failed rebuild. */
  private reseedMembership(): void {
    this.rosters.clear();
    this.attemptCreatedTs.clear();
    this.blockComparison.clear();
    if (this.campaign !== undefined) {
      for (const block of this.campaign.blocks) {
        this.rosters.set(block.block_id, [...block.sample_ids]);
        this.blockComparison.set(block.block_id, block.comparison_id);
      }
    }
    for (const event of this.readEvents()) {
      this.foldMembership(event);
    }
  }

  /** The poison gate: a writer whose rebuild reseed failed keeps its
   *  in-memory membership untrustworthy forever — refuse every mutation
   *  with the typed error naming the recovery. Reads stay available for
   *  diagnosis. */
  private assertNotPoisoned(): void {
    if (this.poison !== undefined) throw new WriterPoisonedError(this.poison);
  }

  /** Deterministic dump of every projection table (rebuild-verification
   *  surface): `table=JSON(rows ordered by primary key)` lines joined by
   *  newlines. Reads only. */
  snapshotTables(): string {
    return PROJECTION_TABLES.map(([table, pk]) => {
      const rows = this.db.query(`SELECT * FROM ${table} ORDER BY ${pk}`).all();
      return `${table}=${JSON.stringify(rows)}`;
    }).join('\n');
  }

  /** Resolve a sample to its LIVE block: frozen membership is unique (each
   *  sample belongs to exactly one campaign block), and a mint appends its
   *  successor roster AFTER the predecessor's entry — so newest-first
   *  iteration makes the replacement instance, not the block it superseded,
   *  the resolution for post-mint attempts (E7 re-entry lives on the
   *  successor). */
  private blockOfSample(sampleId: string): string | undefined {
    for (const [blockId, roster] of [...this.rosters.entries()].reverse()) {
      if (roster.includes(sampleId)) return blockId;
    }
    return undefined;
  }

  private setBlockState(blockId: string, state: string): void {
    this.db
      .query('UPDATE blocks SET state = ? WHERE block_id = ?')
      .run(state, blockId);
  }

  private setAttemptStateBySample(sampleId: string, state: string): void {
    this.db
      .query(
        `UPDATE attempts SET state = ? WHERE attempt_id = (
           SELECT attempt_id FROM attempts WHERE sample_id = ? ORDER BY rowid DESC LIMIT 1)`,
      )
      .run(state, sampleId);
  }

  /** R-JRN-4 diagnostic surface: the live writer connection's PRAGMA state.
   *  synchronous and busy_timeout are per-connection — no other connection
   *  can observe the pin, so this is the only honest probe. */
  pragmaState(): {
    journal_mode: string;
    synchronous: number;
    busy_timeout: number;
  } {
    const mode = this.db.query('PRAGMA journal_mode').get() as {
      journal_mode: string;
    } | null;
    const sync = this.db.query('PRAGMA synchronous').get() as {
      synchronous: number;
    } | null;
    const busy = this.db.query('PRAGMA busy_timeout').get() as {
      timeout: number;
    } | null;
    return {
      journal_mode: mode?.journal_mode ?? '',
      synchronous: sync?.synchronous ?? -1,
      busy_timeout: busy?.timeout ?? -1,
    };
  }

  readEvents(afterSeq = 0): JournalEvent[] {
    const rows = this.db
      .query(
        'SELECT seq, ts_ms, type, payload FROM events WHERE seq > ? ORDER BY seq',
      )
      .all(afterSeq) as Array<{
      seq: number;
      ts_ms: number;
      type: string;
      payload: string;
    }>;
    return rows.map((row) =>
      JournalEventSchema.parse({
        seq: row.seq,
        ts_ms: row.ts_ms,
        type: row.type,
        payload: JSON.parse(row.payload),
      }),
    );
  }

  readAttempt(attemptId: string): AttemptRow {
    const row = this.db
      .query('SELECT * FROM attempts WHERE attempt_id = ?')
      .get(attemptId);
    if (row === null) throw new JournalError(`unknown attempt ${attemptId}`);
    // DB-boundary cast to the concrete row shape (bun:sqlite returns
    // unknown); the attempts DDL above pins these exact columns.
    return row as AttemptRow;
  }

  /** E7.7: position = Σ spend + latest estimate_inflight (0 before the first
   *  estimate). Deterministic over the event stream. */
  readBudgetPosition(): { spend_usd: number; estimate_inflight_usd: number } {
    const spend = (
      this.db
        .query(
          `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend WHERE kind = 'spend'`,
        )
        .get() as {
        total: number;
      }
    ).total;
    const latest = this.db
      .query(
        `SELECT amount_usd FROM spend WHERE kind = 'estimate_inflight' ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { amount_usd: number } | null;
    return { spend_usd: spend, estimate_inflight_usd: latest?.amount_usd ?? 0 };
  }

  checkpoint(): void {
    // A checkpoint that reports busy did NOT complete — frames remain in the
    // WAL. Treating that as success would be a silent failure, so the result
    // row is read and a non-zero busy is loud.
    const row = this.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
      busy: number;
    } | null;
    if (row === null || row.busy !== 0) {
      throw new JournalError(
        `wal_checkpoint(TRUNCATE) did not complete (busy=${row === null ? '?' : row.busy}) — a reader holds the WAL; close readers and checkpoint again`,
      );
    }
  }

  /** Test/crash-simulation helper: give up the LEASE ONLY — the writer does
   *  not learn it was deposed (no released flag, db stays open), so its next
   *  append must fail on the in-transaction generation FENCE, exactly like a
   *  deposed-but-alive writer whose lease a successor reclaimed. */
  abandonLease(): void {
    this.lease.release();
  }

  release(): void {
    const failures: string[] = [];
    if (!this.released) {
      // No further appends regardless of how teardown below goes.
      this.released = true;
      try {
        this.checkpoint(); // writers checkpoint at session end (Decision D-7)
      } catch (err) {
        failures.push(`wal checkpoint failed: ${errorMessage(err)}`);
      }
      try {
        this.db.close();
      } catch (err) {
        failures.push(`db close failed: ${errorMessage(err)}`);
      }
    }
    // The lease severs UNCONDITIONALLY (defect C8): a checkpoint or close
    // failure must never leak it. Severing stays retryable — re-calling
    // release() re-attempts only the lease; everything else is already torn
    // down.
    let leaseFailed = false;
    try {
      this.lease.release();
    } catch (err) {
      leaseFailed = true;
      failures.push(
        `lease release failed — call release() again to re-sever ${this.lease.lockPath}: ${errorMessage(err)}`,
      );
    }
    if (failures.length > 0) {
      throw new JournalError(
        `journal writer release failed (${failures.join('; ')})` +
          (leaseFailed
            ? ' — the lease may still be held'
            : ' — the lease WAS released; committed events replay from the WAL on the next open'),
      );
    }
  }
}

export function electWriter(args: ElectWriterArgs): JournalWriter {
  return JournalWriter.elect(args);
}

/** The read-only view (R-JRN-3: readers never write, never checkpoint, never
 *  take the lease — a live writer keeps its lease while status/cancel polls
 *  read). */
export function openJournalRead(campaignDir: string): {
  readEvents(afterSeq?: number): JournalEvent[];
  close(): void;
} {
  const db = new Database(join(campaignDir, JOURNAL_DB_FILENAME), {
    readonly: true,
  });
  // A refusal owns the handle it opened: schema validation runs after the
  // open, so a version mismatch must close the database before it throws or
  // every poll against a foreign journal strands a descriptor.
  try {
    checkSchemaVersion(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return {
    readEvents(afterSeq = 0): JournalEvent[] {
      const rows = db
        .query(
          'SELECT seq, ts_ms, type, payload FROM events WHERE seq > ? ORDER BY seq',
        )
        .all(afterSeq) as Array<{
        seq: number;
        ts_ms: number;
        type: string;
        payload: string;
      }>;
      return rows.map((row) =>
        JournalEventSchema.parse({
          seq: row.seq,
          ts_ms: row.ts_ms,
          type: row.type,
          payload: JSON.parse(row.payload),
        }),
      );
    },
    close(): void {
      db.close();
    },
  };
}

/** Replay's roster entry. zod infers optional fields as `T | undefined`;
 *  explicit-undefined compatibility keeps BlockRosterEntry rosters
 *  assignable (the crash-windows MintRosterEntry precedent). */
export interface ReplayRosterEntry {
  sample_id: string;
  arm: string;
  supersedes?: string | undefined;
}

export interface ReplayState {
  campaignState: CampaignState;
  readonly sampleStates: Map<string, SampleState>;
  readonly blockStates: Map<string, string>;
  readonly rosters: Map<string, ReplayRosterEntry[]>;
  readonly mintSeqBySuccessor: Map<string, number>;
  readonly supersededBlocks: Set<string>;
  readonly quarantine: Map<
    string,
    { run_id: string; attempt_id?: string; reason: string }
  >;
  readonly budget: { spend_usd: number; estimate_inflight_usd: number };
}

/** The standing tail of every replay corruption refusal: replay state is
 *  untrustworthy, so nothing may rebuild or resume over the journal until a
 *  human has audited it. */
const AUDIT =
  'quarantine the campaign directory for manual audit before any rebuild or resume';

/** The single constructor for replay corruption refusals (fail-closed
 *  constraint): every refusal states what the journal claims AND the
 *  operator's next step — a bare "corruption" with no recovery action never
 *  ships. */
function corrupt(claim: string, nextStep: string): JournalCorruptionError {
  return new JournalCorruptionError(
    `${claim} — journal corruption: ${nextStep}`,
  );
}

/** The pinned replay routing table (Decision D-7): a reject is corruption
 *  ONLY after correct routing. Sample-scoped -> applySampleEvent per named
 *  sample; block fan-out over universe blocks ∪ E7 mint rosters; block_
 *  replaced -> instance-chain + roster projections ONLY (never the sample
 *  reducer); campaign-scoped -> applyCampaignEvent; accounting ->
 *  projections only. quarantined -> quarantine projection only. */
export function replayEvents(
  universe: CampaignUniverse,
  events: readonly JournalEvent[],
): ReplayState {
  const sampleStates = new Map<string, SampleState>();
  const blockStates = new Map<string, string>();
  const rosters = new Map<string, ReplayRosterEntry[]>();
  const mintSeqBySuccessor = new Map<string, number>();
  const supersededBlocks = new Set<string>();
  const quarantine = new Map<
    string,
    { run_id: string; attempt_id?: string; reason: string }
  >();
  let campaignState: CampaignState = 'registered';
  let spend = 0;
  let estimate = 0;

  const attemptSample = new Map<string, string>(); // attempt_created bindings
  for (const block of universe.blocks) {
    const armBySample = new Map(
      universe.samples.map((s) => [s.sample_id, s.arm ?? '']),
    );
    rosters.set(
      block.block_id,
      block.sample_ids.map((sampleId) => ({
        sample_id: sampleId,
        arm: armBySample.get(sampleId) ?? '',
      })),
    );
  }
  // F1 membership gate: the sample IDs an event may name are exactly the
  // frozen universe's. An unknown sample is corruption — never a
  // fabricated 'planned' row the reducer could then legally advance.
  // The sample universe is FROZEN (E7.0): reserve blocks are pre-registered
  // with their own frozen samples and reruns reuse predecessor samples, so
  // a mint extends BLOCK membership (the rosters map), never the sample
  // set. Every event field that names a sample — primary targets AND
  // references (superseded_by, roster sample_id/supersedes) — is gated.
  const knownSamples = new Set<string>(
    universe.samples.map((sample) => sample.sample_id),
  );
  for (const roster of rosters.values()) {
    for (const entry of roster) knownSamples.add(entry.sample_id);
  }
  /** Reference gate: throws on a sample ID the frozen universe does not
   *  know; never plants state (`role` names the offending field). */
  const assertKnownSample = (
    event: JournalEvent,
    sampleId: string,
    role: string,
  ): void => {
    if (!knownSamples.has(sampleId)) {
      throw corrupt(
        `${event.type} (seq ${event.seq}) ${role} ${sampleId} that the frozen universe does not know`,
        `the frozen campaign document is the membership authority — inspect it, then ${AUDIT}`,
      );
    }
  };
  /** Mutation gate: reference check plus the lazy 'planned' default for a
   *  sample the reducer is about to advance. */
  const requireKnownSample = (event: JournalEvent, sampleId: string): void => {
    assertKnownSample(event, sampleId, 'names sample');
    if (!sampleStates.has(sampleId)) sampleStates.set(sampleId, 'planned');
  };
  const stateOf = (sampleId: string): SampleState =>
    sampleStates.get(sampleId) ?? 'planned';
  const membershipOf = (blockId: string): string[] =>
    (rosters.get(blockId) ?? []).map((entry) => entry.sample_id);
  /** Attempt-scoped events name an attempt; the sample rides the binding.
   *  An attempt never created in this stream is corruption (correct
   *  routing already happened). */
  const sampleOfAttempt = (event: JournalEvent, attemptId: string): string => {
    const sampleId = attemptSample.get(attemptId);
    if (sampleId === undefined) {
      throw corrupt(
        `${event.type} (seq ${event.seq}) names attempt ${attemptId} never bound by attempt_created`,
        `inspect the events table around this seq for the missing attempt_created, then ${AUDIT}`,
      );
    }
    return sampleId;
  };

  for (const [index, event] of events.entries()) {
    if (campaignState === 'sealed') {
      throw corrupt(
        postSealEventClaim(event.type, event.seq),
        `the sealed event is the journal terminus — inspect the post-seal suffix, then ${AUDIT}`,
      );
    }
    const input: JournalEventInput = {
      type: event.type,
      payload: event.payload,
    } as JournalEventInput;
    // R-JRN-11 derivation: activity events double as the campaign-state
    // signal (storage_paused -> running on the first activity; running stays
    // running). The SHIPPED campaign reducer owns the edge — no second
    // implementation here.
    if (
      (campaignState === 'storage_paused' || campaignState === 'running') &&
      (event.type === 'block_admitted' ||
        event.type === 'attempt_created' ||
        event.type === 'budget_event')
    ) {
      const derived = applyCampaignEvent(campaignState, event.type);
      if (derived.result === 'apply') campaignState = derived.next;
    }
    switch (event.type) {
      case 'attempt_created':
        requireKnownSample(event, event.payload.sample_id);
        attemptSample.set(event.payload.attempt_id, event.payload.sample_id);
        sampleStates.set(
          event.payload.sample_id,
          applyOrCorrupt(
            event,
            stateOf(event.payload.sample_id),
            event.payload.sample_id,
            input,
          ),
        );
        break;
      case 'run_allocated':
      case 'run_completed':
      case 'instrument_failure': {
        const sampleId = sampleOfAttempt(event, event.payload.attempt_id);
        sampleStates.set(
          sampleId,
          applyOrCorrupt(event, stateOf(sampleId), sampleId, input),
        );
        break;
      }
      case 'exposure_started':
      case 'sample_disposition':
      case 'slot_exhausted': {
        const sampleId = event.payload.sample_id;
        requireKnownSample(event, sampleId);
        if (
          event.type === 'sample_disposition' &&
          event.payload.disposition === 'excluded_block_replaced'
        ) {
          // superseded_by names the superseding SUCCESSOR sample — a
          // reference, validated but never planted.
          assertKnownSample(
            event,
            event.payload.superseded_by,
            'superseded_by names sample',
          );
        }
        sampleStates.set(
          sampleId,
          applyOrCorrupt(event, stateOf(sampleId), sampleId, input),
        );
        break;
      }
      case 'budget_stopped':
        for (const sampleId of event.payload.sample_ids) {
          requireKnownSample(event, sampleId);
          sampleStates.set(
            sampleId,
            applyOrCorrupt(event, stateOf(sampleId), sampleId, input),
          );
        }
        break;
      case 'block_admitted':
      case 'aborted':
      case 'skew_excluded': {
        const members = membershipOf(event.payload.block_id);
        if (members.length === 0) {
          throw corrupt(
            `${event.type} (seq ${event.seq}) names unknown block ${event.payload.block_id} — no frozen or minted membership`,
            `the frozen campaign document and prior block_replaced mints are the membership authority — inspect them, then ${AUDIT}`,
          );
        }
        for (const sampleId of members) {
          requireKnownSample(event, sampleId);
          const outcome = applySampleEvent(stateOf(sampleId), input);
          if (outcome.result === 'apply')
            sampleStates.set(sampleId, outcome.next);
          if (outcome.result === 'reject') {
            throw corrupt(
              `${event.type} (seq ${event.seq}) REJECT from ${sampleStates.get(sampleId)} for sample ${sampleId} — routed correctly, so the stream violates the pinned state machine`,
              `inspect this sample's event history around the seq, then ${AUDIT}`,
            );
          }
          // ignore-late: recorded-but-non-mutating (R-JRN-7)
        }
        blockStates.set(
          event.payload.block_id,
          event.type === 'block_admitted' ? 'admitted' : event.type,
        );
        break;
      }
      case 'block_replaced': {
        const rec = normalizeBlockReplaced(event.payload);
        supersededBlocks.add(rec.block_id);
        mintSeqBySuccessor.set(rec.replacement_block_id, event.seq);
        // E7.2 legacy round-trip (empty roster): the successor is an
        // unactivated FROZEN RESERVE block; its OWN samples form the
        // roster, each superseding the same-arm predecessor sample (total
        // pairing — one sample per arm per cell). Membership derives from
        // the registered universe, never carried over from the predecessor
        // — the same derivation the writer's incremental fold runs
        // (pairSameArmRoster).
        const roster =
          rec.roster.length > 0
            ? [...rec.roster]
            : deriveLegacyReplayRoster(universe, rosters, rec, event);
        // A mint extends BLOCK membership only — every sample the roster
        // names (successor sample_id AND supersedes reference) must already
        // be a frozen universe sample (E7.0); a ghost is corruption.
        for (const entry of roster) {
          assertKnownSample(event, entry.sample_id, 'roster names sample');
          if (entry.supersedes !== undefined) {
            assertKnownSample(
              event,
              entry.supersedes,
              'roster supersedes names sample',
            );
          }
        }
        rosters.set(rec.replacement_block_id, roster);
        blockStates.set(rec.block_id, 'replaced');
        blockStates.set(rec.replacement_block_id, 'minted');
        break; // NEVER fanned through applySampleEvent (Decision D-7)
      }
      case 'campaign_opened':
      case 'campaign_cancelled':
      case 'storage_paused': {
        const outcome = applyCampaignEvent(campaignState, event.type);
        if (outcome.result === 'reject') {
          throw corrupt(
            `campaign-scoped ${event.type} (seq ${event.seq}) rejected from ${campaignState}`,
            `inspect the campaign-scoped event order around this seq, then ${AUDIT}`,
          );
        }
        campaignState = outcome.next;
        break;
      }
      case 'sealed': {
        // C5: `sealing` is TRANSIENT — entered by predicate-guarded
        // beginSealing, never by an event — so a validly sealed journal holds
        // running -> sealing -> sealed with only `sealed` on disk. Replay
        // models the hop through the SHIPPED edges (no second
        // implementation): beginSealing over the strict pre-event prefix,
        // then sealing -> sealed. A reject means the journal witnesses a
        // seal that could not have happened.
        const begun = beginSealing(
          campaignState,
          universe,
          events.slice(0, index),
        );
        if (begun.result === 'reject') {
          throw corrupt(
            `sealed (seq ${event.seq}) cannot enter sealing from ${campaignState} — the seal predicate does not hold over the preceding events, so this journal records an impossible seal`,
            `inspect the campaign directory before trusting any derived state, then ${AUDIT}`,
          );
        }
        const outcome = applyCampaignEvent(begun.next, event.type);
        if (outcome.result === 'reject') {
          throw corrupt(
            `campaign-scoped ${event.type} (seq ${event.seq}) rejected from ${begun.next}`,
            `inspect the campaign-scoped event order around this seq, then ${AUDIT}`,
          );
        }
        campaignState = outcome.next;
        break;
      }
      case 'pool_blocked':
        break; // projections only (accounting class)
      case 'budget_event':
        if (event.payload.kind === 'spend') spend += event.payload.amount_usd;
        else estimate = event.payload.amount_usd; // absolute-total supersession (E7.7)
        break;
      case 'amendment':
      case 'adjudication':
        break; // projections only
      case 'quarantined':
        quarantine.set(event.payload.run_id, {
          run_id: event.payload.run_id,
          ...(event.payload.attempt_id !== undefined
            ? { attempt_id: event.payload.attempt_id }
            : {}),
          reason: event.payload.reason,
        });
        break;
      default:
        // The switch is statically exhaustive over JournalEvent (`event` is
        // never here); the widening cast keeps the runtime backstop for a
        // row a future vocabulary parses that this table does not route.
        throw corrupt(
          `unknown event type at seq ${(event as JournalEvent).seq}`,
          'this journal was written by a newer vocabulary than this routing table — open it with the tooling that wrote it',
        );
    }
  }

  return {
    campaignState,
    sampleStates,
    blockStates,
    rosters,
    mintSeqBySuccessor,
    supersededBlocks,
    quarantine,
    budget: { spend_usd: spend, estimate_inflight_usd: estimate },
  };
}

/** Replay's E7.2 legacy-arm derivation: resolve the successor as a frozen
 *  reserve block of the universe and same-arm pair against the predecessor's
 *  current roster. A legacy mint whose successor the universe does not know
 *  as a reserve block, or whose pairing is not total, is corruption (routed
 *  correctly — the event itself is unfulfillable). */
function deriveLegacyReplayRoster(
  universe: CampaignUniverse,
  rosters: ReadonlyMap<string, ReplayRosterEntry[]>,
  rec: BlockReplacedRecord,
  event: JournalEvent,
): BlockRosterEntry[] {
  const successor = universe.blocks.find(
    (block) => block.block_id === rec.replacement_block_id,
  );
  if (successor === undefined || successor.slot !== 'reserve') {
    throw corrupt(
      `block_replaced (seq ${event.seq}) legacy arm names successor ${rec.replacement_block_id} that is not a frozen reserve block of the universe`,
      `the frozen campaign document is the membership authority — inspect it, then ${AUDIT}`,
    );
  }
  const armBySample = new Map(
    universe.samples.map((sample) => [sample.sample_id, sample.arm]),
  );
  return pairSameArmRoster({
    predecessorBlockId: rec.block_id,
    successorBlockId: successor.block_id,
    successorSampleIds: successor.sample_ids,
    predecessorSampleIds: (rosters.get(rec.block_id) ?? []).map(
      (entry) => entry.sample_id,
    ),
    armOf: (sampleId) => armBySample.get(sampleId),
    armSource: 'the frozen universe',
    fail: (message) =>
      corrupt(
        `block_replaced (seq ${event.seq}): ${message}`,
        `the frozen campaign document is the membership authority — inspect it, then ${AUDIT}`,
      ),
  });
}

/** apply = advance; ignore-late = unchanged; reject after correct routing is
 *  corruption (R-JRN-7). Returns the state to store. */
function applyOrCorrupt(
  event: JournalEvent,
  state: SampleState,
  sampleId: string,
  input: JournalEventInput,
): SampleState {
  const outcome = applySampleEvent(state, input);
  if (outcome.result === 'reject') {
    throw corrupt(
      `${event.type} (seq ${event.seq}) REJECT from ${state} for sample ${sampleId} — routed correctly, so the stream violates the pinned state machine`,
      `inspect this sample's event history around the seq, then ${AUDIT}`,
    );
  }
  return outcome.result === 'apply' ? outcome.next : state;
}

export function rebuildMaterialized(
  writer: JournalWriter,
  universe: CampaignUniverse,
): void {
  writer.rebuildProjectionsFrom(universe); // DROPs projection tables, re-applies events via project()
}

/** The fs-operations seam the publication primitives run through (repo
 *  culture: seams carry the fiction, everything else hits the real fs).
 *  Domain-shaped operations, not raw POSIX, so a test recorder can observe
 *  the durable operation ORDER (ballast write -> fsync -> dir fsync ->
 *  stage write -> fsync -> rename LAST -> dir fsync) without mocking
 *  behavior away. Production always uses the real fs. */
export interface JournalFsOps {
  /** O_EXCL create: refuses if the path already exists. */
  openExclusive(path: string): number;
  /** Read-only open (file or directory). */
  openRead(path: string): number;
  close(fd: number): void;
  /** Bytes actually written — a short write must never be fsynced as
   *  success, so every caller loops until the whole buffer has landed. */
  write(fd: number, data: string | Buffer): number;
  fsync(fd: number): void;
  rename(from: string, to: string): void;
  /** Hard-link `from` onto `to`. Atomic AND EEXIST-respecting: unlike
   *  rename it refuses when `to` exists, so it publishes a fully-written
   *  file under a name that is exclusively created. */
  link(from: string, to: string): void;
  unlink(path: string): void;
  stat(path: string): { size: number; blocks: number };
  exists(path: string): boolean;
}

export const journalFsOps: JournalFsOps = {
  openExclusive: (path) => openSync(path, 'wx'),
  openRead: (path) => openSync(path, 'r'),
  close: closeSync,
  write: (fd, data) =>
    typeof data === 'string' ? writeSync(fd, data) : writeSync(fd, data),
  fsync: fsyncSync,
  rename: renameSync,
  link: linkSync,
  unlink: unlinkSync,
  stat: (path) => statSync(path),
  exists: existsSync,
};

/** Write every byte before anyone fsyncs: a partial write fsynced as success
 *  is a torn record presented as durable. Zero forward progress refuses
 *  rather than spinning (contention.ts's sidecar writer, same discipline).
 *
 *  The retry slices BYTES, not JS code units: a short write that lands
 *  mid-character would otherwise resume from the wrong offset and reach the
 *  expected byte count with corrupted content. */
function writeFull(
  fsOps: JournalFsOps,
  fd: number,
  data: string,
  path: string,
): void {
  const bytes = Buffer.from(data, 'utf8');
  let written = 0;
  while (written < bytes.length) {
    const n = fsOps.write(fd, bytes.subarray(written));
    if (!Number.isFinite(n) || n <= 0) {
      throw new JournalError(
        `short write on ${path} (${written} of ${bytes.length} bytes, no forward progress) — refusing to fsync a torn record`,
      );
    }
    written += n;
  }
}

/** Best-effort failure-path cleanup whose own failure is REPORTED, never
 * swallowed (no silent drops): null on success, the underlying error
 * message on failure so the refusal can carry it. */
function cleanupUnlink(fsOps: JournalFsOps, path: string): string | null {
  try {
    fsOps.unlink(path);
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

/** Decision D-13 ballast: physically allocated, operator-visible, created +
 *  fsynced BEFORE campaign.json publication. Non-sparse: open exclusively,
 *  write non-zero buffers through the entire length (never truncate-only),
 *  fsync the file, verify allocated blocks cover the length, then fsync the
 *  campaign directory. Failure or an unverifiable allocation refuses
 *  publication. */
export function createBallast(
  campaignDir: string,
  sizeBytes: number,
  fsOps: JournalFsOps = journalFsOps,
): void {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new JournalError(
      `ballast size must be a positive integer of bytes, got ${sizeBytes} — a zero/fractional reserve reserves nothing (Decision D-13 requires physically allocated bytes)`,
    );
  }
  const path = join(campaignDir, '.ballast');
  let fd: number;
  try {
    fd = fsOps.openExclusive(path); // O_EXCL: never overwrite an existing ballast
  } catch (err) {
    throw new JournalError(
      `ballast already exists or cannot be created at ${path}: ${errorMessage(err)} — verify the existing reserve (verifyBallast) instead of recreating, or clear the path and retry registration`,
    );
  }
  try {
    try {
      const chunk = Buffer.alloc(64 * 1024, 0xba); // non-zero
      let written = 0;
      while (written < sizeBytes) {
        const want = Math.min(chunk.length, sizeBytes - written);
        // A short write must never be fsynced as a full reserve.
        const n = fsOps.write(fd, chunk.subarray(0, want));
        if (!Number.isFinite(n) || n <= 0) {
          throw new JournalError(
            `short write on ${path} (${written} of ${sizeBytes} bytes, no forward progress) — refusing to fsync a partial reserve`,
          );
        }
        written += n;
      }
      fsOps.fsync(fd); // durable BEFORE the allocation check
    } finally {
      fsOps.close(fd);
    }
  } catch (err) {
    const cleanup = cleanupUnlink(fsOps, path);
    throw new JournalError(
      `ballast write/fsync failed at ${path}: ${errorMessage(err)}` +
        (cleanup
          ? `; removing the failed ballast also failed (${cleanup}) — delete ${path} by hand`
          : '') +
        ` — free space on the campaign volume, then retry registration (fail-closed: no ballast, no publication)`,
    );
  }
  if (!verifyBallast(campaignDir, sizeBytes, fsOps)) {
    const cleanup = cleanupUnlink(fsOps, path);
    throw new JournalError(
      `ballast allocation unverifiable at ${path} (sparse or short filesystem?) — refusing publication (fail-closed)` +
        (cleanup
          ? `; removing the invalid ballast also failed (${cleanup}) — delete ${path} by hand`
          : '') +
        `; free space on the campaign volume or use a qualified non-sparse filesystem, then retry registration`,
    );
  }
  try {
    fsyncDir(campaignDir, fsOps);
  } catch (err) {
    throw new JournalError(
      `ballast created and verified at ${path} but the directory fsync failed: ${errorMessage(err)} — fsync the campaign directory by hand, verify (verifyBallast), then publish`,
    );
  }
}

/** Zero (or anything non-positive / non-integral) is never a valid reserve
 *  size: a zero-byte file verifies nothing even though `size === 0` would
 *  trivially match, so the request itself refuses. */
export function verifyBallast(
  campaignDir: string,
  sizeBytes: number,
  fsOps: JournalFsOps = journalFsOps,
): boolean {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return false;
  try {
    const st = fsOps.stat(join(campaignDir, '.ballast'));
    return st.size === sizeBytes && st.blocks * 512 >= sizeBytes;
  } catch {
    return false;
  }
}

/** D-13 pause step 3: release the ballast (unlink, fsync dir) so the freed
 *  blocks land the pause evidence. Absence is loud (the reserve was already
 *  spent — recovery journals that note). */
export function releaseBallast(
  campaignDir: string,
  fsOps: JournalFsOps = journalFsOps,
): void {
  const path = join(campaignDir, '.ballast');
  if (!fsOps.exists(path)) {
    throw new JournalError(
      `no ballast to release at ${path} — the reserve was already spent; recovery must journal the accounting note (Decision D-13) instead of releasing again`,
    );
  }
  try {
    fsOps.unlink(path);
  } catch (err) {
    throw new JournalError(
      `cannot release the ballast at ${path}: ${errorMessage(err)} — clear the path (or remount the volume writable), then retry the pause; the pause evidence must land in the freed blocks`,
    );
  }
  try {
    fsyncDir(campaignDir, fsOps);
  } catch (err) {
    throw new JournalError(
      `ballast unlinked at ${path} but the directory fsync failed: ${errorMessage(err)} — fsync the campaign directory before writing pause evidence (D-13 step 3 is not durable yet)`,
    );
  }
}

/** Create a crash-consistency marker durably. The D-13 storage-paused marker
 *  and the D-12 cancel-request marker are each the ONLY durable record of a
 *  decision at the moment they are written, and every caller blesses
 *  whatever it finds at the final path — so the final NAME must be created
 *  atomically, exclusively, and only ever complete.
 *
 *  Stage into a unique name in the same directory (O_EXCL), write every byte
 *  (a short write is never fsynced as success), fsync the file, then publish
 *  with `link(2)`: it is atomic, it REFUSES with EEXIST when the final name
 *  already exists, and the bytes it publishes are already durable. Rename
 *  would be atomic but not exclusive — two concurrent cancels would let the
 *  second silently replace the first operator's reason. Finally fsync the
 *  directory and drop the temp.
 *
 *  Once the link lands the operation has SUCCEEDED: the record exists and is
 *  complete, so no failure path may ever unlink the final name. A failure
 *  BEFORE the link leaves no final name and at most an inert temp, which no
 *  caller reads.
 *
 *  EEXIST semantics are unchanged for callers: presence-is-the-record stays
 *  their arm to take, and what they bless is now always complete. */
export function createDurableMarker(
  path: string,
  body: string,
  fsOps: JournalFsOps = journalFsOps,
): void {
  const stage = `${path}.stage.${process.pid}.${randomBytes(4).toString('hex')}`;
  const fd = fsOps.openExclusive(stage);
  let published = false;
  try {
    try {
      writeFull(fsOps, fd, body, stage);
      fsOps.fsync(fd);
    } finally {
      fsOps.close(fd);
    }
    // The exclusive, atomic publication. EEXIST rides out to the caller
    // untouched — an existing marker is another writer's completed record.
    fsOps.link(stage, path);
    published = true;
    // The new directory entry is only durable once the directory is.
    fsyncDir(dirname(path), fsOps);
  } catch (err) {
    // The final name is NEVER removed here: either it was never created, or
    // the link succeeded and it is a complete record — someone's, possibly
    // another writer's.
    const tempFailure = fsOps.exists(stage)
      ? cleanupUnlink(fsOps, stage)
      : null;
    if (published) {
      throw new JournalError(
        `durable marker ${path} was published but its directory entry could not be fsynced (${errorMessage(err)}) — the marker itself is complete and has been left in place; re-run the operation to confirm it (the EEXIST arm will bless it)` +
          (tempFailure === null
            ? ''
            : `; removing the temp ${stage} also failed (${tempFailure})`),
      );
    }
    throw err instanceof Error && (err as { code?: string }).code === 'EEXIST'
      ? err // the caller's presence-is-the-record arm owns this
      : new JournalError(
          `durable marker ${path} could not be written (${errorMessage(err)}) — the final name was never created, so nothing reads a partial marker back as a durable record` +
            (tempFailure === null
              ? ''
              : `; removing the temp ${stage} also failed (${tempFailure}) — delete it by hand`),
        );
  }
  // Best effort: a leftover temp is inert debris, never a failure.
  cleanupUnlink(fsOps, stage);
}

/** D-13 step-1 detection predicate: a storage-full failure from either
 *  store — SQLITE_FULL from a bun:sqlite commit, or ENOSPC from an fs write
 *  (the sampler's sidecar append plausibly hits the full volume first).
 *  Matched by error `code` first, message shape as the fallback (bun:sqlite
 *  surfaces "database or disk is full"). Production callers: the
 *  dispatcher's appendCritical and its sampler onSampleError hook (task 8),
 *  both entering performStoragePause. */
export function isStorageFullError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = 'code' in err ? err.code : undefined;
  if (code === 'SQLITE_FULL' || code === 'ENOSPC') return true;
  const message = 'message' in err ? err.message : undefined;
  return (
    typeof message === 'string' &&
    /SQLITE_FULL|database or disk is full|ENOSPC/.test(message)
  );
}

export function fsyncDir(
  dir: string,
  fsOps: JournalFsOps = journalFsOps,
): void {
  const fd = fsOps.openRead(dir);
  try {
    fsOps.fsync(fd);
  } finally {
    fsOps.close(fd);
  }
}

/** Decision D-7 publication: stage campaign.json as campaign.json.stage.<pid>
 *  (fsync), rename into place LAST, fsync the campaign directory. The rename
 *  is the readiness marker — a crash before it leaves an explicitly
 *  incomplete, non-runnable directory (Decision D-6/S-8). */
export function stageAndPublishCampaignJson(
  campaignDir: string,
  campaign: unknown,
  expectedBallastBytes: number = DEFAULT_BALLAST_BYTES,
  fsOps: JournalFsOps = journalFsOps,
): void {
  if (fsOps.exists(join(campaignDir, 'campaign.json'))) {
    throw new JournalError(
      `campaign.json already published at ${campaignDir} — publication happens exactly once; re-entry verifies, never republishes`,
    );
  }
  if (!fsOps.exists(join(campaignDir, JOURNAL_DB_FILENAME))) {
    throw new JournalError(
      `no journal at ${join(campaignDir, JOURNAL_DB_FILENAME)} — the journal initializes at the final campaign path BEFORE publication (P-4/S-8); run initJournalDb, journal campaign_opened, then publish`,
    );
  }
  // Readiness is journal CONTENTS, not file existence (D-7 order): an empty
  // or corrupt journal.db must not publish. Reuse the reader path — its
  // checkSchemaVersion proves the schema_version row, then the committed
  // campaign_opened event proves the campaign actually opened.
  try {
    const reader = openJournalRead(campaignDir);
    try {
      const opened = reader
        .readEvents()
        .some((event) => event.type === 'campaign_opened');
      if (!opened) {
        throw new JournalError(
          `journal at ${join(campaignDir, JOURNAL_DB_FILENAME)} has no committed campaign_opened event — journal it (electWriter + appendEvent) before publishing; the readiness marker must not precede the campaign's own opening (P-4/S-8)`,
        );
      }
    } finally {
      reader.close();
    }
  } catch (err) {
    if (err instanceof JournalError) throw err;
    throw new JournalError(
      `journal at ${join(campaignDir, JOURNAL_DB_FILENAME)} is not readable as an initialized journal: ${errorMessage(err)} — re-initialize (initJournalDb) and journal campaign_opened before publishing; campaign.json was NOT published`,
    );
  }
  if (!Number.isInteger(expectedBallastBytes) || expectedBallastBytes <= 0) {
    throw new JournalError(
      `expectedBallastBytes must be a positive integer of bytes, got ${expectedBallastBytes} — zero is never a valid D-13 reserve; publish against the real reserve size`,
    );
  }
  if (!verifyBallast(campaignDir, expectedBallastBytes, fsOps)) {
    throw new JournalError(
      `ballast at ${join(campaignDir, '.ballast')} is absent, sparse, or not ${expectedBallastBytes} bytes — create the D-13 reserve with createBallast(campaignDir, ${expectedBallastBytes}) before publishing; publication without a physically allocated reserve is forbidden`,
    );
  }
  // Serialize BEFORE opening the stage file: an unrepresentable document
  // must refuse without leaving stage debris behind.
  let stringified: string | undefined;
  try {
    stringified = JSON.stringify(campaign, null, 2);
  } catch (err) {
    throw new JournalError(
      `campaign document is not JSON-serializable: ${errorMessage(err)} — fix the document at the publisher; nothing was staged`,
    );
  }
  if (typeof stringified !== 'string') {
    throw new JournalError(
      `campaign document is not JSON-serializable (${campaign === undefined ? 'undefined document' : `a ${typeof campaign}`}) — pass a JSON-representable document; nothing was staged`,
    );
  }
  const body = `${stringified}\n`;
  const stage = join(campaignDir, `campaign.json.stage.${process.pid}`);
  let fd: number;
  try {
    fd = fsOps.openExclusive(stage);
  } catch (err) {
    throw new JournalError(
      `cannot stage campaign.json at ${stage}: ${errorMessage(err)} — remove the stale stage file (a crashed publication attempt left it; campaign.json was NOT published) and retry`,
    );
  }
  try {
    try {
      writeFull(fsOps, fd, body, stage);
      fsOps.fsync(fd);
    } finally {
      fsOps.close(fd);
    }
  } catch (err) {
    const cleanup = cleanupUnlink(fsOps, stage);
    throw new JournalError(
      `staging campaign.json failed at ${stage}: ${errorMessage(err)}` +
        (cleanup
          ? `; removing the stage debris also failed (${cleanup}) — delete ${stage} by hand`
          : '') +
        ` — inspect the campaign volume, then retry registration; campaign.json was NOT published`,
    );
  }
  try {
    fsOps.rename(stage, join(campaignDir, 'campaign.json')); // rename last
  } catch (err) {
    const cleanup = cleanupUnlink(fsOps, stage);
    throw new JournalError(
      `publication rename failed at ${stage}: ${errorMessage(err)}` +
        (cleanup
          ? `; removing the stage debris also failed (${cleanup}) — delete ${stage} by hand`
          : '') +
        ` — inspect the campaign volume, then retry; campaign.json was NOT published`,
    );
  }
  try {
    fsyncDir(campaignDir, fsOps); // directory fsync after the publication rename
  } catch (err) {
    throw new JournalError(
      `campaign.json was renamed into place at ${campaignDir} but the directory fsync failed: ${errorMessage(err)} — fsync the campaign directory by hand; the publication is not durable until then`,
    );
  }
}
