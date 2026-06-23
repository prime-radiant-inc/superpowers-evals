import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatrixEntry } from '../src/contracts/batch.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { limiterKey } from '../src/credentials/resolve.ts';
import { buildMatrix } from '../src/run-all/matrix.ts';

interface ScenarioSpec {
  readonly name: string;
  readonly tier?: string;
  readonly status?: string;
  readonly directive?: string;
}

interface AgentSpec {
  readonly name: string;
  readonly defaultCredential?: string;
  readonly runtimeFamily?: string;
  readonly osSupport?: string[];
}

// Build a temp scenarios-root + coding-agents dir for a matrix test.
function fixture(
  scenarios: readonly ScenarioSpec[],
  agents: readonly (string | AgentSpec)[],
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

  for (const agentArg of agents) {
    const agent = typeof agentArg === 'string' ? agentArg : agentArg.name;
    const defaultCred =
      typeof agentArg === 'object' ? agentArg.defaultCredential : undefined;
    const spec = typeof agentArg === 'object' ? agentArg : undefined;
    let body = `name: ${agent}\n`;
    if (defaultCred !== undefined) {
      body += `default_credential: ${defaultCred}\n`;
    }
    if (spec?.runtimeFamily !== undefined) {
      body += `runtime_family: ${spec.runtimeFamily}\n`;
    }
    if (spec?.osSupport !== undefined) {
      body += `os_support: [${spec.osSupport.join(', ')}]\n`;
    }
    writeFileSync(join(codingAgentsDir, `${agent}.yaml`), body);
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

test('buildMatrix sets credential and limiterKey for a credentialed agent', () => {
  // Agent claude has default_credential: "my_cred" which maps to a credential
  // with base_url and api. The entry's limiterKey must use limiterKey(cred, name).
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    [{ name: 'claude', defaultCredential: 'my_cred' }],
  );

  const cred: Credential = {
    model: 'claude-3-5-sonnet',
    harnesses: ['claude'],
    api: 'anthropic',
    base_url: 'https://api.example.com',
    auth: 'api-key',
    compat: {},
  };
  const credentials: Record<string, Credential> = { my_cred: cred };

  const m = buildMatrix({ scenariosRoot, codingAgentsDir, credentials });
  expect(m).toHaveLength(1);
  expect(m[0]?.credential).toBe('my_cred');
  expect(m[0]?.limiterKey).toBe(limiterKey(cred, 'my_cred'));
  // limiterKey = base_url|api = "https://api.example.com|anthropic"
  expect(m[0]?.limiterKey).toBe('https://api.example.com|anthropic');
});

test('buildMatrix sets limiterKey to agent name for credential-less agent', () => {
  // Agent codex has no default_credential. limiterKey must fall back to agent name.
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    ['codex'],
  );
  const m = buildMatrix({ scenariosRoot, codingAgentsDir, credentials: {} });
  expect(m).toHaveLength(1);
  expect(m[0]?.credential).toBe('');
  expect(m[0]?.limiterKey).toBe('codex');
});

test('buildMatrix: credentialed agent with missing credential falls back to agent name', () => {
  // Agent has default_credential but it is not in the credentials map.
  // Should fall back gracefully (credential missing -> treat as credential-less).
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    [{ name: 'claude', defaultCredential: 'nonexistent_cred' }],
  );
  const m = buildMatrix({ scenariosRoot, codingAgentsDir, credentials: {} });
  expect(m).toHaveLength(1);
  expect(m[0]?.credential).toBe('');
  expect(m[0]?.limiterKey).toBe('claude');
});

// --- Credential expansion tests (C2) ---

test('credentialFilter: two credentials × 1 agent × 1 scenario → 2 runnable rows', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    [{ name: 'claude', runtimeFamily: 'claude' }],
  );
  const credA: Credential = {
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
  };
  const credB: Credential = {
    model: 'm2',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
  };
  const credentials: Record<string, Credential> = {
    cred_a: credA,
    cred_b: credB,
  };
  const m = buildMatrix({
    scenariosRoot,
    codingAgentsDir,
    credentials,
    credentialFilter: ['cred_a', 'cred_b'],
  });
  expect(m).toHaveLength(2);
  expect(m.map((e) => e.credential).sort()).toEqual(['cred_a', 'cred_b']);
  for (const e of m) {
    expect(e.skippedReason).toBeNull();
  }
});

test('credentialFilter: credential whose harnesses omits the agent → skipped:harness (not error)', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    [{ name: 'claude', runtimeFamily: 'claude' }],
  );
  const cred: Credential = {
    model: 'm',
    harnesses: ['codex'], // does NOT include 'claude'
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
  };
  const credentials: Record<string, Credential> = { bad_cred: cred };
  const m = buildMatrix({
    scenariosRoot,
    codingAgentsDir,
    credentials,
    credentialFilter: ['bad_cred'],
  });
  expect(m).toHaveLength(1);
  expect(m[0]?.skippedReason).toBe('harness');
});

test('credentialFilter: credential with os_support:windows → skipped:os on linux run', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    [{ name: 'claude', runtimeFamily: 'claude' }],
  );
  const cred: Credential = {
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
    os_support: ['windows'],
  };
  const credentials: Record<string, Credential> = { win_cred: cred };
  const m = buildMatrix({
    scenariosRoot,
    codingAgentsDir,
    credentials,
    credentialFilter: ['win_cred'],
  });
  expect(m).toHaveLength(1);
  expect(m[0]?.skippedReason).toBe('os');
});

test('credentialFilter: agent with os_support:windows → skipped:os', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    [{ name: 'claude', runtimeFamily: 'claude', osSupport: ['windows'] }],
  );
  const cred: Credential = {
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
  };
  const credentials: Record<string, Credential> = { my_cred: cred };
  const m = buildMatrix({
    scenariosRoot,
    codingAgentsDir,
    credentials,
    credentialFilter: ['my_cred'],
  });
  expect(m).toHaveLength(1);
  expect(m[0]?.skippedReason).toBe('os');
});

test('no credentialFilter → one row per (scenario, agent) using default_credential', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    [{ name: 'claude', defaultCredential: 'def_cred' }],
  );
  const cred: Credential = {
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
  };
  const credentials: Record<string, Credential> = { def_cred: cred };
  const m = buildMatrix({ scenariosRoot, codingAgentsDir, credentials });
  expect(m).toHaveLength(1);
  expect(m[0]?.credential).toBe('def_cred');
  expect(m[0]?.skippedReason).toBeNull();
});

test('credentialFilter: unknown credential name throws', () => {
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    ['claude'],
  );
  expect(() =>
    buildMatrix({
      scenariosRoot,
      codingAgentsDir,
      credentials: {},
      credentialFilter: ['ghost_cred'],
    }),
  ).toThrow(/unknown credential/);
});

test('harness skip precedes os skip (precedence)', () => {
  // credential has wrong harness AND wrong os: must get 'harness' not 'os'
  const { scenariosRoot, codingAgentsDir } = fixture(
    [{ name: 's' }],
    [{ name: 'claude', runtimeFamily: 'claude' }],
  );
  const cred: Credential = {
    model: 'm',
    harnesses: ['codex'], // wrong harness
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
    os_support: ['windows'], // also wrong os
  };
  const credentials: Record<string, Credential> = { bad_cred: cred };
  const m = buildMatrix({
    scenariosRoot,
    codingAgentsDir,
    credentials,
    credentialFilter: ['bad_cred'],
  });
  expect(m[0]?.skippedReason).toBe('harness');
});
