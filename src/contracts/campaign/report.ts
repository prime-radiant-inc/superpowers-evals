import { z } from 'zod';
import { TokenUsageSchema } from '../economics.ts';
import { FiniteNumberSchema } from '../finite.ts';
import {
  CheckRecordSchema,
  FinalVerdictSchema,
  GauntletLayerSchema,
} from '../verdict.ts';
import { ArtifactRefSchema } from './execution.ts';
import { Sha256Schema } from './experiment.ts';

const Count = z.number().int().nonnegative();
const Quantity = FiniteNumberSchema.nonnegative().nullable();
const Outcome = z.enum(['pass', 'fail', 'indeterminate']).nullable();
export const AttemptEvidenceSchema = z
  .object({
    publication_valid: z.boolean(),
    observed_outcome: Outcome,
    gauntlet: GauntletLayerSchema.nullable(),
    checks: z.array(CheckRecordSchema).nullable(),
    wall_seconds: Quantity,
    subject_cost_usd: Quantity,
    subject_cost_complete: z.boolean(),
    grader_cost_usd: Quantity,
    grader_cost_complete: z.boolean(),
    subject_tokens: Quantity,
    grader_tokens: Quantity,
    subject_usage: TokenUsageSchema.nullable(),
    versions: FinalVerdictSchema.shape.provenance.unwrap().nullable(),
    missingness: z.array(
      z.object({ field: z.string(), reason: z.string() }).strict(),
    ),
    artifacts: z.array(ArtifactRefSchema),
  })
  .strict()
  .superRefine((e, ctx) => {
    for (const role of ['subject', 'grader'] as const) {
      if (e[`${role}_cost_complete`] && e[`${role}_cost_usd`] === null)
        ctx.addIssue({
          code: 'custom',
          message: 'complete role price requires an observed total',
        });
    }
  });
export type AttemptEvidence = z.infer<typeof AttemptEvidenceSchema>;
export const PairedQuantitySchema = z
  .object({
    n: Count,
    baseline_mean: FiniteNumberSchema.nullable(),
    treatment_mean: FiniteNumberSchema.nullable(),
    mean_delta: FiniteNumberSchema.nullable(),
  })
  .strict()
  .refine(
    (q) =>
      q.n === 0
        ? q.baseline_mean === null &&
          q.treatment_mean === null &&
          q.mean_delta === null
        : q.baseline_mean !== null &&
          q.treatment_mean !== null &&
          q.mean_delta !== null,
    'empty cohorts require null means',
  );
export const AccountingQuantitySchema = z
  .object({
    known_subtotal: FiniteNumberSchema.nonnegative(),
    observed: Count,
    attempts: Count,
    complete: z.boolean(),
  })
  .strict()
  .refine(
    (q) =>
      q.observed <= q.attempts && q.complete === (q.observed === q.attempts),
    'coverage must match counts',
  );
const quantities = {
  subject_cost_usd: AccountingQuantitySchema,
  grader_cost_usd: AccountingQuantitySchema,
  combined_cost_usd: AccountingQuantitySchema,
  wall_seconds: AccountingQuantitySchema,
  subject_tokens: AccountingQuantitySchema,
  grader_tokens: AccountingQuantitySchema,
};
export const AccountingSchema = z.object(quantities).strict();
export const ComparisonReportSchema = z
  .object({
    schema_version: z.literal('quorum.comparison-report/v1'),
    fold_version: z.literal(1),
    campaign_id: z.string().min(1),
    input_digest: Sha256Schema,
    status: z.enum(['active', 'completed', 'cancelled', 'interrupted']),
    behavior_available: z.boolean(),
    complete: z.boolean(),
    termination_verified: z.boolean(),
    comparisons: z.array(
      z
        .object({
          comparison_id: z.string(),
          scenario: z.string(),
          arms: z.array(
            z
              .object({
                arm: z.string(),
                denominator: Count,
                pass: Count,
                fail: Count,
                indeterminate: Count,
                no_usable_result: Count,
                available: z
                  .object({
                    subject_cost_usd: Count,
                    grader_cost_usd: Count,
                    wall_seconds: Count,
                    subject_tokens: Count,
                    grader_tokens: Count,
                  })
                  .strict(),
              })
              .strict()
              .refine(
                (a) =>
                  a.pass + a.fail + a.indeterminate + a.no_usable_result ===
                    a.denominator &&
                  Object.values(a.available).every((n) => n <= a.denominator),
                'outcome counts must preserve planned denominator',
              ),
          ),
          paired: z
            .object({
              pass_rate: PairedQuantitySchema,
              subject_cost_usd: PairedQuantitySchema,
              grader_cost_usd: PairedQuantitySchema,
              wall_seconds: PairedQuantitySchema,
              subject_tokens: PairedQuantitySchema,
              grader_tokens: PairedQuantitySchema,
            })
            .strict(),
        })
        .strict(),
    ),
    accounting: AccountingSchema,
    excluded_accounting: z
      .object({
        superseded: AccountingSchema,
        unaccepted: AccountingSchema,
        analytically_unusable: AccountingSchema,
      })
      .strict(),
    attempts: z.array(
      z
        .object({
          execution_attempt_id: z.string(),
          sample_id: z.string(),
          block_id: z.string(),
          primary_block_id: z.string(),
          comparison_id: z.string(),
          arm: z.string(),
          selected: z.boolean(),
          accepted_outcome: Outcome,
          analysis_usable: z.boolean(),
          reasons: z.array(z.string()),
          evidence: AttemptEvidenceSchema,
        })
        .strict(),
    ),
    caveats: z.array(z.string()),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      new Set(r.attempts.map((a) => a.execution_attempt_id)).size !==
      r.attempts.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'attempt identities must be unique',
      });
    if (
      !r.behavior_available &&
      (r.comparisons.length ||
        r.attempts.some(
          (a) =>
            a.accepted_outcome !== null ||
            a.evidence.observed_outcome !== null ||
            a.evidence.gauntlet !== null ||
            a.evidence.checks !== null,
        ))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'active report must hide behavior',
      });
    if (r.complete && r.status !== 'completed')
      ctx.addIssue({
        code: 'custom',
        message: 'incomplete lifecycle cannot be complete',
      });
  });
export type ComparisonReport = z.infer<typeof ComparisonReportSchema>;
export const ReportAnchorSchema = z
  .object({
    campaign_id: z.string().min(1),
    input_digest: Sha256Schema,
    last_sequence: Count,
    prefix_digest: Sha256Schema,
    roots: z
      .object({ campaign: z.string().min(1), results: z.string().min(1) })
      .strict(),
    artifacts: z.array(
      ArtifactRefSchema.extend({
        root: z.enum(['results', 'campaign']),
      }).strict(),
    ),
  })
  .strict();
export const ReportSchema = z
  .object({ report: ComparisonReportSchema, anchor: ReportAnchorSchema })
  .strict()
  .refine(
    (r) =>
      r.report.campaign_id === r.anchor.campaign_id &&
      r.report.input_digest === r.anchor.input_digest,
    'report anchor identity mismatch',
  );
export type Report = z.infer<typeof ReportSchema>;
