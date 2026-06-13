import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotAgent } from '../src/agents/copilot.ts';
import { ProvisionError } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// The copilot.yaml config surface this adapter consumes. Mirrors
// coding-agents/copilot.yaml (only fields provision() reads matter here).
const CONFIG: AgentConfig = {
  name: 'copilot',
  binary: 'copilot',
  agent_config_env: 'COPILOT_HOME',
  session_log_dir: '${COPILOT_HOME}/session-state',
  session_log_glob: '**/events.jsonl',
  normalizer: 'copilot',
  required_env: ['SUPERPOWERS_ROOT'],
  max_time: '10m',
  max_concurrency: 1,
};

const PLUGIN_FILES: readonly string[] = [
  '.claude-plugin/plugin.json',
  'hooks/hooks.json',
  'hooks/run-hook.cmd',
  'hooks/session-start',
  'skills/using-superpowers/SKILL.md',
  'skills/brainstorming/SKILL.md',
  'skills/using-superpowers/references/copilot-tools.md',
];

// Build a fake SUPERPOWERS_ROOT carrying every required plugin file, plus the
// plugin.json content we later assert was copied verbatim into the home.
function makeSuperpowersRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'copilot-sproot-'));
  for (const rel of PLUGIN_FILES) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    const body =
      rel === '.claude-plugin/plugin.json'
        ? JSON.stringify({ name: 'superpowers', version: '0.0.0' })
        : `marker:${rel}\n`;
    writeFileSync(path, body);
  }
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Read-Bun.env is the sanctioned env handle (env.ts reads process.env, which
// Bun.env writes through). Biome's noProcessEnv allows Bun.env. We set the
// keys a test needs, run the body, then restore exactly (mirrors runner-e2e).
function withEnv(
  overrides: Readonly<Record<string, string | undefined>>,
  body: () => void,
): void {
  const keys = Object.keys(overrides);
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, Bun.env[key]);
    const next = overrides[key];
    if (next === undefined) {
      delete Bun.env[key];
    } else {
      Bun.env[key] = next;
    }
  }
  try {
    body();
  } finally {
    for (const key of keys) {
      const prev = previous.get(key);
      if (prev === undefined) {
        delete Bun.env[key];
      } else {
        Bun.env[key] = prev;
      }
    }
  }
}

// Auth-relevant env that must be cleared so a test's overrides are the only
// inputs to _resolve_copilot_auth_env (the host may legitimately carry tokens).
const AUTH_ENV_KEYS: readonly string[] = [
  'SUPERPOWERS_ROOT',
  'COPILOT_OFFLINE',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN',
  'COPILOT_MODEL',
];

function clearedAuthEnv(): Record<string, string | undefined> {
  const cleared: Record<string, string | undefined> = {};
  for (const key of AUTH_ENV_KEYS) {
    cleared[key] = undefined;
  }
  return cleared;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test('provision stages COPILOT_HOME, writes secret env file, and stages the plugin', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    const runner = new FakeCommandRunner();
    let returned: Record<string, string> = {};
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        returned = new CopilotAgent(CONFIG).provision(home, runner);
      },
    );

    // configDir and the oracle's subdirs exist.
    expect(existsSync(home.configDir)).toBe(true);
    for (const subdir of [
      '.quorum',
      '.cache',
      'logs',
      'plugins',
      'session-state',
    ]) {
      expect(statSync(join(home.configDir, subdir)).isDirectory()).toBe(true);
    }

    // The secret env file exists, has the exact shell-quoted content, mode 0600.
    const envFile = join(home.configDir, '.copilot-env');
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toBe(
      "COPILOT_GITHUB_TOKEN='ghp_test_token'\n",
    );
    expect(mode(envFile)).toBe(0o600);

    // The plugin tree is staged with required files; plugin.json copied verbatim.
    const pluginRoot = join(home.configDir, 'plugins', 'superpowers');
    for (const rel of PLUGIN_FILES) {
      expect(statSync(join(pluginRoot, rel)).isFile()).toBe(true);
    }
    const stagedPluginJson: unknown = JSON.parse(
      readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(stagedPluginJson).toEqual({ name: 'superpowers', version: '0.0.0' });

    // Returned env points the agent_config_env at the isolated home; no auth in it.
    expect(returned).toEqual({ COPILOT_HOME: home.configDir });
    expect(Object.keys(returned)).toEqual(['COPILOT_HOME']);

    // provision() runs no subprocess.
    expect(runner.calls).toEqual([]);
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision honors the GH_TOKEN fallback chain and quotes embedded quotes', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        GH_TOKEN: "tok'with'quotes",
      },
      () => {
        new CopilotAgent(CONFIG).provision(home, new FakeCommandRunner());
      },
    );
    const envFile = join(home.configDir, '.copilot-env');
    // _shell_single_quote turns ' into '\'' .
    expect(readFileSync(envFile, 'utf8')).toBe(
      "COPILOT_GITHUB_TOKEN='tok'\\''with'\\''quotes'\n",
    );
    expect(mode(envFile)).toBe(0o600);
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision writes sorted provider env when COPILOT_PROVIDER_BASE_URL is set', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_PROVIDER_BASE_URL: 'https://provider.example/v1',
        COPILOT_PROVIDER_API_KEY: 'sk-provider',
        COPILOT_PROVIDER_TYPE: 'openai',
      },
      () => {
        new CopilotAgent(CONFIG).provision(home, new FakeCommandRunner());
      },
    );
    const envFile = join(home.configDir, '.copilot-env');
    // Keys are sorted; all three provider values written shell-quoted.
    expect(readFileSync(envFile, 'utf8')).toBe(
      "COPILOT_PROVIDER_API_KEY='sk-provider'\n" +
        "COPILOT_PROVIDER_BASE_URL='https://provider.example/v1'\n" +
        "COPILOT_PROVIDER_TYPE='openai'\n",
    );
    expect(mode(envFile)).toBe(0o600);
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision throws ProvisionError when no auth is present', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    withEnv({ ...clearedAuthEnv(), SUPERPOWERS_ROOT: sp.root }, () => {
      expect(() =>
        new CopilotAgent(CONFIG).provision(home, new FakeCommandRunner()),
      ).toThrow(ProvisionError);
    });
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision throws ProvisionError when SUPERPOWERS_ROOT is unset', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      { ...clearedAuthEnv(), COPILOT_GITHUB_TOKEN: 'ghp_test_token' },
      () => {
        expect(() =>
          new CopilotAgent(CONFIG).provision(home, new FakeCommandRunner()),
        ).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when a required plugin file is missing', () => {
  const sp = makeSuperpowersRoot();
  // Remove one required file so staging-source verification fails.
  rmSync(join(sp.root, 'skills', 'brainstorming', 'SKILL.md'));
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        expect(() =>
          new CopilotAgent(CONFIG).provision(home, new FakeCommandRunner()),
        ).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision throws ProvisionError when offline lacks a provider base url', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_OFFLINE: 'true',
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        expect(() =>
          new CopilotAgent(CONFIG).provision(home, new FakeCommandRunner()),
        ).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
    sp.cleanup();
  }
});

// A separate test where the runner is wired with a failing responder confirms
// provision() never touches the runner: it must succeed regardless of what the
// responder would return (copilot provisioning shells out to nothing).
test('provision ignores the command runner entirely (failing responder is irrelevant)', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    const runner = new FakeCommandRunner(() => ({
      status: 1,
      stdout: '',
      stderr: 'should never be called',
    }));
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        const returned = new CopilotAgent(CONFIG).provision(home, runner);
        expect(returned).toEqual({ COPILOT_HOME: home.configDir });
      },
    );
    expect(runner.calls).toEqual([]);
  } finally {
    cleanup();
    sp.cleanup();
  }
});
