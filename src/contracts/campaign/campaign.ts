// src/contracts/campaign/campaign.ts
import { z } from 'zod';
import { CELL_CLASSES, SuiteSchema } from './suite.ts';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

// Confidence vocabulary is the Phase 0 estimates contract
// (src/contracts/estimates.ts).
export const EstimateSchema = z
  .object({
    duration_s: z.number().positive(),
    cost_usd: z.number().nonnegative(),
    confidence: z.enum(['high', 'medium', 'low']),
  })
  .strict();
export type Estimate = z.infer<typeof EstimateSchema>;

export const COUPLING_CLASSES = [
  'pins-skill-names',
  'embeds-skill-fixtures',
  'arm-independent',
] as const;

export const CellSchema = z
  .object({
    scenario: z.string().min(1),
    comparison_id: z.string().min(1),
    arms: z.array(z.string().min(1)).min(1).max(2),
    n: z.number().int().positive(),
    class: z.enum(CELL_CLASSES),
    coupling: z.enum(COUPLING_CLASSES),
    estimates_by_arm: z.record(z.string(), EstimateSchema),
  })
  .strict();
export type Cell = z.infer<typeof CellSchema>;

export const SampleSchema = z
  .object({
    sample_id: z.string().min(1),
    cell: z.string().min(1),
    arm: z.string().min(1),
    replicate: z.number().int().positive(),
  })
  .strict();
export type Sample = z.infer<typeof SampleSchema>;

export const BlockSchema = z
  .object({
    block_id: z.string().min(1),
    comparison_id: z.string().min(1),
    sample_ids: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Block = z.infer<typeof BlockSchema>;

export const CampaignComparisonSchema = z.union([
  z
    .object({
      comparison_id: z.string().min(1),
      baseline: z.string().min(1),
      treatment: z.string().min(1),
    })
    .strict(),
  z
    .object({
      comparison_id: z.string().min(1),
      arm: z.string().min(1),
    })
    .strict(),
]);
export type CampaignComparison = z.infer<typeof CampaignComparisonSchema>;

/** The operator-declared per-token escape for unpriced gating models —
 *  parent Concepts records it in campaign.json (Appendix B omission
 *  reconciled in the D1 spec). */
export const PricingOverrideSchema = z
  .object({
    arm: z.string().min(1),
    scenario: z.string().min(1).optional(),
    per_token_usd: z.number().positive(),
    rationale: z.string().min(1),
  })
  .strict();
export type PricingOverride = z.infer<typeof PricingOverrideSchema>;

export const CampaignSchema = z
  .object({
    schema_version: z.literal(1),
    campaign_id: z.string().min(1),
    suite: SuiteSchema,
    refs: z
      .object({
        superpowers_by_arm: z.record(
          z.string(),
          z.union([z.string().regex(FULL_SHA_RE), z.null()]),
        ),
        evals: z.string().regex(FULL_SHA_RE),
        gauntlet: z.string().regex(FULL_SHA_RE),
      })
      .strict(),
    grader: z
      .object({ credential: z.string().min(1), model: z.string().min(1) })
      .strict(),
    cells: z.array(CellSchema),
    excluded_cells: z.array(
      z.object({ cell: z.string().min(1), reason: z.string().min(1) }).strict(),
    ),
    samples: z.array(SampleSchema),
    comparisons: z.array(CampaignComparisonSchema),
    blocks: z.array(BlockSchema),
    pricing_overrides: z.array(PricingOverrideSchema).optional(),
    budget: z
      .object({
        usd_all_in: z.number().positive(),
        surcharge_applied: z.number().nonnegative(),
        priced_coverage: z.number().min(0).max(1),
      })
      .strict(),
    registered_at: z.string().min(1),
    registered_by: z.string().min(1),
    digest: z.string().regex(DIGEST_RE),
  })
  .strict()
  .superRefine((campaign, ctx) => {
    // Cardinality invariants (parent Identity): a two-arm comparison's block
    // holds two samples; a single-arm unit's block holds one; every sample
    // belongs to exactly one block.
    const armsByComparison = new Map<string, number>();
    for (const comparison of campaign.comparisons) {
      armsByComparison.set(
        comparison.comparison_id,
        'arm' in comparison ? 1 : 2,
      );
    }
    const seen = new Set<string>();
    for (const block of campaign.blocks) {
      const arms = armsByComparison.get(block.comparison_id);
      if (arms !== undefined && block.sample_ids.length !== arms) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', campaign.blocks.indexOf(block), 'sample_ids'],
          message: `block ${block.block_id} sample count must match its comparison's arm count (${arms})`,
        });
      }
      for (const sampleId of block.sample_ids) {
        if (seen.has(sampleId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['blocks'],
            message: `sample ${sampleId} belongs to more than one block; every sample belongs to exactly one block`,
          });
        }
        seen.add(sampleId);
        if (!campaign.samples.some((s) => s.sample_id === sampleId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['blocks'],
            message: `block ${block.block_id} references unknown sample ${sampleId}`,
          });
        }
      }
    }
    for (const sample of campaign.samples) {
      if (!seen.has(sample.sample_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['samples'],
          message: `sample ${sample.sample_id} belongs to no block; every sample belongs to exactly one block`,
        });
      }
    }
  });
export type Campaign = z.infer<typeof CampaignSchema>;
