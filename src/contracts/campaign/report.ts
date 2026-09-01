// src/contracts/campaign/report.ts
import { z } from 'zod';
import { FiniteNumberSchema } from '../finite.ts';
import { CELL_CLASSES } from './suite.ts';

export const REPORT_VERDICTS = [
  'SHIP',
  'NO_SHIP',
  'UNDERPOWERED_OR_INVESTIGATE',
] as const;

/** Byte-stability contract (parent Report engine): shortest round-trip
 *  doubles, sorted keys, LF line endings. D4's renderer is tested against
 *  these constants. */
export const REPORT_RENDERING = {
  line_ending: '\n',
  key_order: 'sorted',
  numbers: 'shortest-round-trip',
} as const;

const IntegrityEntrySchema = z
  .object({
    block_id: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();

/** Decision D-8 amendment (D4a spec:
 * docs/superpowers/specs/2026-08-31-kernel-d4a-descriptive-readout-design.md):
 * cells carry pass/fail counts and coverage, comparisons carry medians,
 * accounting carries the contention dispositions, provenance carries
 * failed_cells, and grader.observed is optional. Additive only — no
 * existing field changed; REPORT_RENDERING is unchanged. */

export const ReportSchema = z
  .object({
    schema_version: z.literal(1),
    campaign_id: z.string().min(1),
    profile: z.enum(['release_gate_v1', 'descriptive_v1']),
    stamp: z.literal('DESCRIPTIVE').optional(),
    verdict: z.enum(REPORT_VERDICTS).optional(),
    cannot_answer: z.array(
      z
        .object({ cell: z.string().min(1), mde: FiniteNumberSchema.positive() })
        .strict(),
    ),
    comparisons: z.array(
      z
        .object({
          comparison_id: z.string().min(1),
          cells: z.array(
            z
              .object({
                scenario: z.string().min(1),
                class: z.enum(CELL_CLASSES),
                n: z.number().int().nonnegative(),
                delta: FiniteNumberSchema.optional(),
                fisher_p: FiniteNumberSchema.min(0).max(1).optional(),
                mde: FiniteNumberSchema.positive().optional(),
                pass: z.number().int().nonnegative(),
                fail: z.number().int().nonnegative(),
                coverage: FiniteNumberSchema.min(0).max(1),
              })
              .strict(),
          ),
          medians: z
            .object({
              tokens: FiniteNumberSchema.optional(),
              usd: FiniteNumberSchema.optional(),
            })
            .strict(),
        })
        .strict(),
    ),
    accounting: z
      .object({
        instrument_errors: z.number().int().nonnegative(),
        indeterminates: z.number().int().nonnegative(),
        replacements: z.number().int().nonnegative(),
        reserve_draws: z.number().int().nonnegative(),
        skew_exclusions: z.number().int().nonnegative(),
        skew_caveats: z.number().int().nonnegative(),
        budget_events: z.number().int().nonnegative(),
        amendments: z.number().int().nonnegative(),
        contention_invalidated: z.number().int().nonnegative(),
        unknown_coverage: z.number().int().nonnegative(),
        integrity_findings: z.number().int().nonnegative(),
        integrity_caveats: z.number().int().nonnegative(),
        denominators: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    provenance: z
      .object({
        arms: z.array(
          z
            .object({
              arm: z.string().min(1),
              registered_model: z.string().min(1),
              observed_model_set: z.array(z.string().min(1)),
            })
            .strict(),
        ),
        grader: z
          .object({
            credential: z.string().min(1),
            model: z.string().min(1),
            observed: z.string().min(1).optional(),
          })
          .strict(),
        failed_cells: z.array(
          z
            .object({
              comparison_id: z.string().min(1),
              scenario: z.string().min(1),
              reason: z.string().min(1),
            })
            .strict(),
        ),
      })
      .strict(),
    supersedes: z.string().min(1).optional(),
    integrity: z
      .object({
        findings: z.array(IntegrityEntrySchema),
        caveats: z.array(IntegrityEntrySchema),
      })
      .strict(),
    errata: z.array(z.object({ note: z.string().min(1) }).strict()),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.profile === 'release_gate_v1') {
      if (report.stamp !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stamp'],
          message:
            'stamps are descriptive-only; gating reports carry a verdict',
        });
      }
      if (report.verdict === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['verdict'],
          message: 'gating reports require a verdict',
        });
      }
    } else {
      if (report.verdict !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['verdict'],
          message: 'descriptive reports have no verdict slot',
        });
      }
      if (report.stamp === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stamp'],
          message: 'descriptive reports are stamped DESCRIPTIVE',
        });
      }
    }
  });
export type Report = z.infer<typeof ReportSchema>;
