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
import { SERF_API_ENV_FILE_NAME, SerfAgent } from '../src/agents/serf.ts';
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

test('provision writes a private serf-api.env carrying exactly the selected name and value', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  const apiKey = `serf-file-${crypto.randomUUID()}`;
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      withEnvValue('TASK3A_SERF_OPENROUTER_KEY', apiKey, () => {
        new SerfAgent(serfConfig()).provision(
          home,
          new FakeCommandRunner(),
          openRouterCredential,
        );
        const envFile = join(home.configDir, SERF_API_ENV_FILE_NAME);
        expect(existsSync(envFile)).toBe(true);
        expect(statSync(envFile).mode & 0o777).toBe(0o600);
        // Exactly the selected env name with the single-quoted value — the
        // launcher sources this file and forwards only this name.
        expect(readFileSync(envFile, 'utf8')).toBe(
          `TASK3A_SERF_OPENROUTER_KEY='${apiKey}'\n`,
        );
      });
    });
  } finally {
    cleanup();
  }
});

test('provision serf-api.env uses the harness-conventional ANTHROPIC_API_KEY name when the credential does not override it', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  const apiKey = `serf-anthropic-${crypto.randomUUID()}`;
  stageSuperpowers(spRoot);
  const anthropicCredential: Credential = {
    model: 'anthropic/claude-sonnet-4-6',
    harnesses: ['serf'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
  };
  try {
    withEnv(spRoot, () => {
      withEnvValue('ANTHROPIC_API_KEY', apiKey, () => {
        new SerfAgent(serfConfig()).provision(
          home,
          new FakeCommandRunner(),
          anthropicCredential,
        );
        expect(
          readFileSync(join(home.configDir, SERF_API_ENV_FILE_NAME), 'utf8'),
        ).toBe(`ANTHROPIC_API_KEY='${apiKey}'\n`);
      });
    });
  } finally {
    cleanup();
  }
});

test('provision without a credential writes no serf-api.env', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      new SerfAgent(serfConfig()).provision(home, new FakeCommandRunner());
      expect(existsSync(join(home.configDir, SERF_API_ENV_FILE_NAME))).toBe(
        false,
      );
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

// ---------------------------------------------------------------------------
// Kernel D2: home.superpowers threading (root / none / legacy undefined).
// ---------------------------------------------------------------------------

test('superpowers root mode stages from the threaded root, not ambient env', () => {
  const { home: plainHome, cleanup } = makeTempHome();
  const spA = join(plainHome.workdir, '..', 'sp-d2-threaded');
  const ambient = join(plainHome.workdir, '..', 'sp-d2-ambient');
  mkdirSync(spA, { recursive: true });
  stageSuperpowers(spA);
  // An ambient root missing every required file: consulting it would throw.
  mkdirSync(ambient, { recursive: true });
  const home = {
    ...plainHome,
    superpowers: { mode: 'root', root: spA } as const,
  };

  try {
    withEnv(ambient, () => {
      const env = new SerfAgent(serfConfig()).provision(
        home,
        new FakeCommandRunner(),
      );
      // Provision succeeded validating the threaded root, not the invalid
      // ambient one.
      expect(env).toEqual({});
    });
  } finally {
    cleanup();
  }
});

test('superpowers none mode runs zero superpowers staging', () => {
  const { home, cleanup } = makeTempHome({
    superpowers: { mode: 'none' },
  });
  const apiKey = `d2-serf-${crypto.randomUUID()}`;

  try {
    withEnv(undefined, () => {
      withEnvValue('TASK3A_SERF_OPENROUTER_KEY', apiKey, () => {
        const env = new SerfAgent(serfConfig()).provision(
          home,
          new FakeCommandRunner(),
          openRouterCredential,
        );
        // No ProvisionError; the stock arm still seeds the credential env file.
        expect(env).toEqual({});
        expect(existsSync(join(home.configDir, SERF_API_ENV_FILE_NAME))).toBe(
          true,
        );
      });
    });
  } finally {
    cleanup();
  }
});

test('superpowers undefined spec keeps the legacy missing-root ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(undefined, () => {
      expect(() =>
        new SerfAgent(serfConfig()).provision(home, new FakeCommandRunner()),
      ).toThrow(
        'SUPERPOWERS_ROOT not set; cannot point serf --plugin-dir at Superpowers',
      );
    });
  } finally {
    cleanup();
  }
});
