import { z } from 'zod';
import { FiniteNumberSchema } from '../finite.ts';
import {
  CampaignComparisonSchema,
  COUPLING_CLASSES,
  ContentionDeclarationSchema,
  EstimateSchema,
  ExecutionSurfaceArmSchema,
} from './campaign.ts';
import { ID_COMPONENT_RE, SuiteSchema } from './suite.ts';

export type { Suite } from './suite.ts';
export { SuiteSchema } from './suite.ts';

export const IdSchema = z.string().min(1);
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const TimestampSchema = z.string().datetime({ offset: true });
const NameSchema = z.string().regex(ID_COMPONENT_RE);
export const ExperimentIdentitySchema = z
  .object({ campaign_id: IdSchema, input_digest: Sha256Schema })
  .strict();
export type ExperimentIdentity = z.infer<typeof ExperimentIdentitySchema>;
export const PlannedSlotSchema = z
  .object({
    sample_id: IdSchema,
    primary_block_id: IdSchema,
    comparison_id: IdSchema,
    scenario: NameSchema,
    arm: NameSchema,
    replicate: z.number().int().positive(),
  })
  .strict();
export type PlannedSlot = z.infer<typeof PlannedSlotSchema>;
export const ReserveSlotSchema = z
  .object({
    reserve_id: IdSchema,
    comparison_id: IdSchema,
    scenario: NameSchema,
  })
  .strict();
export type ReserveSlot = z.infer<typeof ReserveSlotSchema>;
export const PoolPolicySchema = z
  .object({
    pool_id: IdSchema,
    max_concurrency: z.number().int().positive(),
    launch_spacing_seconds: FiniteNumberSchema.nonnegative(),
  })
  .strict();
export type PoolPolicy = z.infer<typeof PoolPolicySchema>;
export const RuntimeLimitsSchema = z
  .object({
    max_time_s: FiniteNumberSchema.positive(),
    graceful_shutdown_s: z.literal(5),
  })
  .strict();
export const ExperimentCellSchema = z
  .object({
    scenario: NameSchema,
    comparison_id: IdSchema,
    arms: z.array(NameSchema).min(1).max(2),
    n: z.number().int().positive(),
    coupling: z.enum(COUPLING_CLASSES),
  })
  .strict();
export const ExperimentSchema = z
  .object({
    schema_version: z.literal(2),
    campaign_id: IdSchema,
    input_digest: Sha256Schema,
    suite: SuiteSchema,
    refs: z
      .object({
        superpowers_by_arm: z.record(
          NameSchema,
          z
            .string()
            .regex(/^[0-9a-f]{40}$/)
            .nullable(),
        ),
        evals: z.string().regex(/^[0-9a-f]{40}$/),
        gauntlet: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .strict(),
    grader: z.object({ credential: IdSchema, model: IdSchema }).strict(),
    cells: z.array(ExperimentCellSchema).min(1),
    excluded_cells: z.array(
      z.object({ cell: IdSchema, reason: IdSchema }).strict(),
    ),
    comparisons: z.array(CampaignComparisonSchema).min(1),
    planned_slots: z.array(PlannedSlotSchema).min(1),
    reserve_slots: z.array(ReserveSlotSchema),
    execution_surface: z.array(ExecutionSurfaceArmSchema).min(1),
    credential_authority_digest: Sha256Schema,
    pool_policy: z.array(PoolPolicySchema).min(1),
    contention: ContentionDeclarationSchema,
    runtime_limits: RuntimeLimitsSchema,
    estimates: z
      .record(z.string(), z.record(z.string(), EstimateSchema))
      .optional(),
    registered_at: TimestampSchema,
    registered_by: IdSchema,
  })
  .strict()
  .superRefine((experiment, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    const unique = (values: string[], label: string) => {
      if (new Set(values).size !== values.length) issue(`duplicate ${label}`);
    };
    unique(
      experiment.comparisons.map((c) => c.comparison_id),
      'comparison',
    );
    unique(
      experiment.planned_slots.map((s) => s.sample_id),
      'sample',
    );
    unique(
      experiment.reserve_slots.map((s) => s.reserve_id),
      'reserve',
    );
    unique(
      experiment.execution_surface.map((s) => s.name),
      'execution arm',
    );
    unique(
      experiment.pool_policy.map((p) => p.pool_id),
      'pool',
    );
    const cellKey = (c: { comparison_id: string; scenario: string }) =>
      JSON.stringify([c.comparison_id, c.scenario]);
    unique(experiment.cells.map(cellKey), 'cell');
    const comparisons = new Map(
      experiment.comparisons.map((c) => [
        c.comparison_id,
        'arm' in c ? [c.arm] : [c.baseline, c.treatment],
      ]),
    );
    const cells = new Map(experiment.cells.map((c) => [cellKey(c), c]));
    if (experiment.comparisons.length !== experiment.suite.comparisons.length)
      issue('comparison inventory differs from normalized suite');
    experiment.suite.comparisons.forEach((declared, index) => {
      const frozen = experiment.comparisons[index];
      if (!frozen) return;
      const declaredArms =
        'arm' in declared
          ? [declared.arm]
          : [declared.baseline, declared.treatment];
      const frozenArms =
        'arm' in frozen ? [frozen.arm] : [frozen.baseline, frozen.treatment];
      if (JSON.stringify(declaredArms) !== JSON.stringify(frozenArms))
        issue('comparison arm roles differ from normalized suite');
      if (!Array.isArray(declared.scenarios)) {
        issue('experiment selectors must be expanded');
        return;
      }
      unique(declared.scenarios, 'scenario selector');
      for (const scenario of declared.scenarios) {
        const included = experiment.cells.some(
          (c) =>
            c.comparison_id === frozen.comparison_id && c.scenario === scenario,
        );
        const excluded = experiment.excluded_cells.some(
          (c) => c.cell === `${frozen.comparison_id}:${scenario}`,
        );
        if (included === excluded)
          issue(
            'each normalized scenario must be included or explicitly excluded',
          );
      }

      for (const cell of experiment.cells.filter(
        (c) => c.comparison_id === frozen.comparison_id,
      )) {
        if (
          !declared.scenarios.includes(cell.scenario) ||
          cell.n !== (declared.cells?.[cell.scenario]?.n ?? declared.n)
        )
          issue('cell differs from normalized suite');
      }
    });
    const blocks = new Map<string, PlannedSlot[]>();
    for (const slot of experiment.planned_slots) {
      const cell = cells.get(cellKey(slot));
      if (!cell?.arms.includes(slot.arm) || slot.replicate > cell.n)
        issue('slot is outside its frozen cell');
      const members = blocks.get(slot.primary_block_id) ?? [];
      members.push(slot);
      blocks.set(slot.primary_block_id, members);
    }
    for (const members of blocks.values()) {
      const first = members[0];
      if (!first) continue;
      const arms = comparisons.get(first.comparison_id);
      if (
        !arms ||
        new Set(arms).size !== arms.length ||
        members.length !== arms.length ||
        new Set(members.map((s) => s.arm)).size !== arms.length ||
        members.some(
          (s) =>
            !arms.includes(s.arm) ||
            cellKey(s) !== cellKey(first) ||
            s.replicate !== first.replicate,
        )
      )
        issue('primary block must contain exactly its coherent arm inventory');
    }
    for (const cell of experiment.cells) {
      const arms = comparisons.get(cell.comparison_id);
      if (
        !arms ||
        new Set(cell.arms).size !== cell.arms.length ||
        arms.length !== cell.arms.length ||
        cell.arms.some((a) => !arms.includes(a))
      )
        issue('cell arm mapping differs from comparison');
      for (const arm of cell.arms) {
        const slots = experiment.planned_slots.filter(
          (s) => cellKey(s) === cellKey(cell) && s.arm === arm,
        );
        if (
          slots.length !== cell.n ||
          new Set(slots.map((s) => s.replicate)).size !== cell.n
        )
          issue('planned slots must preserve cell sample count');
        if (
          !experiment.execution_surface.some((s) => s.name === arm) ||
          !(arm in experiment.refs.superpowers_by_arm)
        )
          issue('cell arm lacks frozen execution surface or source ref');
      }
      if (
        experiment.reserve_slots.filter((s) => cellKey(s) === cellKey(cell))
          .length !== experiment.suite.reserve
      )
        issue('reserve capacity must match each cell');
    }
    for (const reserve of experiment.reserve_slots) {
      if (!cells.has(cellKey(reserve)))
        issue('reserve references unknown cell');
      if (blocks.has(reserve.reserve_id))
        issue('reserve identity collides with primary block');
    }
    if (
      experiment.runtime_limits.max_time_s !==
      experiment.suite.attempt_bounds.max_time_s
    )
      issue('runtime deadline differs from suite bound');
  });
export type Experiment = z.infer<typeof ExperimentSchema>;
