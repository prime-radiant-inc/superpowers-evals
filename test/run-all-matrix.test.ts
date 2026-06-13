import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatrixEntry } from '../src/contracts/batch.ts';
import { agentMaxConcurrency, buildMatrix } from '../src/run-all/matrix.ts';

interface ScenarioSpec {
  readonly name: string;
  readonly tier?: string;
  readonly status?: string;
  readonly directive?: string;
}

// Build a temp scenarios-root + coding-agents dir for a matrix test.
function fixture(
  scenarios: readonly ScenarioSpec[],
  agents: readonly string[],
): {
  scenariosRoot: string;
  codingAgentsDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'runall-matrix-'));
  const scenariosRoot = join(root, 'scenarios');
  const codingAgentsDir = join(root, 'coding-agents');
  mkdirSync(scenariosRoot, { recursive: true });
  mkdirSync(codingAgentsDir, { recursive: true });

  for (const scn of scenarios) {
    const dir = join(scenariosRoot, scn.name);
    mkdirSync(dir, { recursive: true });
    const front: string[] = [];
    if (scn.tier !== undefined) front.push(`quorum_tier: ${scn.tier}`);
    if (scn.status !== undefined) front.push(`status: ${scn.status}`);
    const story =
      front.length > 0 ? `---\n${front.join('\n')}\n---\nbody\n` : 'body\n';
    writeFileSync(join(dir, 'story.md'), story);
    const directiveLine =
      scn.directive !== undefined ? `# coding-agents: ${scn.directive}\n` : '';
    writeFileSync(
      join(dir, 'checks.sh'),
      `${directiveLine}pre() { :; }\npost() { :; }\n`,
    );
  }

  for (const agent of agents) {
    const body =
      agent === 'antigravity' ? 'max_concurrency: 1\n' : `name: ${agent}\n`;
    writeFileSync(
      join(codingAgentsDir, `${agent}.yaml`),
      `name: ${agent}\n${body}`,
    );
  }

  return { scenariosRoot, codingAgentsDir };
}

function reasonOf(
  entries: readonly MatrixEntry[],
  scenario: string,
  agent: string,
): MatrixEntry['skippedReason'] {
  const e = entries.find(
    (x) => x.scenario === scenario && x.codingAgent === agent,
  );
  if (e === undefined) throw new Error(`no cell ${scenario}/${agent}`);
  return e.skippedReason;
}

test('matrix enumerates every (scenario, agent) cell, sorted', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 'beta' }, { name: 'alpha' }],
    ['codex', 'claude'],
  );
  const m = buildMatrix({ scenariosRoot, codingAgentsDir });
  expect(m.map((e) => `${e.scenario}/${e.codingAgent}`)).toEqual([
    'alpha/claude',
    'alpha/codex',
    'beta/claude',
    'beta/codex',
  ]);
  // tier defaults to full, status to ready; the absolute scenarioDir is set.
  expect(m[0]?.tier).toBe('full');
  expect(m[0]?.status).toBe('ready');
  expect(m[0]?.scenarioDir).toContain('alpha');
});

test('directive excludes non-listed agents (skippedReason directive)', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 'only-claude', directive: 'claude' }],
    ['claude', 'codex'],
  );
  const m = buildMatrix({ scenariosRoot, codingAgentsDir });
  expect(reasonOf(m, 'only-claude', 'claude')).toBeNull();
  expect(reasonOf(m, 'only-claude', 'codex')).toBe('directive');
});

test('draft scenarios are skipped unless includeDrafts', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 'wip', status: 'draft' }],
    ['claude'],
  );
  expect(
    reasonOf(buildMatrix({ scenariosRoot, codingAgentsDir }), 'wip', 'claude'),
  ).toBe('draft');
  expect(
    reasonOf(
      buildMatrix({ scenariosRoot, codingAgentsDir, includeDrafts: true }),
      'wip',
      'claude',
    ),
  ).toBeNull();
});

test('tierFilter skips non-matching tiers', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [
      { name: 'quick', tier: 'sentinel' },
      { name: 'slow', tier: 'full' },
    ],
    ['claude'],
  );
  const m = buildMatrix({
    scenariosRoot,
    codingAgentsDir,
    tierFilter: 'sentinel',
  });
  expect(reasonOf(m, 'quick', 'claude')).toBeNull();
  expect(reasonOf(m, 'slow', 'claude')).toBe('tier');
});

test('precedence directive > draft > tier', () => {
  // A draft scenario whose directive also excludes codex, under a tier filter
  // that it also fails: codex must read "directive", claude "draft".
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 'multi', status: 'draft', tier: 'full', directive: 'claude' }],
    ['claude', 'codex'],
  );
  const m = buildMatrix({
    scenariosRoot,
    codingAgentsDir,
    tierFilter: 'sentinel',
  });
  // codex: excluded by directive (highest precedence), not "tier" nor "draft".
  expect(reasonOf(m, 'multi', 'codex')).toBe('directive');
  // claude: passes directive, but is a draft -> "draft" beats "tier".
  expect(reasonOf(m, 'multi', 'claude')).toBe('draft');
});

test('agentFilter narrows agents and rejects unknown names', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    ['claude', 'codex'],
  );
  const m = buildMatrix({
    scenariosRoot,
    codingAgentsDir,
    agentFilter: ['codex'],
  });
  expect(m.map((e) => e.codingAgent)).toEqual(['codex']);
  expect(() =>
    buildMatrix({ scenariosRoot, codingAgentsDir, agentFilter: ['ghost'] }),
  ).toThrow(/unknown coding-agent/);
});

test('scenarioFilter narrows scenarios and rejects unknown names', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 'a' }, { name: 'b' }],
    ['claude'],
  );
  const m = buildMatrix({
    scenariosRoot,
    codingAgentsDir,
    scenarioFilter: ['b'],
  });
  expect(m.map((e) => e.scenario)).toEqual(['b']);
  expect(() =>
    buildMatrix({ scenariosRoot, codingAgentsDir, scenarioFilter: ['nope'] }),
  ).toThrow(/unknown scenario/);
});

test('agentMaxConcurrency reads the YAML cap, null when unset', () => {
  const { codingAgentsDir } = fixture(
    [{ name: 's' }],
    ['claude', 'antigravity'],
  );
  expect(agentMaxConcurrency(codingAgentsDir, 'antigravity')).toBe(1);
  expect(agentMaxConcurrency(codingAgentsDir, 'claude')).toBeNull();
  expect(agentMaxConcurrency(codingAgentsDir, 'missing')).toBeNull();
});
