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
  /** Token-volume median over the group's runs (sidecar
   *  coding-agent-token-usage.json total_tokens) — the C3 pricing-override
   *  volume source (2026-08-27 operator ruling). Optional and additive:
   *  artifacts predating token capture stay valid; absent means "no
   *  observed volume", and a per-token override without a volume cannot
   *  price (fail-closed at registration). Volumes are nonnegative and
   *  finite — a negative median would price an override negative. */
  tokens_total_median: z.number().finite().nonnegative().optional(),
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
    /** Merge rule "counts recorded": duplicate run_ids excluded by the
     * union-by-run_id first-wins rule are never dropped silently. */
    duplicates_excluded: z.number().int().nonnegative(),
    /** Runs whose subject never ran — indeterminate at a stage before or
     *  outside the coding-agent lifecycle (setup, qa-agent-misconfigured,
     *  or an unknown-stage harness crash). Their sub-second walls would
     *  drag a cell's median toward zero, so they are excluded from every
     *  tier's statistics but recorded here by identity: they are failures
     *  to fix or be aware of, never silently dropped. */
    excluded: z.array(
      z.object({
        run_id: z.string(),
        scenario: z.string(),
        agent: z.string(),
        credential: z.string(),
        os: z.string(),
        stage: z.string(),
      }),
    ),
    digest: z.string(),
  }),
  entries: z.array(EstimateEntrySchema),
  fallbacks: z.object({
    scenario_agent: z.array(ScenarioAgentStatsSchema),
    scenario: z.array(ScenarioStatsSchema),
    corpus_median: z.object({
      duration_s: z.number(),
      cost_total_usd: z.number().nullable(),
      // Same constraint as the stats tiers (see EstimateStatsSchema): a
      // negative fallback volume would price a corpus-tier override
      // negative.
      tokens_total_median: z.number().finite().nonnegative().optional(),
    }),
  }),
});
export type EstimatesArtifact = z.infer<typeof EstimatesArtifactSchema>;
