import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseCodingAgentsDirective } from '../checks/index.ts';
import type { MatrixEntry, SkippedReason } from '../contracts/batch.ts';
import { readQuorumTier, readStoryStatus } from '../story-meta.ts';

// quorum run-all matrix construction. Ports build_matrix (run_all.py 93-166).
// Reuses Spec-1 parseCodingAgentsDirective + readQuorumTier/readStoryStatus.

export interface BuildMatrixArgs {
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly agentFilter?: readonly string[];
  readonly scenarioFilter?: readonly string[];
  readonly tierFilter?: 'sentinel' | 'full' | 'adhoc' | null;
  readonly includeDrafts?: boolean;
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

// Compute the (scenario × agent) matrix. Precedence directive > draft > tier;
// raises on an unknown agent/scenario filter name. Entries sorted by
// (scenario, agent) for deterministic output.
export function buildMatrix(args: BuildMatrixArgs): MatrixEntry[] {
  const {
    scenariosRoot,
    codingAgentsDir,
    agentFilter,
    scenarioFilter,
    tierFilter = null,
    includeDrafts = false,
  } = args;

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

  const entries: MatrixEntry[] = [];
  for (const scenarioDir of scenarioDirs) {
    const directive = parseCodingAgentsDirective(
      join(scenarioDir, 'checks.sh'),
    );
    const storyPath = join(scenarioDir, 'story.md');
    const tier = readQuorumTier(storyPath);
    const status = readStoryStatus(storyPath);
    for (const agent of agents) {
      let skipped: SkippedReason;
      if (directive !== undefined && !directive.includes(agent)) {
        skipped = 'directive';
      } else if (status === 'draft' && !includeDrafts) {
        skipped = 'draft';
      } else if (tierFilter !== null && tier !== tierFilter) {
        skipped = 'tier';
      } else {
        skipped = null;
      }
      entries.push({
        scenario: basename(scenarioDir),
        codingAgent: agent,
        scenarioDir,
        skippedReason: skipped,
        tier,
        status,
      });
    }
  }
  entries.sort((a, b) => {
    if (a.scenario !== b.scenario) return a.scenario < b.scenario ? -1 : 1;
    if (a.codingAgent !== b.codingAgent)
      return a.codingAgent < b.codingAgent ? -1 : 1;
    return 0;
  });
  return entries;
}

// Just the `max_concurrency` integer cap parse, kept narrow so a malformed
// YAML (or absent key) is null rather than a throw (_agent_max_concurrency).
const MaxConcurrencyViewSchema = z.object({
  max_concurrency: z.number().int().nullable().optional(),
});

// An agent's optional max_concurrency cap from its YAML, or null when unset /
// unreadable (run_all.py _agent_max_concurrency). Agents whose backend
// rate-limits concurrent calls set this to 1 so run-all serializes them.
export function agentMaxConcurrency(
  codingAgentsDir: string,
  agent: string,
): number | null {
  let raw: unknown;
  try {
    raw = parseYaml(
      readFileSync(join(codingAgentsDir, `${agent}.yaml`), 'utf8'),
    );
  } catch {
    return null;
  }
  const view = MaxConcurrencyViewSchema.safeParse(raw ?? {});
  if (!view.success) return null;
  return view.data.max_concurrency ?? null;
}
