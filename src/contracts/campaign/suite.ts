import { z } from 'zod';
import { FiniteNumberSchema } from '../finite.ts';
export const TIER_SELECTOR_RE = /^tier=(sentinel|full|adhoc)$/;
export const ID_COMPONENT_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const CellOverrideSchema = z
  .object({ n: z.number().int().positive().optional() })
  .strict();
export type CellOverride = z.infer<typeof CellOverrideSchema>;

const ScenarioSelectorSchemaV2 = z.union([
  z.array(z.string().regex(ID_COMPONENT_RE)).min(1),
  z.string().regex(TIER_SELECTOR_RE),
]);

const comparisonFieldsV2 = {
  scenarios: ScenarioSelectorSchemaV2,
  n: z.number().int().positive(),
  cells: z
    .record(z.string().regex(ID_COMPONENT_RE), CellOverrideSchema)
    .optional(),
};

export const TwoArmComparisonSchema = z
  .object({
    baseline: z.string().regex(ID_COMPONENT_RE),
    treatment: z.string().regex(ID_COMPONENT_RE),
    ...comparisonFieldsV2,
  })
  .strict();

export const SingleArmComparisonSchema = z
  .object({
    arm: z.string().regex(ID_COMPONENT_RE),
    ...comparisonFieldsV2,
  })
  .strict();

export const ComparisonSchema = z.union([
  TwoArmComparisonSchema,
  SingleArmComparisonSchema,
]);
export type Comparison = z.infer<typeof ComparisonSchema>;

/** The finite V2 experiment declaration. Pricing and release policy are not inputs. */
export const SuiteSchema = z
  .object({
    schema_version: z.literal(2),
    name: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
    comparisons: z.array(ComparisonSchema).min(1),
    reserve: z.number().int().nonnegative(),
    max_exposure_skew: FiniteNumberSchema.positive(),
    attempt_bounds: z
      .object({
        max_attempts: z.number().int().positive(),
        max_time_s: FiniteNumberSchema.positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((suite, ctx) => {
    suite.comparisons.forEach((comparison, index) => {
      if (
        'baseline' in comparison &&
        comparison.baseline === comparison.treatment
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['comparisons', index],
          message: 'comparison arms must be distinct',
        });
      }
    });
  });
export type Suite = z.infer<typeof SuiteSchema>;
