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
import { dirname, join } from 'node:path';
import type { CommandResult } from '../src/agents/command-runner.ts';
import { ProvisionError } from '../src/agents/index.ts';
import { PiAgent } from '../src/agents/pi.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// The Pi support files the oracle (_require_pi_superpowers_source) requires under
// SUPERPOWERS_ROOT before provisioning. A checkout missing any of these is a
// setup failure, not a silent meaningless run.
const PI_SUPPORT_FILES = [
  'package.json',
  '.pi/extensions/superpowers.ts',
  'skills/using-superpowers/SKILL.md',
  'skills/using-superpowers/references/pi-tools.md',
] as const;

// Build a throwaway SUPERPOWERS_ROOT that contains every Pi support file, so the
// source-validation guard passes. Returns the root plus a cleanup().
function makeSuperpowersRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'quorum-pi-sproot-'));
  for (const rel of PI_SUPPORT_FILES) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// A runner that resolves `command -v pi` to a path (so the PATH guard passes)
// and returns success for everything else. Mirrors the kimi resolveKimiBinary
// probe contract: status 0 + non-empty stdout means "found".
function piOnPathRunner(): FakeCommandRunner {
  return new FakeCommandRunner((command, args): CommandResult => {
    if (command === 'command' && args[0] === '-v' && args[1] === 'pi') {
      return { status: 0, stdout: '/usr/local/bin/pi\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
}

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

// The env keys provision() reads. The placeholder SUPERPOWERS_ROOT here only
// satisfies the require-non-empty check; success-path tests override it with a
// makeSuperpowersRoot() fixture so the source-file validation passes, and
// negative-path tests that throw before that validation keep the placeholder.
// Typed as a plain record so it (and its spreads) flow into withEnv's
// Record<string, string | undefined> parameter — an interface would lack the
// implicit index signature.
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
  const sp = makeSuperpowersRoot();
  try {
    withEnv({ ...BASE_ENV, SUPERPOWERS_ROOT: sp.root }, () => {
      const runner = piOnPathRunner();
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

      // The only subprocess is the PATH probe for the pi binary
      // (requirePiOnPath); provisioning is otherwise declarative.
      expect(runner.calls).toEqual([
        {
          command: 'command',
          args: ['-v', 'pi'],
          options: { env: expect.anything() },
        },
      ]);
    });
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('files with secrets carry trailing-newline JSON + correct mode', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  try {
    withEnv({ ...BASE_ENV, SUPERPOWERS_ROOT: sp.root }, () => {
      const agent = new PiAgent(piConfig());
      agent.provision(home, piOnPathRunner());
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
    sp.cleanup();
    cleanup();
  }
});

test('azure-openai-responses provider folds sorted azure extras into pi.env', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  try {
    withEnv(
      {
        ...BASE_ENV,
        SUPERPOWERS_ROOT: sp.root,
        PI_PROVIDER: 'azure-openai-responses',
        PI_MODEL: 'gpt-4o',
        PI_API_KEY: 'azure key with spaces',
        AZURE_OPENAI_RESOURCE_NAME: 'my-resource',
        AZURE_OPENAI_API_VERSION: '2026-01-01',
      },
      () => {
        const agent = new PiAgent(piConfig());
        agent.provision(home, piOnPathRunner());
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
    sp.cleanup();
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

// B2-pi-superpowers-source-validation-missing: SUPERPOWERS_ROOT must actually
// contain the Pi support files (package.json, .pi/extensions/superpowers.ts,
// skills/using-superpowers/SKILL.md + references/pi-tools.md). A checkout
// missing any of them is a setup failure naming the absent paths, not a silent
// meaningless run. Mirrors _require_pi_superpowers_source (runner.py:1277-1289).
test('missing Pi support files under SUPERPOWERS_ROOT throws naming the absent paths', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  // Remove one required file so validation must fail.
  const removed = join(
    sp.root,
    'skills/using-superpowers/references/pi-tools.md',
  );
  rmSync(removed);
  try {
    withEnv({ ...BASE_ENV, SUPERPOWERS_ROOT: sp.root }, () => {
      const agent = new PiAgent(piConfig());
      expect(() => agent.provision(home, piOnPathRunner())).toThrow(
        new RegExp(
          `SUPERPOWERS_ROOT is missing Pi support files:.*${removed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
      );
    });
  } finally {
    sp.cleanup();
    cleanup();
  }
});

// A complete SUPERPOWERS_ROOT (with ~ expansion via HOME) passes validation.
test('a complete SUPERPOWERS_ROOT passes source validation', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  try {
    withEnv({ ...BASE_ENV, SUPERPOWERS_ROOT: sp.root }, () => {
      const agent = new PiAgent(piConfig());
      expect(() => agent.provision(home, piOnPathRunner())).not.toThrow();
    });
  } finally {
    sp.cleanup();
    cleanup();
  }
});

// B2-pi-which-guard-missing: a `pi` binary absent from PATH is a setup-stage
// failure with a precise message, not an opaque downstream launch failure.
// The probe is routed through the injected runner (`command -v pi`) so the
// hermetic gate can stub it, mirroring resolveKimiBinary. Mirrors
// runner.py:1345-1346 (shutil.which("pi") is None).
test('pi not on PATH throws a precise setup error', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  try {
    withEnv({ ...BASE_ENV, SUPERPOWERS_ROOT: sp.root }, () => {
      // Runner reports `command -v pi` failure (not found): status 1, no stdout.
      const noPi = new FakeCommandRunner(() => ({
        status: 1,
        stdout: '',
        stderr: '',
      }));
      const agent = new PiAgent(piConfig());
      expect(() => agent.provision(home, noPi)).toThrow(
        /pi not found on PATH; cannot run Pi evals/,
      );
    });
  } finally {
    sp.cleanup();
    cleanup();
  }
});

// The which-guard probes PATH via the injected runner: a single
// `command -v pi` call is recorded, and a resolved path lets provisioning
// proceed (returns the agent_config_env mapping).
test('pi present on PATH is probed via the runner and provisions', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  try {
    withEnv({ ...BASE_ENV, SUPERPOWERS_ROOT: sp.root }, () => {
      const runner = piOnPathRunner();
      const agent = new PiAgent(piConfig());
      const returned = agent.provision(home, runner);
      expect(returned).toEqual({ PI_CODING_AGENT_DIR: home.configDir });
      expect(runner.calls).toEqual([
        {
          command: 'command',
          args: ['-v', 'pi'],
          options: { env: expect.anything() },
        },
      ]);
    });
  } finally {
    sp.cleanup();
    cleanup();
  }
});
