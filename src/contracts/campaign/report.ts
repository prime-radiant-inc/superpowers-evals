// src/contracts/campaign/report.ts
import { z } from 'zod';
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

export const ReportSchema = z
  .object({
    schema_version: z.literal(1),
    campaign_id: z.string().min(1),
    profile: z.enum(['release_gate_v1', 'descriptive_v1']),
    stamp: z.literal('DESCRIPTIVE').optional(),
    verdict: z.enum(REPORT_VERDICTS).optional(),
    cannot_answer: z.array(
      z
        .object({ cell: z.string().min(1), mde: z.number().positive() })
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
                delta: z.number().optional(),
                fisher_p: z.number().min(0).max(1).optional(),
                mde: z.number().positive().optional(),
              })
              .strict(),
          ),
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
            observed: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    supersedes: z.string().min(1).optional(),
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
