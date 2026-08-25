import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkArmSuiteFiles } from '../src/campaign/arm-suite-check.ts';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'arm-suite-check-'));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

function check(root: string) {
  return checkArmSuiteFiles({
    repoRoot: root,
    codingAgentsDir: join(root, 'coding-agents'),
    credentialsPath: join(root, 'credentials.yaml'),
  });
}

const AGENT_YAML = [
  'name: claude',
  'runtime_family: claude',
  'binary: claude',
  'session_log_dir: .',
  "session_log_glob: '*'",
  'normalizer: claude',
  'home_config_subdir: .claude',
  'default_credential: opus_fx',
].join('\n');
const CREDENTIALS = [
  'opus_fx:',
  '  model: claude-opus-5',
  '  api: anthropic',
  '  auth: api-key',
  '  api_key_env: ANTHROPIC_API_KEY',
  '  harnesses: [claude]',
].join('\n');
const ARM = [
  'schema_version: 1',
  'name: claude_fx',
  'agent: claude',
  'credential: opus_fx',
  'superpowers: none',
].join('\n');
const SUITE = [
  'schema_version: 1',
  'name: compare_fx',
  'kind: exploratory',
  'budget_usd: 50',
  'comparisons:',
  '  - baseline: claude_fx',
  '    treatment: claude_fx',
  '    scenarios: [scn_a]',
  '    n: 1',
].join('\n');

test('missing arms/ and suites/ directories are tolerated (v1 has none yet)', () => {
  const root = repo({});
  expect(check(root)).toEqual({ ok: true, errors: [], warnings: [] });
});

test('valid arm + suite files cross-reference cleanly', () => {
  const root = repo({
    'arms/claude_fx.yaml': ARM,
    'suites/compare_fx.yaml': SUITE,
    'coding-agents/claude.yaml': AGENT_YAML,
    'credentials.yaml': CREDENTIALS,
  });
  const result = check(root);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});

test('arm cross-references fail loud', () => {
  const root = repo({
    'arms/bad.yaml': ARM.replace('agent: claude', 'agent: ghost').replace(
      'credential: opus_fx',
      'credential: ghost_cred',
    ),
    'coding-agents/claude.yaml': AGENT_YAML,
    'credentials.yaml': CREDENTIALS,
  });
  const result = check(root);
  expect(result.ok).toBe(false);
  expect(result.errors.join('\n')).toMatch(
    /agent 'ghost' has no coding-agents/,
  );
  expect(result.errors.join('\n')).toMatch(
    /credential 'ghost_cred' not in credentials/,
  );
});

test("an explicit arm credential must list the agent's harness family", () => {
  // Finding 10: harness compatibility is checked for every explicit arm
  // credential, not only agent default_credentials.
  const root = repo({
    'arms/claude_fx.yaml': ARM,
    'coding-agents/claude.yaml': AGENT_YAML,
    'credentials.yaml': CREDENTIALS.replace(
      'harnesses: [claude]',
      'harnesses: [codex]',
    ),
  });
  const result = check(root);
  expect(result.ok).toBe(false);
  expect(result.errors).toContain(
    "arms/claude_fx.yaml: credential 'opus_fx' does not list harness 'claude'",
  );
});

test('an invalid credential registry yields one marker, not cascades', () => {
  // Deferred-ledger repair: the registry parse error is checkCredentials'
  // diagnosis — arm/suite checking must not duplicate it, and must not
  // report every arm as credential-not-found against a registry that never
  // loaded.
  const root = repo({
    'arms/claude_fx.yaml': ARM,
    'coding-agents/claude.yaml': AGENT_YAML,
    'credentials.yaml': 'opus_fx:\n  model: 42\n  bogus: [',
  });
  const result = check(root);
  expect(result.ok).toBe(false);
  const flat = result.errors.join('\n');
  expect(flat).toMatch(/credential references not checked/);
  expect(flat).not.toMatch(/not in credentials/);
  expect(result.errors.filter((e) => /credential/.test(e))).toHaveLength(1);
});

test('a missing credential registry with arms present yields the same single marker', () => {
  const root = repo({
    'arms/claude_fx.yaml': ARM,
    'coding-agents/claude.yaml': AGENT_YAML,
  });
  const result = check(root);
  expect(result.ok).toBe(false);
  expect(result.errors.join('\n')).toMatch(/credential references not checked/);
  expect(result.errors.join('\n')).not.toMatch(/not in credentials/);
});

test('suite schema errors surface with the file name', () => {
  const root = repo({
    'suites/broken.yaml': SUITE.replace('budget_usd: 50', 'budget_usd: -5'),
  });
  const result = check(root);
  expect(result.ok).toBe(false);
  expect(result.errors.join('\n')).toMatch(/broken\.yaml/);
});

test('gating suite profile params validate against the registry', () => {
  const gating = [
    'schema_version: 1',
    'name: gate_fx',
    'kind: gating',
    'budget_usd: 850',
    'profile: release_gate_v1',
    'reserve: 2',
    'max_exposure_skew: 600',
    'profile_params:',
    '  alpha: 0.05',
    '  determinate_n_floor: 4',
    '  completion_divergence_max: 0.2',
    '  mde_by_scenario: { scn_a: 0.15 }',
    'comparisons:',
    '  - baseline: claude_fx',
    '    treatment: claude_fx2',
    '    scenarios: [scn_a]',
    '    n: 5',
    '    cells: { scn_a: { class: confirmatory } }',
  ].join('\n');
  const root = repo({
    'arms/claude_fx.yaml': ARM,
    'arms/claude_fx2.yaml': ARM.replace('name: claude_fx', 'name: claude_fx2'),
    'suites/gate_fx.yaml': gating,
    'coding-agents/claude.yaml': AGENT_YAML,
    'credentials.yaml': CREDENTIALS,
  });
  const okResult = check(root);
  expect(okResult.errors).toEqual([]);
  const badParams = gating.replace('alpha: 0.05', 'alpha: 2');
  const badRoot = repo({
    'arms/claude_fx.yaml': ARM,
    'arms/claude_fx2.yaml': ARM.replace('name: claude_fx', 'name: claude_fx2'),
    'suites/gate_fx.yaml': badParams,
    'coding-agents/claude.yaml': AGENT_YAML,
    'credentials.yaml': CREDENTIALS,
  });
  const badResult = check(badRoot);
  expect(badResult.ok).toBe(false);
  expect(badResult.errors.join('\n')).toMatch(/alpha/);
});

test('suite with arm references and no arm documents fails loud', () => {
  const root = repo({ 'suites/compare_fx.yaml': SUITE });
  const result = check(root);
  expect(result.ok).toBe(false);
  expect(result.errors.join('\n')).toMatch(/unknown arm 'claude_fx'/);
});

test('profile without profile_params fails on required fields', () => {
  const profileOnly = [
    'schema_version: 1',
    'name: gate_fx',
    'kind: gating',
    'budget_usd: 850',
    'profile: release_gate_v1',
    'reserve: 2',
    'max_exposure_skew: 600',
    'comparisons:',
    '  - baseline: claude_fx',
    '    treatment: claude_fx2',
    '    scenarios: [scn_a]',
    '    n: 5',
    '    cells: { scn_a: { class: confirmatory } }',
  ].join('\n');
  const root = repo({ 'suites/gate_fx.yaml': profileOnly });
  const result = check(root);
  expect(result.ok).toBe(false);
  expect(result.errors.join('\n')).toMatch(/alpha/);
  expect(result.errors.join('\n')).toMatch(/determinate_n_floor/);
});

test('profile_params without profile fails with a clear error', () => {
  const orphanParams = [
    'schema_version: 1',
    'name: compare_fx',
    'kind: exploratory',
    'budget_usd: 50',
    'profile_params:',
    '  alpha: 0.05',
    'comparisons:',
    '  - baseline: claude_fx',
    '    treatment: claude_fx',
    '    scenarios: [scn_a]',
    '    n: 1',
  ].join('\n');
  const root = repo({ 'suites/orphan.yaml': orphanParams });
  const result = check(root);
  expect(result.ok).toBe(false);
  expect(result.errors.join('\n')).toMatch(
    /profile_params set without a profile/,
  );
});
