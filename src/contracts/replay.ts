import { z } from 'zod';

/** One imported run reduced to the fields the simulation and estimates
 *  consume. wall_ms is the run's total wall (finished_at − started_at);
 *  it is the service time. Everything else is nullable evidence. */
export const ReplayRecordSchema = z.object({
  run_id: z.string(),
  scenario: z.string(),
  agent: z.string(),
  credential: z.string(),
  os: z.string(),
  pool_id: z.string(),
  arm: z.enum(['baseline', 'treatment', 'single']),
  wall_ms: z.number().finite().nonnegative(),
  coding_ms: z.number().finite().nonnegative().nullable(),
  gauntlet_ms: z.number().finite().nonnegative().nullable(),
  pre_exposure_ms: z.number().finite().nonnegative().nullable(),
  cost_subject_usd: z.number().nullable(),
  cost_grader_usd: z.number().nullable(),
  cost_total_usd: z.number().nullable(),
});
export type ReplayRecord = z.infer<typeof ReplayRecordSchema>;

export const ManifestSampleSchema = z.object({
  run_id: z.string(),
  arm: z.enum(['baseline', 'treatment']),
  replicate: z.number().int().positive(),
  block_id: z.string(),
  historical_job: z.string(),
  role: z.enum(['scored', 'retry-load']),
});
export type ManifestSample = z.infer<typeof ManifestSampleSchema>;

export const ManifestCellSchema = z.object({
  scenario: z.string(),
  class: z.enum(['confirmatory', 'probe', 'tripwire', 'descriptive']),
  samples: z.array(ManifestSampleSchema),
});
export type ManifestCell = z.infer<typeof ManifestCellSchema>;

export const ManifestComparisonSchema = z.object({
  comparison_id: z.string(),
  credential: z.string(),
  pool_id: z.string(),
  legacy_pool_id: z.string(),
  cells: z.array(ManifestCellSchema),
});
export type ManifestComparison = z.infer<typeof ManifestComparisonSchema>;

/** Canonical, run-ID-exact structural source for a replay. Curation-time
 *  frozen: pool_ids are resolved from gate-era credential definitions and
 *  never recomputed at load. */
export const ReplayManifestSchema = z.object({
  schema_version: z.literal('quorum.replay-manifest/v1'),
  name: z.string(),
  source_docs: z.array(z.string()),
  arms: z.object({
    baseline_sha: z.string().length(40),
    treatment_sha: z.string().length(40),
  }),
  comparisons: z.array(ManifestComparisonSchema),
  excluded_run_ids: z.array(
    z.object({ run_id: z.string(), reason: z.string() }),
  ),
});
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;
