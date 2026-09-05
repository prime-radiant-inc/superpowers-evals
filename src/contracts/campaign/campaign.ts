// src/contracts/campaign/campaign.ts
import { z } from 'zod';
import {
  CREDENTIAL_APIS,
  CREDENTIAL_AUTHS,
  EnvVarNameSchema,
} from '../credential.ts';
import { FiniteNumberSchema } from '../finite.ts';
import { ID_COMPONENT_RE } from './suite.ts';

// Round-4 S-11 ID-component grammar (defined in suite.ts, the leaf of the
// suite<-campaign import edge) is re-exported here: the spec names
// campaign.ts and suite.ts as its two homes.
export { ID_COMPONENT_RE };

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
