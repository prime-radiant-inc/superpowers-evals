import { z } from 'zod';

/** Statistics shared by every fallback tier. Cost medians are computed
 *  over non-null observations only; null when priced_n is 0. */
export const EstimateStatsSchema = z.object({
  duration_s_median: z.number(),
  duration_n: z.number().int().nonnegative(),
  cost_subject_usd_median: z.number().nullable(),
  cost_grader_usd_median: z.number().nullable(),
  cost_total_usd_median: z.number().nullable(),
  priced_n: z.number().int().nonnegative(),
  spread_s: z.object({ p25: z.number(), p75: z.number() }),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type EstimateStats = z.infer<typeof EstimateStatsSchema>;

export const EstimateEntrySchema = EstimateStatsSchema.extend({
  scenario: z.string(),
  agent: z.string(),
  credential: z.string(),
  os: z.string(),
});
export type EstimateEntry = z.infer<typeof EstimateEntrySchema>;

export const ScenarioAgentStatsSchema = EstimateStatsSchema.extend({
  scenario: z.string(),
  agent: z.string(),
});
export type ScenarioAgentStats = z.infer<typeof ScenarioAgentStatsSchema>;

export const ScenarioStatsSchema = EstimateStatsSchema.extend({
  scenario: z.string(),
});
export type ScenarioStats = z.infer<typeof ScenarioStatsSchema>;

export const EstimatesArtifactSchema = z.object({
  schema_version: z.literal('quorum.estimates/v1'),
  /** Data-derived: max finished_at across included inputs. Never a wall
   *  clock — byte-identical regeneration is a hard requirement. */
  generated_at: z.string(),
  corpus: z.object({
    sources: z.array(z.string()),
    run_count: z.number().int().nonnegative(),
    digest: z.string(),
  }),
  entries: z.array(EstimateEntrySchema),
  fallbacks: z.object({
    scenario_agent: z.array(ScenarioAgentStatsSchema),
    scenario: z.array(ScenarioStatsSchema),
    corpus_median: z.object({
      duration_s: z.number(),
      cost_total_usd: z.number().nullable(),
    }),
  }),
});
export type EstimatesArtifact = z.infer<typeof EstimatesArtifactSchema>;
