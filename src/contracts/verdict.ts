import { z } from 'zod';

export const GAUNTLET_STATUSES = [
  'pass',
  'fail',
  'investigate',
  'errored',
] as const;
export const FINAL_STATUSES = ['pass', 'fail', 'indeterminate'] as const;
export const RUN_ERROR_STAGES = [
  'setup',
  'gauntlet',
  'capture',
  'checks',
  'compose',
  'qa-agent-misconfigured',
  'stopped',
  'unknown',
] as const;
export const CHECK_PHASES = ['pre', 'post'] as const;

export type GauntletStatus = (typeof GAUNTLET_STATUSES)[number];
export type FinalStatus = (typeof FINAL_STATUSES)[number];
export type RunErrorStage = (typeof RUN_ERROR_STAGES)[number];
export type CheckPhase = (typeof CHECK_PHASES)[number];

export const CheckRecordSchema = z.object({
  check: z.string(),
  args: z.array(z.string()),
  negated: z.boolean(),
  passed: z.boolean(),
  detail: z.string().nullable(),
  phase: z.enum(CHECK_PHASES),
});
export type CheckRecord = z.infer<typeof CheckRecordSchema>;

export const GauntletLayerSchema = z.object({
  status: z.enum(GAUNTLET_STATUSES),
  summary: z.string(),
  reasoning: z.string(),
  run_id: z.string().nullable(),
});
export type GauntletLayer = z.infer<typeof GauntletLayerSchema>;

export const RunErrorSchema = z.object({
  stage: z.enum(RUN_ERROR_STAGES),
  message: z.string(),
});
export type RunError = z.infer<typeof RunErrorSchema>;

// economics is structurally validated in contracts/economics.ts; opaque here.
export const FinalVerdictSchema = z.object({
  schema: z.literal(1),
  final: z.enum(FINAL_STATUSES),
  final_reason: z.string(),
  gauntlet: GauntletLayerSchema.nullable(),
  checks: z.array(CheckRecordSchema),
  error: RunErrorSchema.nullable(),
  economics: z.record(z.unknown()).nullable(),
  // Self-identity (dashboard read-side). Optional so an old verdict lacking
  // these fields still parses. The runner writes all six; the dashboard and
  // cost report read identity from here (run-dir-name parsing was retired).
  scenario: z.string().optional(),
  coding_agent: z.string().optional(),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  credential: z.string().optional(),
  os: z.string().optional(),
  // Best-effort provenance (PRI-2494): what was under test. Optional so old
  // verdicts parse; every inner field is nullable (probe failures).
  provenance: z
    .object({
      superpowers_rev: z.string().nullable(),
      superpowers_dirty: z.boolean().nullable(),
      harness_rev: z.string().nullable(),
      agent_cli_version: z.string().nullable(),
      gauntlet_version: z.string().nullable(),
    })
    .optional(),
});
export type FinalVerdict = z.infer<typeof FinalVerdictSchema>;
