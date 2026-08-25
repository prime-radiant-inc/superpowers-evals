// Profile parameter schemas (parent Decision profiles: "Suites bind a
// profile and its declared numeric parameters (alphas, floors, deltas)").
// The registry is a frozen built-in map: no mutable global registration —
// growing the profile list or a profile's vocabulary is a platform PR
// editing this file, never a campaign-time extension.

import { z } from 'zod';

export const ReleaseGateV1ParamsSchema = z
  .object({
    // Per-cell two-sided significance level for confirmatory cells.
    alpha: z.number().gt(0).lt(1),
    // Determinate-n floor per confirmatory cell (below floor reads
    // UNDERPOWERED and joins the cannot-answer list).
    determinate_n_floor: z.number().int().positive(),
    // The 08-08 completion-collapse tripwire threshold: cross-arm
    // completion divergence beyond this fires the tripwire family.
    completion_divergence_max: z.number().gt(0).lte(1),
    // Pre-registered minimum-detectable-effect per scenario carrying
    // confirmatory cells ("deltas") — rendered on every SHIP.
    mde_by_scenario: z.record(z.string(), z.number().positive()),
  })
  .strict();
export type ReleaseGateV1Params = z.infer<typeof ReleaseGateV1ParamsSchema>;

export const DescriptiveV1ParamsSchema = z.object({}).strict();
export type DescriptiveV1Params = z.infer<typeof DescriptiveV1ParamsSchema>;

export const PROFILE_PARAM_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> =
  Object.freeze({
    release_gate_v1: ReleaseGateV1ParamsSchema,
    descriptive_v1: DescriptiveV1ParamsSchema,
  });

export function profileParamsSchema(profile: string): z.ZodTypeAny | undefined {
  return PROFILE_PARAM_SCHEMAS[profile];
}
