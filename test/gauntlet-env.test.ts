import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  GAUNTLET_ENV_ALLOWLIST,
  gauntletEnvBase,
} from '../src/runner/gauntlet-env.ts';
import { runScenario } from '../src/runner/index.ts';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

// --- pure projection --------------------------------------------------------

test('gauntletEnvBase drops the provider bundle and keeps the grader credential', () => {
  const hostile: Record<string, string> = {
    OPENAI_API_KEY: 'sk-host-openai',
    OPENAI_BASE_URL: 'http://evil.example',
    GEMINI_API_KEY: 'sk-host-gemini',
    KIMI_MODEL_API_KEY: 'sk-host-kimi',
    AWS_SECRET_ACCESS_KEY: 'host-aws',
    AWS_BEARER_TOKEN_BEDROCK: 'host-bedrock',
    GH_TOKEN: 'host-gh',
    ANTHROPIC_API_KEY: 'sk-grader',
    PATH: '/usr/bin:/bin',
    TMUX_TMPDIR: '/tmp/tmux',
  };
  const env = gauntletEnvBase(hostile);
  expect(env['OPENAI_API_KEY']).toBeUndefined();
  expect(env['GEMINI_API_KEY']).toBeUndefined();
  expect(env['KIMI_MODEL_API_KEY']).toBeUndefined();
  expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  expect(env['AWS_BEARER_TOKEN_BEDROCK']).toBeUndefined();
  expect(env['GH_TOKEN']).toBeUndefined();
  expect(env['OPENAI_BASE_URL']).toBeUndefined();
  expect(env['ANTHROPIC_API_KEY']).toBe('sk-grader');
  expect(env['PATH']).toBe('/usr/bin:/bin');
  expect(env['TMUX_TMPDIR']).toBe('/tmp/tmux');
});

test('GAUNTLET_ENV_ALLOWLIST carries at most the grader credential names', () => {
  // The credential names are enumerated deliberately, never by pattern: exactly
  // the three names gauntlet's Anthropic auth resolution reads
  // (resolveAnthropicAuth: CLAUDE_CODE_OAUTH_TOKEN || ANTHROPIC_AUTH_TOKEN ||
  // ANTHROPIC_API_KEY). Any other secret-shaped name is a leak.
  const secretish = GAUNTLET_ENV_ALLOWLIST.filter((n) =>
    /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(n),
  );
  expect(secretish.sort()).toEqual(
    [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ].sort(),
  );
});

// --- runner wiring (real spawn seam) ----------------------------------------

const MOCK = resolve(import.meta.dir, 'mock-gauntlet');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

function makeScenario(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-genv-'));
  writeFileSync(
    join(dir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  writeFileSync(join(dir, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(dir, 'setup.sh'), 0o755);
  writeFileSync(join(dir, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return dir;
}

// Drive the REAL runScenario with the mock gauntlet on PATH and a hostile host
// env, then read back the exact env the spawned gauntlet child received (the
// mock dumps it to mock-gauntlet-env.json in the run dir). This exercises the
// structured spawn seam — spawnGauntlet's env composition — not a rendered
// command line.
test('the spawned gauntlet child gets the projection, not the host env', async () => {
  const scenarioDir = makeScenario();
  const outRoot = mkdtempSync(join(tmpdir(), 'out-genv-'));
  const hostileKeys = [
    'PATH',
    'ANTHROPIC_API_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'SUPERPOWERS_ROOT',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'KIMI_MODEL_API_KEY',
  ] as const;
  const saved = hostileKeys.map((k) => [k, process.env[k]] as const);
  process.env['PATH'] =
    `${mockGauntletDir('pass')}:${MOCK}:${process.env['PATH'] ?? ''}`;
  // The grader credential: the ONLY secret that may cross into the child.
  process.env['ANTHROPIC_API_KEY'] = 'sk-grader-e2e';
  // The coding agent's own provider credential (claude.yaml's opus_bedrock
  // default resolves it at provision time). It must reach the env FILE the
  // launcher sources — never the gauntlet child env.
  process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'bedrock-key-test';
  process.env['SUPERPOWERS_ROOT'] = mkdtempSync(join(tmpdir(), 'sproot-'));
  // Hostile provider bundle names that a full-snapshot spread would leak.
  process.env['OPENAI_API_KEY'] = 'sk-host-openai';
  process.env['GEMINI_API_KEY'] = 'sk-host-gemini';
  process.env['KIMI_MODEL_API_KEY'] = 'sk-host-kimi';
  let runDir: string | undefined;
  try {
    const { verdict } = await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: REAL_CODING_AGENTS,
      outRoot,
      onRunDir: (dir) => {
        runDir = dir;
      },
    });
    expect(verdict.final).toBe('pass');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
  if (runDir === undefined) {
    throw new Error('onRunDir never fired');
  }
  const child = JSON.parse(
    readFileSync(join(runDir, 'mock-gauntlet-env.json'), 'utf8'),
  ) as Record<string, string | undefined>;
  // Hostile provider bundle: absent.
  expect(child['OPENAI_API_KEY']).toBeUndefined();
  expect(child['GEMINI_API_KEY']).toBeUndefined();
  expect(child['KIMI_MODEL_API_KEY']).toBeUndefined();
  // The coding agent's own provider credential: absent from the child env.
  expect(child['AWS_BEARER_TOKEN_BEDROCK']).toBeUndefined();
  // The grader credential arrives.
  expect(child['ANTHROPIC_API_KEY']).toBe('sk-grader-e2e');
  // The runner's explicit overlays survive the projection.
  expect(child['QUORUM_AGENT_CWD']).toBeDefined();
  expect(child['QUORUM_AGENT_HOME']).toBeDefined();
  // The fixture selection rode in via the generated shim, not the host env.
  expect(child['MOCK_GAUNTLET_FIXTURE']).toBe('pass');
});
