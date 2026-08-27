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
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
    writerPragmas(db);
    // R-JRN-2 on EXISTING databases: prove the journal is ours before any
    // schema mutation. A version we cannot read refuses (checkSchemaVersion);
    // tables without a meta row are a foreign database, never grafted onto.
    // Only a table-free file (a fresh or crashed-mid-init shell) initializes.
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
    writerPragmas(this.db);
    checkSchemaVersion(this.db);
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
        writerPragmas(db);
        checkSchemaVersion(db);
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
    const predecessorByArm = new Map<string, string>();
    for (const sampleId of this.rosters.get(rec.block_id) ?? []) {
      const arm = armBySample.get(sampleId);
      if (arm === undefined) {
        throw new JournalError(
          `predecessor sample ${sampleId} of block ${rec.block_id} has no arm in the campaign document — cannot same-arm pair (E7.2)`,
        );
      }
      predecessorByArm.set(arm, sampleId);
    }
    const entries: BlockRosterEntry[] = [];
    for (const sampleId of successor.sample_ids) {
      const arm = armBySample.get(sampleId);
      if (arm === undefined) {
        throw new JournalError(
          `reserve sample ${sampleId} of block ${successor.block_id} has no arm in the campaign document — cannot same-arm pair (E7.2)`,
        );
      }
      const supersedes = predecessorByArm.get(arm);
      if (supersedes === undefined) {
        throw new JournalError(
          `same-arm pairing is not total: no sample of predecessor block ${rec.block_id} has arm ${arm} for reserve sample ${sampleId} — refusing (E7.2)`,
        );
      }
      entries.push({ sample_id: sampleId, arm, supersedes });
    }
    if (entries.length !== predecessorByArm.size) {
      throw new JournalError(
        `same-arm pairing is not total: predecessor block ${rec.block_id} has an arm no reserve sample of ${successor.block_id} covers — refusing (E7.2)`,
      );
    }
    return entries;
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
          event.payload.pgid,
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
        throw new JournalError(
          `rebuild failed (${errorMessage(err)}) and the membership reseed failed too (${errorMessage(reseedErr)}) — in-memory state is untrustworthy; release and re-elect a writer before further appends`,
        );
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
  checkSchemaVersion(db);
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
