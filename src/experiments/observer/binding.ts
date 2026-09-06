import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readPinnedNoFollowBytes } from '../../appliance/credential-scope.ts';
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
  indexClaudeTranscript,
  inspectedClaudeParentIdentity,
} from './claude.ts';
import { indexCodexTranscript } from './codex.ts';
import {
  ObserverEvidenceError,
  type RawAnchor,
  RawAnchorSchema,
  type RawIndex,
  type RawSource,
  RawSourceSchema,
} from './contracts.ts';
import type { FinalStateRoot } from './final-state.ts';
import {
  captureFinalState,
  type FinalStateNode,
  verifyFinalState,
} from './final-state.ts';
import { parseCompleteJsonl } from './raw.ts';

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

/** Inspected source grammar, not native runtime or provider qualification. */
export const OBSERVER_DIALECTS = {
  codex: { dialect: 'codex-response-items-0.144.3', cli_version: '0.144.3' },
  claude: null,
} as const;

export function observerDialectForBuild(
  runtime: ObserverBinding['runtime'],
  cliVersion: string,
): { dialect: string; cli_version: string } | null {
  if (runtime === 'claude' && cliVersion === '2.1.209')
    return { dialect: 'claude-jsonl-2.1.209', cli_version: '2.1.209' };
  if (runtime === 'codex' && cliVersion === '0.146.0')
    return { dialect: 'codex-response-items-0.146.0', cli_version: '0.146.0' };
  const supported = OBSERVER_DIALECTS[runtime];
  return supported?.cli_version === cliVersion ? supported : null;
}

export function requireObserverDialect(binding: ObserverBinding): void {
  const supported = observerDialectForBuild(
    binding.runtime,
    binding.cli_version,
  );
  if (
    !supported ||
    binding.dialect !== supported.dialect ||
    binding.cli_version !== supported.cli_version
  )
    throw new ObserverEvidenceError(
      'invalid_source',
      'Observer dialect/build lacks inspected parent provenance.',
    );
}

export function readObserverNode(
  binding: ObserverBinding,
  node: FinalStateNode,
): Buffer {
  const root = binding.roots.find((entry) => entry.id === node.root_id);
  if (!root || node.kind !== 'file')
    throw new ObserverEvidenceError(
      'invalid_source',
      'Observer source is not an inventoried file.',
    );
  const raw = readPinnedNoFollowBytes(
    root.path,
    node.path.split('/'),
    'observer source',
    true,
  );
  if (
    raw === null ||
    raw.length !== node.bytes ||
    createHash('sha256').update(raw).digest('hex') !== node.sha256
  )
    throw new ObserverEvidenceError(
      'prefix_mismatch',
      'Observer source changed during capture.',
    );
  return raw;
}

export function indexObserverSource(
  source: RawSource,
  raw: Uint8Array,
): RawIndex {
  return source.runtime === 'codex'
    ? indexCodexTranscript(source, raw)
    : indexClaudeTranscript(source, raw);
}

/** Recheck raw authority during acquisition and offline replay alike. */
export function indexBoundObserverSource(
  binding: ObserverBinding,
  source: RawSource,
  raw: Uint8Array,
): RawIndex {
  requireObserverDialect(binding);
  if (
    source.runtime !== binding.runtime ||
    source.expected_cwd !== binding.launch_cwd ||
    source.expected_cli_version !== binding.cli_version
  )
    throw new ObserverEvidenceError(
      'identity_conflict',
      'Raw source conflicts with runner binding.',
    );
  const index = indexObserverSource(source, raw);
  if (binding.runtime === 'claude') {
    const parent = inspectedClaudeParentIdentity(raw);
    if (
      !parent ||
      parent.session_id !== source.expected_session_id ||
      parent.cwd !== source.expected_cwd ||
      parent.cli_version !== source.expected_cli_version ||
      index.identity.conversation !== 'parent'
    )
      throw new ObserverEvidenceError(
        'invalid_source',
        'Source lacks inspected Claude parent provenance.',
      );
    return index;
  }
  const header = parseCompleteJsonl(source, raw)[0]?.value;
  const payload = header?.['payload'];
  if (
    header?.['type'] !== 'session_meta' ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    index.identity.conversation !== 'parent' ||
    payload['originator'] !== 'codex-tui' ||
    payload['thread_source'] !== 'user'
  )
    throw new ObserverEvidenceError(
      'invalid_source',
      'Source lacks inspected parent or descendant-link provenance.',
    );
  for (const row of parseCompleteJsonl(source, raw).slice(1)) {
    if (row.value['type'] !== 'session_meta') continue;
    const metadata = row.value['payload'];
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      continue;
    if (
      (metadata['originator'] !== undefined &&
        metadata['originator'] !== 'codex-tui') ||
      (metadata['thread_source'] !== undefined &&
        metadata['thread_source'] !== 'user')
    )
      throw new ObserverEvidenceError(
        'identity_conflict',
        'Session metadata changes inspected parent authority.',
        row.anchor,
      );
  }
  return index;
}

/** Startup may have no source. Once selected, the parent path and inode are immutable. */
export function discoverObserverSources(
  input: ObserverBinding,
): ObserverBinding {
  const binding = validateObserverBinding(input);
  if (binding.phase === 'finalized')
    throw new ObserverEvidenceError(
      'invalid_source',
      'Finalized observer cannot discover live sources.',
    );
  const inventory = captureFinalState(binding.roots);
  const transcriptRoots = new Set(
    binding.roots
      .filter((root) => root.kind === 'transcripts')
      .map((root) => root.id),
  );
  const nodes = inventory.nodes.filter(
    (node) => node.kind === 'file' && transcriptRoots.has(node.root_id),
  );
  if (nodes.length === 0 && binding.phase === 'unbound') return binding;
  requireObserverDialect(binding);
  const candidates: ObserverBinding['sources'] = [];
  for (const node of nodes) {
    const raw = readObserverNode(binding, node);
    const placeholder: RawSource = {
      source_id: `${node.root_id}:${node.path}`,
      runtime: binding.runtime,
      expected_session_id: 'unresolved',
      expected_cwd: binding.launch_cwd,
      expected_cli_version: binding.cli_version,
    };
    let id: unknown;
    if (binding.runtime === 'claude') {
      const parent = inspectedClaudeParentIdentity(raw);
      if (parent === null) {
        if (binding.phase !== 'unbound' || nodes.length !== 1)
          throw new ObserverEvidenceError(
            'identity_conflict',
            'Capture requires exactly one unchanged parent source.',
          );
        verifyFinalState(binding.roots, inventory);
        return binding;
      }
      id = parent.session_id;
    } else {
      const rows = parseCompleteJsonl(placeholder, raw);
      const header = rows[0]?.value;
      const payload = header?.['payload'];
      if (
        header?.['type'] !== 'session_meta' ||
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      )
        throw new ObserverEvidenceError(
          'invalid_source',
          'Parent source lacks canonical session metadata.',
        );
      id = payload['id'] ?? payload['session_id'];
    }
    if (typeof id !== 'string' || !id)
      throw new ObserverEvidenceError(
        'invalid_source',
        'Source has no canonical session identity.',
      );
    const source = { ...placeholder, expected_session_id: id };
    indexBoundObserverSource(binding, source, raw);
    candidates.push({
      source,
      root_id: node.root_id,
      relative_path: node.path,
      device: node.device,
      inode: node.inode,
      parent_link: null,
    });
  }
  if (candidates.length !== 1)
    throw new ObserverEvidenceError(
      'identity_conflict',
      'Capture requires exactly one unchanged parent source.',
    );
  const parent = candidates[0];
  if (!parent)
    throw new ObserverEvidenceError(
      'invalid_source',
      'Capture requires its bound parent source.',
    );
  if (
    binding.phase === 'bound' &&
    JSON.stringify(binding.sources) !== JSON.stringify(candidates)
  )
    throw new ObserverEvidenceError(
      'identity_conflict',
      'Bound source identity or inventory changed.',
    );
  verifyFinalState(binding.roots, inventory);
  return validateObserverBinding({
    ...binding,
    phase: 'bound',
    parent_source_id: parent.source.source_id,
    sources: candidates,
  });
}
