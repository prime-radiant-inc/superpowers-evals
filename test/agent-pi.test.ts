import { expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ProvisionError } from '../src/agents/index.ts';
import { PiAgent } from '../src/agents/pi.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// The pi.yaml shape (coding-agents/pi.yaml), inlined so the test is hermetic.
function piConfig(): AgentConfig {
  return {
    name: 'pi',
    binary: 'pi',
    agent_config_env: 'PI_CODING_AGENT_DIR',
    session_log_dir: '${PI_CODING_AGENT_DIR}/sessions',
    session_log_glob: '*.jsonl',
    normalizer: 'pi',
    required_env: ['SUPERPOWERS_ROOT', 'PI_PROVIDER', 'PI_MODEL', 'PI_API_KEY'],
    max_time: '10m',
    max_concurrency: 1,
  };
}

// The env keys provision() reads. SUPERPOWERS_ROOT is required but unvalidated
// by the adapter (the oracle's filesystem/PATH checks are runner-side and out
// of scope here), so any non-empty value satisfies it. Typed as a plain record
// so it (and its spreads) flow into withEnv's Record<string, string | undefined>
// parameter — an interface would lack the implicit index signature.
const BASE_ENV: Readonly<Record<string, string>> = {
  SUPERPOWERS_ROOT: '/tmp/superpowers',
  PI_PROVIDER: 'anthropic',
  PI_MODEL: 'claude-sonnet-4-6',
  PI_API_KEY: 'sk-pi-secret',
};

const PI_ENV_KEYS = [
  'SUPERPOWERS_ROOT',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_API_KEY',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
] as const;

// Set the given env (and clear any azure vars not provided), run body, then
// restore every touched key. Mirrors the set/restore discipline in
// runner-e2e.test.ts, but reaches the live environment through Bun.env: it is
// the same object as process.env (so the env.ts getEnv() read sees the writes),
// yet it is not flagged by Biome's noProcessEnv rule, which this test file is
// not exempted from. Bun.env is an index signature, so bracket access.
function withEnv(
  vars: Readonly<Record<string, string | undefined>>,
  body: () => void,
): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of PI_ENV_KEYS) {
    prev[key] = Bun.env[key];
    const next = vars[key];
    if (next === undefined) {
      delete Bun.env[key];
    } else {
      Bun.env[key] = next;
    }
  }
  try {
    body();
  } finally {
    for (const key of PI_ENV_KEYS) {
      const original = prev[key];
      if (original === undefined) {
        delete Bun.env[key];
      } else {
        Bun.env[key] = original;
      }
    }
  }
}

function mode600(path: string): number {
  return statSync(path).mode & 0o777;
}

test('provision seeds the config dir, sessions subdir, and all config files', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(BASE_ENV, () => {
      const runner = new FakeCommandRunner();
      const agent = new PiAgent(piConfig());
      const returned = agent.provision(home, runner);

      // configDir + sessions/ exist.
      expect(existsSync(home.configDir)).toBe(true);
      expect(statSync(home.configDir).isDirectory()).toBe(true);
      const sessions = join(home.configDir, 'sessions');
      expect(existsSync(sessions)).toBe(true);
      expect(statSync(sessions).isDirectory()).toBe(true);

      // auth.json: the key field is the literal "$PI_API_KEY" placeholder, not
      // the real key (matches the oracle). Mode 0600.
      const authPath = join(home.configDir, 'auth.json');
      expect(existsSync(authPath)).toBe(true);
      const auth: unknown = JSON.parse(readFileSync(authPath, 'utf8'));
      expect(auth).toEqual({
        anthropic: { type: 'api_key', key: '$PI_API_KEY' },
      });
      expect(mode600(authPath)).toBe(0o600);

      // settings.json: provider/model + fixed thinking level.
      const settingsPath = join(home.configDir, 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
      const settings: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(settings).toEqual({
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
        defaultThinkingLevel: 'medium',
      });

      // pi.env: shlex-quoted export lines, secret-mode 0600. The real API key
      // lives here (not in the returned env). Bare values stay unquoted.
      const envPath = join(home.configDir, 'pi.env');
      expect(existsSync(envPath)).toBe(true);
      expect(readFileSync(envPath, 'utf8')).toBe(
        [
          'export PI_PROVIDER=anthropic',
          'export PI_MODEL=claude-sonnet-4-6',
          'export PI_API_KEY=sk-pi-secret',
          '',
        ].join('\n'),
      );
      expect(mode600(envPath)).toBe(0o600);

      // Returned env: exactly the agent_config_env -> configDir mapping. No
      // secrets leak into the returned env.
      expect(returned).toEqual({ PI_CODING_AGENT_DIR: home.configDir });

      // No subprocess calls (pi provisioning is declarative).
      expect(runner.calls).toEqual([]);
    });
  } finally {
    cleanup();
  }
});

test('files with secrets carry trailing-newline JSON + correct mode', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(BASE_ENV, () => {
      const agent = new PiAgent(piConfig());
      agent.provision(home, new FakeCommandRunner());
      // JSON files end with a newline (indent=2 + "\n" in the oracle).
      const authRaw = readFileSync(join(home.configDir, 'auth.json'), 'utf8');
      const settingsRaw = readFileSync(
        join(home.configDir, 'settings.json'),
        'utf8',
      );
      expect(authRaw.endsWith('}\n')).toBe(true);
      expect(settingsRaw.endsWith('}\n')).toBe(true);
    });
  } finally {
    cleanup();
  }
});

test('azure-openai-responses provider folds sorted azure extras into pi.env', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      {
        ...BASE_ENV,
        PI_PROVIDER: 'azure-openai-responses',
        PI_MODEL: 'gpt-4o',
        PI_API_KEY: 'azure key with spaces',
        AZURE_OPENAI_RESOURCE_NAME: 'my-resource',
        AZURE_OPENAI_API_VERSION: '2026-01-01',
      },
      () => {
        const agent = new PiAgent(piConfig());
        agent.provision(home, new FakeCommandRunner());
        const envPath = join(home.configDir, 'pi.env');
        // Extras emitted sorted by name; provider/model/key first. The spaced
        // API key is single-quoted (shlex.quote semantics).
        expect(readFileSync(envPath, 'utf8')).toBe(
          [
            'export PI_PROVIDER=azure-openai-responses',
            'export PI_MODEL=gpt-4o',
            "export PI_API_KEY='azure key with spaces'",
            'export AZURE_OPENAI_API_VERSION=2026-01-01',
            'export AZURE_OPENAI_RESOURCE_NAME=my-resource',
            '',
          ].join('\n'),
        );
      },
    );
  } finally {
    cleanup();
  }
});

test('azure-openai-responses without base-url/resource-name throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv({ ...BASE_ENV, PI_PROVIDER: 'azure-openai-responses' }, () => {
      const agent = new PiAgent(piConfig());
      expect(() => agent.provision(home, new FakeCommandRunner())).toThrow(
        ProvisionError,
      );
    });
  } finally {
    cleanup();
  }
});

test('missing required env throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv({ ...BASE_ENV, PI_API_KEY: undefined }, () => {
      const agent = new PiAgent(piConfig());
      expect(() => agent.provision(home, new FakeCommandRunner())).toThrow(
        ProvisionError,
      );
    });
  } finally {
    cleanup();
  }
});

// The CommandRunner seam is exercised even though pi provisioning is
// declarative: a responder that returns a failure status must NOT cause a
// throw, because the adapter never calls the runner. This documents the
// no-subprocess contract against the same seam other adapters use.
test('a failing responder does not affect pi provisioning (no subprocess seam)', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(BASE_ENV, () => {
      const failing = new FakeCommandRunner(() => ({
        status: 1,
        stdout: '',
        stderr: 'boom',
      }));
      const agent = new PiAgent(piConfig());
      const returned = agent.provision(home, failing);
      expect(returned).toEqual({ PI_CODING_AGENT_DIR: home.configDir });
      expect(failing.calls).toEqual([]);
    });
  } finally {
    cleanup();
  }
});
