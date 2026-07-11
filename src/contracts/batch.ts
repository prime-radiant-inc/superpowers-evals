import { z } from 'zod';
import { type CredentialLabels, CredentialLabelsSchema } from './credential.ts';

// Batch index contracts. Every JSON read at these boundaries is zod-narrowed;
// the writers live in src/run-all/batch-index.ts (batch.json indent 2,
// results.jsonl one compact record per line).

// batch.json — written once at batch start (finished_at null), patched at end.
export const BatchHeaderSchema = z.object({
  schema_version: z.literal(1),
  id: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  coding_agents: z.array(z.string()),
  jobs: z.number(),
});
export type BatchHeader = z.infer<typeof BatchHeaderSchema>;

// results.jsonl — one record per (scenario, agent) cell. `skipped` is omitted
// (not null) when the cell actually ran; present with a reason label otherwise.
export const ResultRecordSchema = z.object({
  scenario: z.string(),
  coding_agent: z.string(),
  credential: z.string().optional(),
  labels: CredentialLabelsSchema.optional(),
  run_id: z.string().nullable(),
  skipped: z.string().optional(),
});
export type ResultRecord = z.infer<typeof ResultRecordSchema>;

// Why a cell is not runnable. null == runnable. Precedence (highest first):
// directive > draft > tier > harness > os (see buildMatrix).
export type SkippedReason =
  | 'directive'
  | 'draft'
  | 'tier'
  | 'harness'
  | 'os'
  | null;

// One (scenario, agent) cell of the batch matrix. `runnable` is the helper below
// rather than a property to keep the type plain.
export interface MatrixEntry {
  readonly scenario: string;
  readonly codingAgent: string;
  readonly scenarioDir: string;
  readonly skippedReason: SkippedReason;
  readonly tier: 'sentinel' | 'full' | 'adhoc';
  readonly status: string;
  // The credential name used by this cell's agent ('' for credential-less agents).
  readonly credential: string;
  // Strict model/provider metadata copied from the selected parsed credential.
  readonly labels?: CredentialLabels;
  // The scheduler limiterKey: shared across all cells hitting the same endpoint.
  // Credential-less agents fall back to the agent name (preserving prior behavior).
  readonly limiterKey: string;
}

// A cell runs iff it carries no skip reason.
export function runnable(entry: MatrixEntry): boolean {
  return entry.skippedReason === null;
}

// Outcome of one child `quorum run` invocation.
//   run_id    — the run-dir basename the child printed, or null if it crashed
//               before allocating one.
//   exit_code — child process exit code (0 pass / 1 fail / 2 indeterminate;
//               anything else abnormal). -1 marks a timeout.
//   error     — short process-level description when something went wrong
//               (couldn't parse run-id, timeout). A `fail` verdict is NOT an error.
export interface ChildResult {
  readonly run_id: string | null;
  readonly exit_code: number;
  readonly error: string | null;
}
