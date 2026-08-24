import { z } from 'zod';

export const CELL_CLASSES = [
  'confirmatory',
  'probe',
  'tripwire',
  'descriptive',
] as const;
export const SUITE_KINDS = ['gating', 'exploratory'] as const;
export const PROFILE_NAMES = ['release_gate_v1', 'descriptive_v1'] as const;
export const TIER_SELECTOR_RE = /^tier=(sentinel|full|adhoc)$/;

const NAME_RE = /^[a-z0-9_]+$/;

export const CellOverrideSchema = z
  .object({
    n: z.number().int().positive().optional(),
    class: z.enum(CELL_CLASSES).optional(),
    tripwire_expect: z.enum(['pass', 'fail']).optional(),
  })
  .strict();
export type CellOverride = z.infer<typeof CellOverrideSchema>;

/** Explicit scenario list, or a tier token registration expands (D3). The
 *  Campaign document always stores the expanded form. */
const ScenarioSelectorSchema = z.union([
  z.array(z.string().min(1)).min(1),
  z.string().regex(TIER_SELECTOR_RE),
]);

export const TwoArmComparisonSchema = z
  .object({
    baseline: z.string().min(1),
    treatment: z.string().min(1),
    scenarios: ScenarioSelectorSchema,
    n: z.number().int().positive(),
    cells: z.record(z.string(), CellOverrideSchema).optional(),
  })
  .strict();

export const SingleArmComparisonSchema = z
  .object({
    arm: z.string().min(1),
    scenarios: ScenarioSelectorSchema,
    n: z.number().int().positive(),
    cells: z.record(z.string(), CellOverrideSchema).optional(),
  })
  .strict();

/** k-arm comparisons are out by parent non-goal: the shapes structurally
 *  admit exactly one or two arms. */
export const ComparisonSchema = z.union([
  TwoArmComparisonSchema,
  SingleArmComparisonSchema,
]);
export type Comparison = z.infer<typeof ComparisonSchema>;

export const SuiteSchema = z
  .object({
    schema_version: z.literal(1),
    name: z.string().regex(NAME_RE),
    kind: z.enum(SUITE_KINDS),
    budget_usd: z.number().positive(),
    profile: z.enum(PROFILE_NAMES).optional(),
    // Validated against the profile parameter registry (profile-params.ts)
    // by quorum check and registration — kept open-typed here.
    profile_params: z.record(z.unknown()).optional(),
    reserve: z.number().int().nonnegative().optional(),
    max_exposure_skew: z.number().positive().optional(),
    attempt_bounds: z
      .object({
        max_time_s: z.number().positive().optional(),
        max_attempts: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    declared_metrics: z
      .array(
        z
          .object({
            name: z.string().min(1),
            unit: z.string().min(1),
            aggregation: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    comparisons: z.array(ComparisonSchema).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    if (suite.kind === 'gating') {
      if (suite.profile === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['profile'],
          message: 'gating suites require a decision profile',
        });
      }
      if (suite.reserve === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reserve'],
          message: 'gating suites require a registered reserve',
        });
      }
      if (suite.max_exposure_skew === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['max_exposure_skew'],
          message: 'gating suites require a registered exposure-skew bound',
        });
      }
    }
    suite.comparisons.forEach((comparison, i) => {
      if (!('cells' in comparison) || comparison.cells === undefined) return;
      for (const [scenario, cell] of Object.entries(comparison.cells)) {
        if (cell.class === 'tripwire' && cell.tripwire_expect === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['comparisons', i, 'cells', scenario, 'tripwire_expect'],
            message:
              'tripwire cells must declare tripwire_expect (the v1 firing criterion)',
          });
        }
      }
    });
  });
export type Suite = z.infer<typeof SuiteSchema>;
