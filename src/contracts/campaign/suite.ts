import { z } from 'zod';
import { FiniteNumberSchema } from '../finite.ts';

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

/** Round-4 S-11: every external component interpolated into a generated id —
 *  suite name, scenario name, arm name — matches this grammar. `:` is NOT a
 *  component character: it is reserved exclusively as the generated
 *  delimiter. Registration enforces this before any D3 campaign exists.
 *  (Defined here, the leaf of the suite<-campaign import edge, and
 *  re-exported by campaign.ts — the spec's two declared homes.) */
export const ID_COMPONENT_RE = /^[a-z0-9][a-z0-9._-]*$/;

export const BudgetedCellOverrideSchema = z
  .object({
    n: z.number().int().positive().optional(),
    class: z.enum(CELL_CLASSES).optional(),
    tripwire_expect: z.enum(['pass', 'fail']).optional(),
  })
  .strict();
export type BudgetedCellOverride = z.infer<typeof BudgetedCellOverrideSchema>;

/** Explicit scenario list, or a tier token registration expands (D3). The
 *  Campaign document always stores the expanded form. */
const ScenarioSelectorSchema = z.union([
  z.array(z.string().min(1)).min(1),
  z.string().regex(TIER_SELECTOR_RE),
]);

export const BudgetedTwoArmComparisonSchema = z
  .object({
    baseline: z.string().min(1),
    treatment: z.string().min(1),
    scenarios: ScenarioSelectorSchema,
    n: z.number().int().positive(),
    cells: z.record(z.string(), BudgetedCellOverrideSchema).optional(),
  })
  .strict();

export const BudgetedSingleArmComparisonSchema = z
  .object({
    arm: z.string().min(1),
    scenarios: ScenarioSelectorSchema,
    n: z.number().int().positive(),
    cells: z.record(z.string(), BudgetedCellOverrideSchema).optional(),
  })
  .strict();

/** k-arm comparisons are out by parent non-goal: the shapes structurally
 *  admit exactly one or two arms. */
export const BudgetedComparisonSchema = z.union([
  BudgetedTwoArmComparisonSchema,
  BudgetedSingleArmComparisonSchema,
]);
export type BudgetedComparison = z.infer<typeof BudgetedComparisonSchema>;

export const BudgetedSuiteSchema = z
  .object({
    schema_version: z.literal(1),
    // Suite names satisfy BOTH NAME_RE and the campaign ID-component
    // grammar: the intersection is effectively /^[a-z0-9][a-z0-9_]*$/ —
    // underscores satisfy both regexes, dots/dashes fail NAME_RE, and a
    // leading underscore fails the ID grammar's alphanumeric first
    // character.
    name: z
      .string()
      .regex(NAME_RE)
      .regex(
        ID_COMPONENT_RE,
        'suite name must satisfy the campaign ID-component grammar',
      ),
    kind: z.enum(SUITE_KINDS),
    budget_usd: FiniteNumberSchema.positive(),
    profile: z.enum(PROFILE_NAMES).optional(),
    // Validated against the profile parameter registry (profile-params.ts)
    // by quorum check and registration — kept open-typed here.
    profile_params: z.record(z.unknown()).optional(),
    reserve: z.number().int().nonnegative().optional(),
    max_exposure_skew: FiniteNumberSchema.positive().optional(),
    attempt_bounds: z
      .object({
        max_time_s: FiniteNumberSchema.positive().optional(),
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
    comparisons: z.array(BudgetedComparisonSchema).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    if (suite.kind === 'gating') {
      // Suite/profile compatibility: gating IS release-gating — only the
      // release_gate_v1 profile can decide a gate; descriptive profiles are
      // exploratory-only.
      if (suite.profile !== 'release_gate_v1') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['profile'],
          message: 'gating suites require profile: release_gate_v1',
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
    } else if (suite.profile === 'release_gate_v1') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profile'],
        message: 'release_gate_v1 is a gating profile (kind: gating only)',
      });
    }
    suite.comparisons.forEach((comparison, i) => {
      // Release scope: every release-gate comparison pairs exactly two
      // distinct arms — a single-arm unit or a self-comparison cannot gate.
      if (
        suite.kind === 'gating' &&
        (!('baseline' in comparison) ||
          comparison.baseline === comparison.treatment)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['comparisons', i],
          message: 'release-gate comparisons require two distinct arms',
        });
      }
      if (!('cells' in comparison) || comparison.cells === undefined) return;
      for (const [scenario, cell] of Object.entries(comparison.cells)) {
        // The firing criterion is a gating concern: exploratory tripwire
        // cells are descriptive-only and need no expectation.
        if (
          suite.kind === 'gating' &&
          cell.class === 'tripwire' &&
          cell.tripwire_expect === undefined
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['comparisons', i, 'cells', scenario, 'tripwire_expect'],
            message:
              'gating tripwire cells must declare tripwire_expect (the v1 firing criterion)',
          });
        }
      }
    });
  });
export type BudgetedSuite = z.infer<typeof BudgetedSuiteSchema>;

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
