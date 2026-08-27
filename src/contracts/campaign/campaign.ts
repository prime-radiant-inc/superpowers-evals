// src/contracts/campaign/campaign.ts
import { z } from 'zod';
import {
  CREDENTIAL_APIS,
  CREDENTIAL_AUTHS,
  EnvVarNameSchema,
} from '../credential.ts';
import { FiniteNumberSchema } from '../finite.ts';
import { CELL_CLASSES, ID_COMPONENT_RE, SuiteSchema } from './suite.ts';

// Round-4 S-11 ID-component grammar (defined in suite.ts, the leaf of the
// suite<-campaign import edge) is re-exported here: the spec names
// campaign.ts and suite.ts as its two homes.
export { ID_COMPONENT_RE };

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

// Confidence vocabulary is the Phase 0 estimates contract
// (src/contracts/estimates.ts).
export const EstimateSchema = z
  .object({
    duration_s: FiniteNumberSchema.positive(),
    cost_usd: FiniteNumberSchema.nonnegative(),
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

export const BlockSlotSchema = z.enum(['primary', 'reserve']);

export const BlockSchema = z
  .object({
    block_id: z.string().min(1),
    comparison_id: z.string().min(1),
    sample_ids: z.array(z.string().min(1)).min(1),
    // E7.0 frozen slot representation: absent reads as 'primary'.
    slot: BlockSlotSchema.optional(),
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
 *  reconciled in the D1 spec). Grader-capable (R-REG-3): exactly one of
 *  arm or applies_to_grader: true. */
export const PricingOverrideSchema = z
  .object({
    arm: z.string().min(1).optional(),
    applies_to_grader: z.boolean().optional(),
    scenario: z.string().min(1).optional(),
    per_token_usd: FiniteNumberSchema.positive(),
    rationale: z.string().min(1),
  })
  .strict()
  .superRefine((override, ctx) => {
    const hasArm = override.arm !== undefined;
    const hasGrader = override.applies_to_grader === true;
    if (hasArm === hasGrader) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          'pricing override targets exactly one of arm or applies_to_grader: true',
      });
    }
  });
export type PricingOverride = z.infer<typeof PricingOverrideSchema>;

export const HostFingerprintSchema = z
  .object({
    cpu_model: z.string().min(1),
    cpu_cores: z.number().int().positive(),
    mem_bytes: z.number().int().positive(),
    disk_total_bytes: z.number().int().positive(),
  })
  .strict();

export const ContentionThresholdSchema = z
  .object({
    metric: z.string().min(1),
    source: z.string().min(1),
    op: z.enum(['gt', 'lt']),
    value: FiniteNumberSchema.positive(),
    relative_of: z.string().min(1).optional(),
  })
  .strict();

/** Decision D-4: the contention-guard declaration — host fingerprint,
 *  global run cap, invalidation thresholds, and the frozen sampler
 *  parameters. Computed and declared at registration; a digest member. */
export const ContentionDeclarationSchema = z
  .object({
    host_fingerprint: HostFingerprintSchema,
    global_run_cap: z.number().int().min(1),
    thresholds: z.array(ContentionThresholdSchema).min(1),
    cadence_ms: z.number().int().positive(),
    sustain_k: z.number().int().positive(),
    coverage_n: z.number().int().positive(),
    mem_tolerance_pct: FiniteNumberSchema.nonnegative(),
    disk_tolerance_pct: FiniteNumberSchema.nonnegative(),
  })
  .strict();
export type HostFingerprint = z.infer<typeof HostFingerprintSchema>;
export type ContentionThreshold = z.infer<typeof ContentionThresholdSchema>;
export type ContentionDeclaration = z.infer<typeof ContentionDeclarationSchema>;

/** The scrubbed, secret-free arm/credential execution surface (Blocker C
 *  intake): env-var NAMES only, never key material. */
export const ExecutionSurfaceArmSchema = z
  .object({
    name: z.string().min(1),
    agent: z.string().min(1),
    credential: z.string().min(1),
    auth: z.enum(CREDENTIAL_AUTHS),
    api: z.enum(CREDENTIAL_APIS),
    base_url: z.string().min(1).optional(),
    model: z.string().min(1),
    key_env_names: z.array(EnvVarNameSchema),
  })
  .strict();
export type ExecutionSurfaceArm = z.infer<typeof ExecutionSurfaceArmSchema>;

/** R-SPN-4 identity intake: stamped on every verdict/error/stopped path. */
export const CampaignIdentitySchema = z
  .object({
    campaign_id: z.string().min(1),
    comparison_id: z.string().min(1),
    block_id: z.string().min(1),
    sample_id: z.string().min(1),
    execution_attempt_id: z.string().min(1),
  })
  .strict();
export type CampaignIdentity = z.infer<typeof CampaignIdentitySchema>;

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
    contention: ContentionDeclarationSchema,
    execution_surface: z.array(ExecutionSurfaceArmSchema),
    pricing_overrides: z.array(PricingOverrideSchema).optional(),
    budget: z
      .object({
        usd_all_in: FiniteNumberSchema.positive(),
        surcharge_applied: FiniteNumberSchema.nonnegative(),
        priced_coverage: FiniteNumberSchema.min(0).max(1),
        surcharge_formula_version: z.number().int().positive(),
      })
      .strict(),
    // ISO-8601 datetime with a timezone designator (Z or offset).
    registered_at: z.string().datetime({ offset: true }),
    registered_by: z.string().min(1),
    digest: z.string().regex(DIGEST_RE),
  })
  .strict()
  .superRefine((campaign, ctx) => {
    // Referential integrity + cardinality invariants (parent Identity): ids
    // are unique, every block references a registered comparison, a two-arm
    // comparison's block holds two samples, a single-arm unit's block holds
    // one, every sample belongs to exactly one block, and each block's
    // sample-arm set equals its comparison's distinct arm set (one sample
    // per arm).
    const armCountByComparison = new Map<string, number>();
    const armSetByComparison = new Map<string, Set<string>>();
    campaign.comparisons.forEach((comparison, i) => {
      if (armCountByComparison.has(comparison.comparison_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['comparisons', i],
          message: `duplicate comparison id ${comparison.comparison_id}`,
        });
        return;
      }
      armCountByComparison.set(
        comparison.comparison_id,
        'arm' in comparison ? 1 : 2,
      );
      armSetByComparison.set(
        comparison.comparison_id,
        'arm' in comparison
          ? new Set([comparison.arm])
          : new Set([comparison.baseline, comparison.treatment]),
      );
    });
    const armBySample = new Map<string, string>();
    campaign.samples.forEach((sample, i) => {
      if (armBySample.has(sample.sample_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['samples', i],
          message: `duplicate sample id ${sample.sample_id}`,
        });
        return;
      }
      armBySample.set(sample.sample_id, sample.arm);
    });
    const seenBlocks = new Set<string>();
    const seen = new Set<string>();
    campaign.blocks.forEach((block, blockIndex) => {
      if (seenBlocks.has(block.block_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', blockIndex],
          message: `duplicate block id ${block.block_id}`,
        });
      }
      seenBlocks.add(block.block_id);
      const arms = armCountByComparison.get(block.comparison_id);
      if (arms === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', blockIndex, 'comparison_id'],
          message: `block ${block.block_id} references unknown comparison ${block.comparison_id}`,
        });
      } else if (block.sample_ids.length !== arms) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', blockIndex, 'sample_ids'],
          message: `block ${block.block_id} sample count must match its comparison's arm count (${arms})`,
        });
      }
      let allSamplesKnown = true;
      for (const sampleId of block.sample_ids) {
        if (seen.has(sampleId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['blocks'],
            message: `sample ${sampleId} belongs to more than one block; every sample belongs to exactly one block`,
          });
        }
        seen.add(sampleId);
        if (!armBySample.has(sampleId)) {
          allSamplesKnown = false;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['blocks'],
            message: `block ${block.block_id} references unknown sample ${sampleId}`,
          });
        }
      }
      // One sample per arm: the block's sample arms, as a multiset, must be
      // its comparison's distinct arm set exactly once each.
      const expectedArms = armSetByComparison.get(block.comparison_id);
      if (expectedArms !== undefined && allSamplesKnown) {
        const blockArms = block.sample_ids.flatMap((sampleId) => {
          const arm = armBySample.get(sampleId);
          return arm === undefined ? [] : [arm];
        });
        const armMatches =
          blockArms.length === expectedArms.size &&
          new Set(blockArms).size === blockArms.length &&
          blockArms.every((arm) => expectedArms.has(arm));
        if (!armMatches) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['blocks', blockIndex, 'sample_ids'],
            message: `block ${block.block_id} sample-arm set must equal its comparison's distinct arm set (one sample per arm)`,
          });
        }
      }
    });
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
