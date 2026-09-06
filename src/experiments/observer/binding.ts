import { z } from 'zod';
import {
  type CampaignIdentity,
  CampaignIdentitySchema,
} from '../../contracts/campaign/campaign.ts';
import {
  AbsoluteRuntimePathSchema,
  RelativeArtifactPathSchema,
} from '../../contracts/campaign/execution.ts';
import {
  type Experiment,
  ExperimentSchema,
} from '../../contracts/campaign/experiment.ts';
import {
  type RawAnchor,
  RawAnchorSchema,
  type RawSource,
  RawSourceSchema,
} from './contracts.ts';
import type { FinalStateRoot } from './final-state.ts';

export interface ObserverBinding {
  schema_version: 2;
  run_id: string;
  campaign: CampaignIdentity | null;
  runtime: 'codex' | 'claude';
  dialect: string;
  cli_version: string;
  home: string;
  workdir: string;
  launch_cwd: string;
  roots: FinalStateRoot[];
  phase: 'unbound' | 'bound' | 'finalized';
  parent_source_id: string | null;
  sources: {
    source: RawSource;
    root_id: string;
    relative_path: string;
    device: string;
    inode: string;
    parent_link: {
      source_id: string;
      call: RawAnchor;
      join: RawAnchor | null;
    } | null;
  }[];
}

const NameSchema = z.string().min(1);
const DecimalSchema = z.string().regex(/^\d+$/);
const RootSchema = z
  .object({
    id: NameSchema,
    kind: z.enum(['transcripts', 'artifacts']),
    path: AbsoluteRuntimePathSchema,
  })
  .strict();
const SourceBindingSchema = z
  .object({
    source: RawSourceSchema,
    root_id: NameSchema,
    relative_path: RelativeArtifactPathSchema,
    device: DecimalSchema,
    inode: DecimalSchema,
    parent_link: z
      .object({
        source_id: NameSchema,
        call: RawAnchorSchema,
        join: RawAnchorSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const ObserverBindingSchema: z.ZodType<ObserverBinding> = z
  .object({
    schema_version: z.literal(2),
    run_id: NameSchema,
    campaign: CampaignIdentitySchema.nullable(),
    runtime: z.enum(['codex', 'claude']),
    dialect: NameSchema,
    cli_version: NameSchema,
    home: AbsoluteRuntimePathSchema,
    workdir: AbsoluteRuntimePathSchema,
    launch_cwd: AbsoluteRuntimePathSchema,
    roots: z.array(RootSchema).min(2),
    phase: z.enum(['unbound', 'bound', 'finalized']),
    parent_source_id: NameSchema.nullable(),
    sources: z.array(SourceBindingSchema),
  })
  .strict()
  .superRefine((binding, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: 'custom', message });
    const roots = new Map(binding.roots.map((root) => [root.id, root]));
    if (roots.size !== binding.roots.length)
      issue('Root identities must be unique.');
    const artifacts = binding.roots.filter((root) => root.kind === 'artifacts');
    if (artifacts.length !== 1 || artifacts[0]?.path !== binding.workdir)
      issue('The artifact root must be the bound workdir.');
    if (
      binding.launch_cwd !== binding.workdir &&
      !binding.launch_cwd.startsWith(`${binding.workdir}/`)
    )
      issue('Launch cwd must be within the artifact workdir.');
    if (
      binding.home === binding.workdir ||
      binding.home.startsWith(`${binding.workdir}/`) ||
      binding.workdir.startsWith(`${binding.home}/`)
    )
      issue('Subject home and artifact workdir must be separate.');
    const paths = binding.roots.map((root) => root.path);
    for (const [index, root] of binding.roots.entries()) {
      if (
        root.kind === 'transcripts' &&
        !root.path.startsWith(`${binding.home}/`)
      )
        issue('Transcript roots must be strict descendants of the bound home.');
      if (
        paths.some(
          (path, other) =>
            other !== index &&
            (path === root.path || path.startsWith(`${root.path}/`)),
        )
      )
        issue('Roots must not overlap.');
    }
    if (!binding.roots.some((root) => root.kind === 'transcripts'))
      issue('A transcript root is required.');
    if (binding.phase === 'unbound') {
      if (binding.parent_source_id !== null || binding.sources.length !== 0)
        issue('An unbound observer cannot select sources.');
      return;
    }
    const sources = new Map(
      binding.sources.map((entry) => [entry.source.source_id, entry]),
    );
    if (sources.size !== binding.sources.length)
      issue('Source identities must be unique.');
    const locations = new Set<string>();
    const identities = new Set<string>();
    for (const entry of binding.sources) {
      const location = JSON.stringify([entry.root_id, entry.relative_path]);
      const identity = JSON.stringify([entry.device, entry.inode]);
      if (locations.has(location) || identities.has(identity))
        issue('Sources must have unique paths and file identities.');
      locations.add(location);
      identities.add(identity);
      if (roots.get(entry.root_id)?.kind !== 'transcripts')
        issue('Sources must belong to a bound transcript root.');
      if (
        entry.source.runtime !== binding.runtime ||
        entry.source.expected_cwd !== binding.launch_cwd ||
        entry.source.expected_cli_version !== binding.cli_version
      )
        issue('Source runtime, cwd and build must match the binding.');
      if (entry.source.source_id === binding.parent_source_id) {
        if (entry.parent_link !== null)
          issue('The selected parent cannot be a descendant.');
      } else if (entry.parent_link === null)
        issue('Every descendant requires an explicit parent link.');
      const link = entry.parent_link;
      if (
        link !== null &&
        (!sources.has(link.source_id) ||
          link.call.source_id !== link.source_id ||
          (link.join !== null &&
            (link.join.source_id !== link.source_id ||
              link.join.line < link.call.line ||
              (link.join.line === link.call.line &&
                (link.join.block ?? -1) <= (link.call.block ?? -1)))))
      )
        issue(
          'Descendant call and join must refer to an ordered bound parent source.',
        );
      const seen = new Set<string>();
      let ancestor: typeof entry | undefined = entry;
      while (ancestor?.parent_link !== null && ancestor !== undefined) {
        const id = ancestor.source.source_id;
        if (seen.has(id)) {
          issue('Source ancestry cannot contain cycles.');
          break;
        }
        seen.add(id);
        ancestor = sources.get(ancestor.parent_link.source_id);
      }
      if (ancestor?.source.source_id !== binding.parent_source_id)
        issue('Every source must descend from the selected parent.');
    }
    if (
      binding.parent_source_id === null ||
      !sources.has(binding.parent_source_id)
    )
      issue('A bound observer requires exactly one selected parent.');
  });

export function validateObserverBinding(value: unknown): ObserverBinding {
  return ObserverBindingSchema.parse(value);
}

export function observerRequiredForScenario(scenario: string): boolean {
  return scenario === 'brainstorming-todo-shared-intent';
}

/** Frozen selection determines policy; the campaign journal authenticates dynamic execution. */
export function observerRequiredForAttempt(
  experiment: Experiment,
  identity: CampaignIdentity,
): boolean {
  const frozen = ExperimentSchema.parse(experiment);
  const attempt = CampaignIdentitySchema.parse(identity);
  const slot = frozen.planned_slots.find(
    (candidate) => candidate.sample_id === attempt.sample_id,
  );
  if (
    attempt.campaign_id !== frozen.campaign_id ||
    !slot ||
    slot.comparison_id !== attempt.comparison_id ||
    !frozen.execution_surface.some((arm) => arm.name === slot.arm)
  )
    throw new Error('Observer attempt does not match its frozen selection.');
  if (!observerRequiredForScenario(slot.scenario)) return false;
  // This instrument qualifies only fresh, primary attempts with no replacements.
  if (
    frozen.suite.reserve !== 0 ||
    frozen.suite.attempt_bounds.max_attempts !== 1 ||
    attempt.block_id !== slot.primary_block_id ||
    attempt.execution_attempt_id !== `${slot.sample_id}:a1`
  )
    throw new Error(
      'Observer attempt lineage is outside the qualified primary-only scope.',
    );
  return true;
}
