import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseCodingAgentsDirective } from '../checks/index.ts';
import type { MatrixEntry, SkippedReason } from '../contracts/batch.ts';
import type { Credential } from '../contracts/credential.ts';
import type {
  GridManifest,
  GridManifestCell,
} from '../contracts/grid-manifest.ts';
import { limiterKey as makeLimiterKey } from '../credentials/resolve.ts';
import { readQuorumTier, readStoryStatus } from '../story-meta.ts';

// quorum run-all matrix construction. Reuses parseCodingAgentsDirective +
// readQuorumTier/readStoryStatus.

export interface BuildMatrixArgs {
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly agentFilter?: readonly string[];
  readonly scenarioFilter?: readonly string[];
  readonly tierFilter?: 'sentinel' | 'full' | 'adhoc' | null;
  readonly includeDrafts?: boolean;
  // Loaded credentials map for resolving per-cell limiterKey + caps. Empty map
  // is valid (all agents fall back to per-agent limiterKey).
  readonly credentials?: Record<string, Credential>;
  // When set, expand each (scenario, agent) pair into one row per credential
  // name. Each name must exist in `credentials`. When absent, the existing
  // single-row-per-(scenario, agent) behavior is preserved (agent default_credential).
  readonly credentialFilter?: readonly string[];
}

// Validate that an option's path exists and is a directory, for --scenarios-root
// / --coding-agents-dir. Without this a missing/non-dir root surfaces only later
// as a raw ENOENT/ENOTDIR thrown from readdirSync; this produces a clean,
// actionable error that names the offending option and path upfront.
function requireDirectory(option: string, path: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`${option}: directory does not exist: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${option}: not a directory: ${path}`);
  }
}

// Narrow view for the fields buildMatrix needs from an agent YAML. Using a
// strict parse of AgentConfig would throw on minimal YAMLs (missing binary etc.);
// this schema reads only what is needed and is permissive of unknown keys.
const AgentViewSchema = z.object({
  name: z.string().optional(),
  default_credential: z.string().optional(),
  runtime_family: z.string().optional(),
  os_support: z.array(z.string()).optional(),
});

// Parse the narrow agent view from a YAML file, or return undefined on error.
function readAgentView(
  codingAgentsDir: string,
  agent: string,
): z.infer<typeof AgentViewSchema> | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(
      readFileSync(join(codingAgentsDir, `${agent}.yaml`), 'utf8'),
    );
  } catch {
    return undefined;
  }
  const view = AgentViewSchema.safeParse(raw ?? {});
  return view.success ? view.data : undefined;
}

// Read an agent's os_support from the narrow view, defaulting to ['linux'].
function readAgentOsSupport(codingAgentsDir: string, agent: string): string[] {
  return readAgentView(codingAgentsDir, agent)?.os_support ?? ['linux'];
}

// Sorted *.yaml stems under coding_agents_dir (_discover_agents).
function discoverAgents(codingAgentsDir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(codingAgentsDir)) {
    if (name.endsWith('.yaml')) {
      out.push(name.slice(0, -'.yaml'.length));
    }
  }
  out.sort();
  return out;
}

// The exported known-agent name list (sorted *.yaml stems) buildMatrix derives
// `available` from. The dashboard is a separate zero-harness-dep package: it
// bootstraps known agents from the grid manifest's `agents` (or, in results-only
// mode, from each `verdict.json`'s `coding_agent`), not from this list.
// Returns [] when the dir is missing/unreadable (a fresh checkout with no agents
// configured still serves an empty grid rather than throwing).
export function knownAgentNames(codingAgentsDir: string): readonly string[] {
  try {
    return discoverAgents(codingAgentsDir);
  } catch {
    return [];
  }
}

// Sorted scenario dirs (children with a story.md) — mirrors `quorum list`
// (_discover_scenarios). Returns absolute dir paths.
function discoverScenarios(scenariosRoot: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(scenariosRoot)) {
    const dir = join(scenariosRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, 'story.md'))) continue;
    out.push(dir);
  }
  out.sort();
  return out;
}

// Compute the (scenario × agent × credential) matrix. Precedence:
//   directive > draft > tier > harness > os
// Raises on an unknown agent/scenario/credential filter name. Entries sorted by
// (scenario, agent, credential) for deterministic output.
export function buildMatrix(args: BuildMatrixArgs): MatrixEntry[] {
  const {
    scenariosRoot,
    codingAgentsDir,
    agentFilter,
    scenarioFilter,
    tierFilter = null,
    includeDrafts = false,
    credentials = {},
    credentialFilter,
  } = args;

  // Validate both roots upfront so a missing/non-dir root fails with a clear
  // message instead of a raw ENOENT from readdirSync.
  requireDirectory('--scenarios-root', scenariosRoot);
  requireDirectory('--coding-agents-dir', codingAgentsDir);

  const available = discoverAgents(codingAgentsDir);
  let agents: string[];
  if (agentFilter !== undefined) {
    const unknown = agentFilter.filter((a) => !available.includes(a));
    if (unknown.length > 0) {
      throw new Error(
        `unknown coding-agent(s): ${unknown.join(', ')} (available: ${available.join(', ')})`,
      );
    }
    agents = available.filter((a) => agentFilter.includes(a));
  } else {
    agents = available;
  }

  let scenarioDirs = discoverScenarios(scenariosRoot);
  if (scenarioFilter !== undefined) {
    const availableScn = new Set(scenarioDirs.map((d) => basename(d)));
    const unknown = scenarioFilter.filter((s) => !availableScn.has(s));
    if (unknown.length > 0) {
      throw new Error(
        `unknown scenario(s): ${unknown.join(', ')} ` +
          `(available: ${[...availableScn].sort().join(', ')})`,
      );
    }
    scenarioDirs = scenarioDirs.filter((d) =>
      scenarioFilter.includes(basename(d)),
    );
  }

  // Validate credentialFilter names upfront.
  if (credentialFilter !== undefined) {
    const unknown = credentialFilter.filter((c) => !(c in credentials));
    if (unknown.length > 0) {
      throw new Error(
        `unknown credential(s): ${unknown.join(', ')} (available: ${Object.keys(credentials).sort().join(', ')})`,
      );
    }
  }

  // Pre-compute per-agent fields: default credential, runtime_family, os_support.
  // Parse each agent's YAML exactly once per agent (single readAgentView call).
  const agentDefaultCred = new Map<string, string>();
  const agentRuntimeFamily = new Map<string, string>();
  const agentOsSupport = new Map<string, string[]>();
  for (const agent of agents) {
    const view = readAgentView(codingAgentsDir, agent);
    const credName = view?.default_credential;
    const cred = credName !== undefined ? credentials[credName] : undefined;
    agentDefaultCred.set(
      agent,
      credName !== undefined && cred !== undefined ? credName : '',
    );
    agentRuntimeFamily.set(agent, view?.runtime_family ?? agent);
    agentOsSupport.set(agent, view?.os_support ?? ['linux']);
  }

  const entries: MatrixEntry[] = [];
  for (const scenarioDir of scenarioDirs) {
    const directive = parseCodingAgentsDirective(
      join(scenarioDir, 'checks.sh'),
    );
    const storyPath = join(scenarioDir, 'story.md');
    const tier = readQuorumTier(storyPath);
    const status = readStoryStatus(storyPath);
    for (const agent of agents) {
      // Determine the base skip reason from directive/draft/tier (no credential
      // information needed at this level).
      let baseSkip: SkippedReason;
      if (directive !== undefined && !directive.includes(agent)) {
        baseSkip = 'directive';
      } else if (status === 'draft' && !includeDrafts) {
        baseSkip = 'draft';
      } else if (tierFilter !== null && tier !== tierFilter) {
        baseSkip = 'tier';
      } else {
        baseSkip = null;
      }

      // Determine the set of (credentialName, credential | undefined) pairs
      // to expand over for this (scenario, agent) cell.
      const cellCreds: Array<readonly [string, Credential | undefined]> =
        credentialFilter !== undefined
          ? credentialFilter.map((c) => [c, credentials[c]] as const)
          : [
              [
                agentDefaultCred.get(agent) ?? '',
                credentials[agentDefaultCred.get(agent) ?? ''],
              ] as const,
            ];

      const family = agentRuntimeFamily.get(agent) ?? agent;
      const agentOs = agentOsSupport.get(agent) ?? ['linux'];

      for (const [credName, cred] of cellCreds) {
        // Compute the final skipped reason, honouring precedence.
        let skipped: SkippedReason = baseSkip;

        if (skipped === null && cred !== undefined) {
          // harness check: credential's harnesses must include the agent's family.
          if (!cred.harnesses.includes(family)) {
            skipped = 'harness';
          } else if (
            !agentOs.includes('linux') ||
            (cred.os_support !== undefined &&
              !cred.os_support.includes('linux'))
          ) {
            // os check: both agent and credential (if constrained) must support linux.
            skipped = 'os';
          }
        }

        const limiter =
          cred !== undefined && credName !== ''
            ? makeLimiterKey(cred, credName)
            : agent;

        entries.push({
          scenario: basename(scenarioDir),
          codingAgent: agent,
          scenarioDir,
          skippedReason: skipped,
          tier,
          status,
          credential: credName,
          limiterKey: limiter,
        });
      }
    }
  }
  entries.sort((a, b) => {
    if (a.scenario !== b.scenario) return a.scenario < b.scenario ? -1 : 1;
    if (a.codingAgent !== b.codingAgent)
      return a.codingAgent < b.codingAgent ? -1 : 1;
    if (a.credential !== b.credential)
      return a.credential < b.credential ? -1 : 1;
    return 0;
  });
  return entries;
}

// Build the grid manifest: every (scenario, agent, os) cell with eligibility.
// `now` is stamped into generated_at; omit it (or pass '') in tests to keep the
// output deterministic. Task 2 will pass a real ISO timestamp.
export function buildGridManifest(
  args: BuildMatrixArgs,
  now = '',
): GridManifest {
  const entries = buildMatrix(args);
  const cells: GridManifestCell[] = [];

  for (const entry of entries) {
    const osList = readAgentOsSupport(args.codingAgentsDir, entry.codingAgent);
    for (const os of osList) {
      cells.push({
        scenario: entry.scenario,
        agent: entry.codingAgent,
        os,
        eligible: entry.skippedReason === null,
        skipped_reason: entry.skippedReason,
      });
    }
  }

  const scenarios = [...new Set(cells.map((c) => c.scenario))].sort();
  const agents = [...new Set(cells.map((c) => c.agent))].sort();

  return {
    generated_at: now,
    scenarios,
    agents,
    cells,
  };
}
