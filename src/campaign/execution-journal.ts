import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readPinnedNoFollowFile } from '../appliance/credential-scope.ts';
import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import {
  type CampaignTransition,
  CampaignTransitionSchema,
} from '../contracts/campaign/execution.ts';
import {
  type Experiment,
  ExperimentSchema,
} from '../contracts/campaign/experiment.ts';
import { experimentDigest } from '../contracts/campaign/experiment-digest.ts';
import type { Clock } from '../scheduler/clock.ts';
import {
  type CampaignProjection,
  foldTransition,
  initialProjection,
} from './execution-state.ts';
import { fsyncDir, JOURNAL_DB_FILENAME, JOURNAL_LEASE_DIR } from './journal.ts';
import {
  acquireLease,
  type LeaseHandle,
  type ProcessIdentityProbe,
} from './locks.ts';

export interface CommittedTransition {
  sequence: number;
  transition: CampaignTransition;
  transition_digest: string;
  prefix_digest: string;
}
interface Row {
  sequence: number;
  body: string;
  transition_digest: string;
  prefix_digest: string;
}
const EMPTY_PREFIX = sha256Hex('');
function authenticatedExperiment(input: Experiment): Experiment {
  const experiment = ExperimentSchema.parse(input);
  if (experimentDigest(experiment) !== experiment.input_digest)
    throw new Error('experiment input digest mismatch');
  return experiment;
}
function checkSchema(db: Database, experiment?: Experiment): void {
  const row = db
    .query("SELECT value FROM execution_meta WHERE key = 'schema'")
    .get() as { value: string } | null;
  if (row?.value !== 'quorum.execution/v2')
    throw new Error('foreign execution journal schema');
  if (experiment) {
    const identity = db
      .query("SELECT value FROM execution_meta WHERE key = 'identity'")
      .get() as { value: string } | null;
    if (
      identity?.value !==
      jcsCanonicalize({
        campaign_id: experiment.campaign_id,
        input_digest: experiment.input_digest,
      })
    )
      throw new Error('execution journal experiment identity mismatch');
  }
}
function pragmas(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 0');
}
function assertDbFile(campaignDir: string): string {
  const path = join(campaignDir, JOURNAL_DB_FILENAME);
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error('execution journal must be a regular file');
  return path;
}
export function initExecutionJournal(args: {
  campaignDir: string;
  experiment: Experiment;
}): void {
  const experiment = authenticatedExperiment(args.experiment);
  mkdirSync(args.campaignDir, { recursive: true });
  const path = join(args.campaignDir, JOURNAL_DB_FILENAME);
  const existed = existsSync(path);
  if (existed) assertDbFile(args.campaignDir);
  const db = new Database(path, { create: !existed });
  try {
    if (existed) {
      checkSchema(db, experiment);
      return;
    }
    pragmas(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(
        'CREATE TABLE execution_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE execution_transitions (sequence INTEGER PRIMARY KEY, transition_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, transition_digest TEXT NOT NULL, prefix_digest TEXT NOT NULL)',
      );
      const insert = db.query('INSERT INTO execution_meta VALUES (?, ?)');
      insert.run('schema', 'quorum.execution/v2');
      insert.run(
        'identity',
        jcsCanonicalize({
          campaign_id: experiment.campaign_id,
          input_digest: experiment.input_digest,
        }),
      );
      insert.run('writer_generation', '0');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
  fsyncDir(args.campaignDir);
}
function replay(
  db: Database,
  experiment: Experiment,
): { projection: CampaignProjection; committed: CommittedTransition[] } {
  checkSchema(db, experiment);
  let projection = initialProjection(experiment);
  const committed: CommittedTransition[] = [];
  let prefix = EMPTY_PREFIX;
  for (const row of db
    .query(
      'SELECT sequence, body, transition_digest, prefix_digest FROM execution_transitions ORDER BY sequence',
    )
    .all() as Row[]) {
    const transition = CampaignTransitionSchema.parse(JSON.parse(row.body));
    const digest = sha256Hex(row.body);
    const sequence = committed.length + 1;
    prefix = sha256Hex(
      jcsCanonicalize({
        sequence,
        previous: prefix,
        transition_digest: digest,
      }),
    );
    if (
      row.sequence !== sequence ||
      jcsCanonicalize(transition) !== row.body ||
      digest !== row.transition_digest ||
      prefix !== row.prefix_digest
    )
      throw new Error('execution journal corrupt transition prefix');
    projection = foldTransition(projection, transition);
    committed.push({
      sequence,
      transition,
      transition_digest: digest,
      prefix_digest: prefix,
    });
  }
  return { projection, committed };
}
function read(campaignDir: string) {
  const raw = readPinnedNoFollowFile(
    campaignDir,
    ['campaign.json'],
    'experiment',
    true,
  );
  if (raw === null) throw new Error('experiment is missing');
  const experiment = authenticatedExperiment(JSON.parse(raw));
  const db = new Database(assertDbFile(campaignDir), { readonly: true });
  try {
    return replay(db, experiment);
  } finally {
    db.close();
  }
}
export function readProjection(campaignDir: string): CampaignProjection {
  return read(campaignDir).projection;
}
export function readCommittedTransitions(
  campaignDir: string,
): CommittedTransition[] {
  return read(campaignDir).committed;
}

export interface ElectExecutionWriterArgs {
  campaignDir: string;
  experiment: Experiment;
  clock: Clock;
  identity: ProcessIdentityProbe;
  /** SQLite connection seam; the default uses the real synchronous durable store. */
  connect?: (path: string) => Database;
}
export class ExecutionJournalWriter {
  private poison = false;
  private released = false;
  private readonly db: Database;
  private readonly lease: LeaseHandle;
  private readonly generation: number;
  private projection: CampaignProjection;
  private committed: CommittedTransition[];
  private constructor(
    db: Database,
    lease: LeaseHandle,
    generation: number,
    projection: CampaignProjection,
    committed: CommittedTransition[],
  ) {
    this.db = db;
    this.lease = lease;
    this.generation = generation;
    this.projection = projection;
    this.committed = committed;
  }
  static elect(args: ElectExecutionWriterArgs): ExecutionJournalWriter {
    const experiment = authenticatedExperiment(args.experiment);
    // Prove format before taking or modifying any journal ownership metadata.
    const path = assertDbFile(args.campaignDir);
    const inspect = new Database(path, { readonly: true });
    try {
      checkSchema(inspect, experiment);
    } finally {
      inspect.close();
    }
    const lease = acquireLease({
      lockPath: join(args.campaignDir, JOURNAL_LEASE_DIR),
      clock: args.clock,
      identity: args.identity,
      label: 'journal lease',
    });
    let db: Database | undefined;
    try {
      db = (args.connect ?? ((p) => new Database(p)))(path);
      checkSchema(db, experiment);
      pragmas(db);
      db.exec('BEGIN IMMEDIATE');
      const row = db
        .query(
          "SELECT value FROM execution_meta WHERE key = 'writer_generation'",
        )
        .get() as { value: string };
      const generation = Number(row.value) + 1;
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new Error('corrupt writer generation');
      db.query(
        "UPDATE execution_meta SET value = ? WHERE key = 'writer_generation'",
      ).run(String(generation));
      const state = replay(db, experiment);
      lease.heartbeat();
      db.exec('COMMIT');
      return new ExecutionJournalWriter(
        db,
        lease,
        generation,
        state.projection,
        state.committed,
      );
    } catch (error) {
      db?.close();
      lease.release();
      throw error;
    }
  }
  readProjection(): CampaignProjection {
    return structuredClone(this.projection);
  }
  commitTransition(input: CampaignTransition): CommittedTransition {
    if (this.released || this.poison)
      throw new Error('execution writer released or poisoned');
    const transition = CampaignTransitionSchema.parse(input);
    const body = jcsCanonicalize(transition);
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      began = true;
      this.lease.heartbeat();
      const row = this.db
        .query(
          "SELECT value FROM execution_meta WHERE key = 'writer_generation'",
        )
        .get() as { value: string } | null;
      if (Number(row?.value) !== this.generation)
        throw new Error('execution writer deposed');
      const next = foldTransition(this.projection, transition);
      const duplicate = this.committed.find(
        (entry) => entry.transition.transition_id === transition.transition_id,
      );
      if (duplicate) {
        this.db.exec('COMMIT');
        began = false;
        return structuredClone(duplicate);
      }
      const sequence = this.committed.length + 1;
      const transition_digest = sha256Hex(body);
      const prefix_digest = sha256Hex(
        jcsCanonicalize({
          sequence,
          previous: this.committed.at(-1)?.prefix_digest ?? EMPTY_PREFIX,
          transition_digest,
        }),
      );
      this.db
        .query('INSERT INTO execution_transitions VALUES (?, ?, ?, ?, ?)')
        .run(
          sequence,
          transition.transition_id,
          body,
          transition_digest,
          prefix_digest,
        );
      this.db.exec('COMMIT');
      began = false;
      const receipt = {
        sequence,
        transition,
        transition_digest,
        prefix_digest,
      };
      this.projection = next;
      this.committed.push(receipt);
      return structuredClone(receipt);
    } catch (error) {
      // An uncertain commit must never allow the cached projection to drive another write.
      this.poison = true;
      if (began) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* A completed COMMIT has no transaction left to roll back. */
        }
      }
      throw error;
    }
  }
  release(): void {
    if (this.released) return;
    try {
      this.db.close();
    } finally {
      this.lease.release();
      this.released = true;
    }
  }
}
