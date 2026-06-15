import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { BatchHeader, ResultRecord } from '../contracts/batch.ts';
import { BatchHeaderSchema } from '../contracts/batch.ts';
import { hexNonce, nowStampUtc } from '../paths.ts';

// Batch index writers: allocate the batch dir and write batch.json / its footer
// / results.jsonl records. The on-disk byte shapes are a contract: batch.json is
// indent-2 with NO trailing newline; results.jsonl is one compact record per
// line using ", " / ": " separators, with the `skipped` key omitted when the
// cell ran.

// "batch-<stamp>-<nonce>"; nonce is 4 hex chars (token_hex(2)). REUSE
// nowStampUtc + hexNonce from src/paths.ts (_make_batch_id).
export function makeBatchId(stamp: string, nonceHex: string): string {
  return `batch-${stamp}-${nonceHex}`;
}

export interface AllocateBatchDirArgs {
  readonly outRoot: string;
}

// Create results/batches/<id>/ and return its path; retry on a nonce collision
// up to 100 attempts. mkdir with recursive:false so an existing dir surfaces as
// a collision to retry.
export function allocateBatchDir(args: AllocateBatchDirArgs): string {
  const batchesRoot = join(args.outRoot, 'batches');
  mkdirSync(batchesRoot, { recursive: true });
  for (let i = 0; i < 100; i++) {
    const candidate = join(batchesRoot, makeBatchId(nowStampUtc(), hexNonce()));
    try {
      mkdirSync(candidate, { recursive: false });
      return candidate;
    } catch {
      // EEXIST nonce collision; try again with a fresh stamp+nonce.
    }
  }
  throw new Error(
    'could not allocate a unique batch id after 100 attempts ' +
      `(clock or RNG malfunction?) in ${batchesRoot}`,
  );
}

export interface WriteBatchHeaderArgs {
  readonly batchDir: string;
  readonly codingAgents: readonly string[];
  readonly jobs: number;
  readonly startedAt: string;
}

// Write batch.json at batch start; finished_at is null.
export function writeBatchHeader(args: WriteBatchHeaderArgs): void {
  const data: BatchHeader = {
    schema_version: 1,
    id: basename(args.batchDir),
    started_at: args.startedAt,
    finished_at: null,
    coding_agents: [...args.codingAgents],
    jobs: args.jobs,
  };
  // indent-2 with NO trailing newline, per the on-disk format.
  writeFileSync(
    join(args.batchDir, 'batch.json'),
    JSON.stringify(data, null, 2),
  );
}

export interface WriteBatchFooterArgs {
  readonly batchDir: string;
  readonly finishedAt: string;
}

// Patch batch.json with finished_at when the batch completes. Re-reads +
// zod-narrows the existing header rather than trusting prior bytes.
export function writeBatchFooter(args: WriteBatchFooterArgs): void {
  const path = join(args.batchDir, 'batch.json');
  const header = BatchHeaderSchema.parse(
    JSON.parse(readFileSync(path, 'utf8')) as unknown,
  );
  const data: BatchHeader = { ...header, finished_at: args.finishedAt };
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export interface AppendResultRecordArgs {
  readonly batchDir: string;
  readonly scenario: string;
  readonly codingAgent: string;
  readonly runId: string | null;
  readonly skipped: string | null;
}

// Append one record to results.jsonl. Omits the `skipped` key when null.
// Serialized with the ", " / ": " separators the on-disk format requires.
export function appendResultRecord(args: AppendResultRecordArgs): void {
  const rec: ResultRecord = {
    scenario: args.scenario,
    coding_agent: args.codingAgent,
    run_id: args.runId,
    ...(args.skipped !== null ? { skipped: args.skipped } : {}),
  };
  appendFileSync(
    join(args.batchDir, 'results.jsonl'),
    `${pyCompactJson(rec)}\n`,
  );
}

// Serialize a flat record (string | null values only) with ", " between members
// and ": " after keys. JS JSON.stringify omits those spaces, so we emit the
// members by hand. Key order is the object's insertion order.
function pyCompactJson(rec: ResultRecord): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(rec)) {
    const encoded = value === undefined ? 'null' : JSON.stringify(value);
    parts.push(`${JSON.stringify(key)}: ${encoded}`);
  }
  return `{${parts.join(', ')}}`;
}
