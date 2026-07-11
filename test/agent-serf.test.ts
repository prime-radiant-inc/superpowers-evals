import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ProvisionError } from '../src/agents/index.ts';
import { SerfAgent } from '../src/agents/serf.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// A serf.yaml-shaped config. binary defaults to `sh` (always on PATH) so the
// non-binary validations are reachable; tests override binary to probe the
// PATH check.
function serfConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    name: 'serf',
    runtime_family: 'serf',
    binary: 'sh',
    home_config_subdir: '.serf',
    session_log_dir: '${QUORUM_AGENT_HOME}/.serf/exports',
    session_log_glob: '*.json',
    normalizer: 'serf',
    required_env: ['SUPERPOWERS_ROOT'],
    os_support: ['linux'],
    max_time: '10m',
    model: 'anthropic/claude-sonnet-4-6',
    ...overrides,
  };
}

// Files SerfAgent.provision requires under SUPERPOWERS_ROOT (the --plugin-dir
// target, used un-staged like the claude adapter).
function stageSuperpowers(root: string): void {
  for (const rel of [
    '.claude-plugin/plugin.json',
    'hooks/hooks.json',
    'hooks/run-hook.cmd',
    'hooks/session-start',
    'skills/using-superpowers/SKILL.md',
    'skills/brainstorming/SKILL.md',
  ]) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '#\n');
  }
}

function withEnv(superpowersRoot: string | undefined, body: () => void): void {
  const prev = process.env['SUPERPOWERS_ROOT'];
  if (superpowersRoot === undefined) {
    delete process.env['SUPERPOWERS_ROOT'];
  } else {
    process.env['SUPERPOWERS_ROOT'] = superpowersRoot;
  }
  try {
    body();
  } finally {
    if (prev === undefined) {
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      process.env['SUPERPOWERS_ROOT'] = prev;
    }
  }
}

function withEnvValue(
  name: string,
  value: string | undefined,
  body: () => void,
): void {
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    body();
  } finally {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}

const openRouterCredential: Credential = {
  model: 'openrouter/@preset/serf-test',
  harnesses: ['serf'],
  api: 'openai-chat',
  auth: 'api-key',
  api_key_env: 'TASK3A_SERF_OPENROUTER_KEY',
  compat: {},
};

const openRouterCampaignCredential: Credential = {
  model: 'openrouter/@preset/serf-test',
  harnesses: ['serf'],
  api: 'openai-chat',
  base_url: 'https://openrouter.ai/api/v1',
  auth: 'api-key',
  api_key_env: 'OPENROUTER_API_KEY',
  compat: { tool_choice_auto_only: true },
  labels: {
    model: 'example/model',
    provider: 'example-provider',
    quantization: 'fp8',
    preset_id: '00000000-0000-4000-8000-000000000002',
    preset_version_id: '00000000-0000-4000-8000-000000000001',
    is_byok: false,
    catalog_as_of: '2026-07-11',
  },
};

test('provision creates the isolated config + exports dirs on success', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      const env = new SerfAgent(serfConfig()).provision(
        home,
        new FakeCommandRunner(),
      );
      expect(env).toEqual({});
      expect(existsSync(home.configDir)).toBe(true);
      expect(existsSync(join(home.configDir, 'exports'))).toBe(true);
    });
  } finally {
    cleanup();
  }
});

test('provision throws when the serf binary is not on PATH', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      const cfg = serfConfig({ binary: 'serf-not-a-real-binary-zzz' });
      expect(() =>
        new SerfAgent(cfg).provision(home, new FakeCommandRunner()),
      ).toThrow(ProvisionError);
    });
  } finally {
    cleanup();
  }
});

test('provision throws when SUPERPOWERS_ROOT is unset', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(undefined, () => {
      expect(() =>
        new SerfAgent(serfConfig()).provision(home, new FakeCommandRunner()),
      ).toThrow(/SUPERPOWERS_ROOT not set/);
    });
  } finally {
    cleanup();
  }
});

test('provision throws when SUPERPOWERS_ROOT is missing plugin files', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers-empty');
  mkdirSync(spRoot, { recursive: true });
  try {
    withEnv(spRoot, () => {
      expect(() =>
        new SerfAgent(serfConfig()).provision(home, new FakeCommandRunner()),
      ).toThrow(/missing required Superpowers plugin files/);
    });
  } finally {
    cleanup();
  }
});

test('provision validates the selected Serf key without returning its value', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  const apiKey = `task3a-${crypto.randomUUID()}`;
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      withEnvValue('TASK3A_SERF_OPENROUTER_KEY', apiKey, () => {
        const runner = new FakeCommandRunner();
        const result = new SerfAgent(serfConfig()).provision(
          home,
          runner,
          openRouterCredential,
        );
        expect(result).toEqual({});
        expect(JSON.stringify(result)).not.toContain(apiKey);
        expect(runner.calls).toEqual([]);
        expect(existsSync(join(home.configDir, 'providers.toml'))).toBe(false);
      });
    });
  } finally {
    cleanup();
  }
});

test('provision materializes credential-free model compat for an OpenRouter campaign', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  const apiKey = `task3a-${crypto.randomUUID()}`;
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      withEnvValue('OPENROUTER_API_KEY', apiKey, () => {
        const result = new SerfAgent(serfConfig()).provision(
          home,
          new FakeCommandRunner(),
          openRouterCampaignCredential,
        );
        const configPath = join(home.configDir, 'providers.toml');
        expect(result).toEqual({});
        expect(readFileSync(configPath, 'utf8')).toBe(
          'default = "openrouter"\n\n' +
            '[instances.openrouter]\n' +
            'type = "openrouter"\n' +
            'api_key = "$OPENROUTER_API_KEY"\n\n' +
            '[instances.openrouter.models."@preset/serf-test".compat]\n' +
            'tool_choice_auto_only = true\n',
        );
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
        expect(readFileSync(configPath, 'utf8')).not.toContain(apiKey);
      });
    });
  } finally {
    cleanup();
  }
});

test('provision rejects tool-choice compat outside the OpenRouter campaign profile', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      withEnvValue('TASK3A_SERF_OPENROUTER_KEY', 'test-key', () => {
        expect(() =>
          new SerfAgent(serfConfig()).provision(home, new FakeCommandRunner(), {
            ...openRouterCredential,
            compat: { tool_choice_auto_only: true },
          }),
        ).toThrow(/requires the Serf OpenRouter campaign profile/);
      });
    });
  } finally {
    cleanup();
  }
});

test('provision rejects a missing or empty selected Serf key before launch', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      withEnvValue('TASK3A_SERF_OPENROUTER_KEY', undefined, () => {
        expect(() =>
          new SerfAgent(serfConfig()).provision(
            home,
            new FakeCommandRunner(),
            openRouterCredential,
          ),
        ).toThrow(ProvisionError);
      });
      withEnvValue('TASK3A_SERF_OPENROUTER_KEY', '', () => {
        expect(() =>
          new SerfAgent(serfConfig()).provision(
            home,
            new FakeCommandRunner(),
            openRouterCredential,
          ),
        ).toThrow(ProvisionError);
      });
    });
  } finally {
    cleanup();
  }
});

test('provision rejects subscription and oauth Serf credentials before launch', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      for (const auth of ['subscription', 'oauth'] as const) {
        expect(() =>
          new SerfAgent(serfConfig()).provision(home, new FakeCommandRunner(), {
            ...openRouterCredential,
            auth,
          }),
        ).toThrow(ProvisionError);
      }
    });
  } finally {
    cleanup();
  }
});
