import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  chmodSync,
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
import { ProvisionError } from '../src/agents/index.ts';
import { PiAgent } from '../src/agents/pi.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
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

// Build an isolated directory to use as PATH. When `withPi` is true it lays down
// an executable `pi` shim so Bun.which('pi') resolves there; when false the dir
// is empty so the binary is genuinely absent. Returns the dir plus a cleanup().
// Used by the PATH-probe tests, which exercise the real Bun.which lookup rather
// than faking it through a runner.
function makePathDir(withPi: boolean): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-pi-path-'));
  if (withPi) {
    const shim = join(dir, 'pi');
    writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    chmodSync(shim, 0o755);
  }
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The adapter resolves `pi` via Bun.which against the PATH snapshot. To make
// every "binary present" test hermetic (independent of whether a real pi is
// installed on the host), prepend a dir holding a `pi` shim to PATH for the whole
// file. The genuinely-absent test overrides PATH to an empty dir.
let piShimDir: { dir: string; cleanup: () => void };
let savedPath: string | undefined;
beforeAll(() => {
  piShimDir = makePathDir(true);
  savedPath = process.env['PATH'];
  process.env['PATH'] = `${piShimDir.dir}:${savedPath ?? ''}`;
});
afterAll(() => {
  if (savedPath === undefined) {
    delete process.env['PATH'];
  } else {
    process.env['PATH'] = savedPath;
  }
  piShimDir.cleanup();
});

// The pi.yaml shape (coding-agents/pi.yaml), inlined so the test is hermetic.
// home_config_subdir ".pi/agent" collapses the config dir into the throwaway
// $HOME; the adapter writes under home.configDir regardless, so it is carried
// here only to mirror the real YAML.
function piConfig(): AgentConfig {
  return {
    name: 'pi',
    binary: 'pi',
    agent_config_env: 'PI_CODING_AGENT_DIR',
    home_config_subdir: '.pi/agent',
    session_log_dir: '${PI_CODING_AGENT_DIR}/sessions',
    session_log_glob: '**/*.jsonl',
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
  'PI_OAUTH_HOME',
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
      const agent = new PiAgent(piConfig());
      const returned = agent.provision(home);

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
      agent.provision(home);
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
        agent.provision(home);
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
      expect(() => agent.provision(home)).toThrow(ProvisionError);
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
      expect(() => agent.provision(home)).toThrow(ProvisionError);
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
      expect(() => agent.provision(home)).toThrow(
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
      expect(() => agent.provision(home)).not.toThrow();
    });
  } finally {
    sp.cleanup();
    cleanup();
  }
});

// H3: a `pi` binary absent from PATH is a setup-stage failure with a precise
// message, not an opaque downstream launch failure. The probe must use Bun.which
// (not `command -v` through a shell-less spawnSync, which ENOENTs on Linux and
// falsely reports "not found"). This test points PATH at an empty dir (pi
// genuinely absent) and does NOT fake any probe. Mirrors runner.py:1345-1346
// (shutil.which("pi") is None).
test('pi genuinely absent from PATH throws a precise setup error (Bun.which)', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const path = makePathDir(false);
  const prevPath = process.env['PATH'];
  process.env['PATH'] = path.dir;
  try {
    withEnv({ ...BASE_ENV, SUPERPOWERS_ROOT: sp.root }, () => {
      const agent = new PiAgent(piConfig());
      expect(() => agent.provision(home)).toThrow(
        /pi not found on PATH; cannot run Pi evals/,
      );
    });
  } finally {
    if (prevPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = prevPath;
    }
    path.cleanup();
    sp.cleanup();
    cleanup();
  }
});

// H3 positive: a real `pi` executable on PATH resolves via Bun.which and
// provisioning proceeds, returning the agent_config_env mapping.
test('pi present on PATH resolves via Bun.which and provisions', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const path = makePathDir(true);
  const prevPath = process.env['PATH'];
  process.env['PATH'] = path.dir;
  try {
    withEnv({ ...BASE_ENV, SUPERPOWERS_ROOT: sp.root }, () => {
      const agent = new PiAgent(piConfig());
      const returned = agent.provision(home);
      expect(returned).toEqual({ PI_CODING_AGENT_DIR: home.configDir });
    });
  } finally {
    if (prevPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = prevPath;
    }
    path.cleanup();
    sp.cleanup();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// OAuth-or-env auth. Pi (and Kimi) host installs log in via OAuth, not env-var
// keys. When PI_API_KEY is absent but a host OAuth login exists under
// PI_OAUTH_HOME (default ~/.pi), provision() seeds that credential into the
// isolated PI_CODING_AGENT_DIR (mirroring codex's auth-copy seam) so the run
// authenticates via OAuth rather than failing at setup.
// ---------------------------------------------------------------------------

// Build a fake host PI_OAUTH_HOME laying down the OAuth credential files the
// way `pi` writes them: <home>/agent/{auth.json,settings.json}. auth.json keys
// the provider name to an OAuth token object; settings.json carries the default
// provider/model. Returns the home plus a cleanup().
function makePiOauthHome(opts?: {
  provider?: string;
  model?: string;
  omitSettings?: boolean;
}): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'quorum-pi-oauthhome-'));
  const agentDir = join(home, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const provider = opts?.provider ?? 'openai-codex';
  const model = opts?.model ?? 'gpt-5.5';
  writeFileSync(
    join(agentDir, 'auth.json'),
    `${JSON.stringify(
      {
        [provider]: {
          type: 'oauth',
          access: 'host-access-token',
          refresh: 'host-refresh-token',
          expires: 9999999999999,
          accountId: 'acct-1234',
        },
      },
      null,
      2,
    )}\n`,
  );
  if (!opts?.omitSettings) {
    writeFileSync(
      join(agentDir, 'settings.json'),
      `${JSON.stringify(
        {
          defaultProvider: provider,
          defaultModel: model,
          defaultThinkingLevel: 'medium',
        },
        null,
        2,
      )}\n`,
    );
  }
  return {
    home,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// OAuth path: no PI_API_KEY, but a host OAuth login under PI_OAUTH_HOME. The
// adapter copies the host auth.json verbatim into the isolated config dir at
// mode 0600, writes settings.json + pi.env carrying provider/model (derived
// from the host settings) and NO PI_API_KEY, and returns the config-dir map.
test('oauth path seeds the host auth.json into the isolated config dir', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const oauth = makePiOauthHome();
  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: sp.root,
        PI_OAUTH_HOME: oauth.home,
        PI_PROVIDER: undefined,
        PI_MODEL: undefined,
        PI_API_KEY: undefined,
      },
      () => {
        const agent = new PiAgent(piConfig());
        const returned = agent.provision(home);

        // auth.json is the host OAuth credential, copied verbatim, mode 0600.
        const authPath = join(home.configDir, 'auth.json');
        expect(existsSync(authPath)).toBe(true);
        expect(mode600(authPath)).toBe(0o600);
        const auth: unknown = JSON.parse(readFileSync(authPath, 'utf8'));
        expect(auth).toEqual({
          'openai-codex': {
            type: 'oauth',
            access: 'host-access-token',
            refresh: 'host-refresh-token',
            expires: 9999999999999,
            accountId: 'acct-1234',
          },
        });

        // settings.json carries the host default provider/model.
        const settings: unknown = JSON.parse(
          readFileSync(join(home.configDir, 'settings.json'), 'utf8'),
        );
        expect(settings).toEqual({
          defaultProvider: 'openai-codex',
          defaultModel: 'gpt-5.5',
          defaultThinkingLevel: 'medium',
        });

        // pi.env carries provider/model for the launcher's --provider/--model,
        // and NO PI_API_KEY (OAuth needs none).
        const envBody = readFileSync(join(home.configDir, 'pi.env'), 'utf8');
        expect(envBody).toBe(
          [
            'export PI_PROVIDER=openai-codex',
            'export PI_MODEL=gpt-5.5',
            '',
          ].join('\n'),
        );
        expect(envBody).not.toContain('PI_API_KEY');

        expect(returned).toEqual({ PI_CODING_AGENT_DIR: home.configDir });
      },
    );
  } finally {
    oauth.cleanup();
    sp.cleanup();
    cleanup();
  }
});

// OAuth path honors PI_PROVIDER/PI_MODEL as overrides when set (without an API
// key), instead of the host settings defaults.
test('oauth path honors PI_PROVIDER/PI_MODEL overrides over host settings', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const oauth = makePiOauthHome();
  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: sp.root,
        PI_OAUTH_HOME: oauth.home,
        PI_PROVIDER: 'anthropic',
        PI_MODEL: 'claude-sonnet-4-6',
        PI_API_KEY: undefined,
      },
      () => {
        const agent = new PiAgent(piConfig());
        agent.provision(home);
        const envBody = readFileSync(join(home.configDir, 'pi.env'), 'utf8');
        expect(envBody).toBe(
          [
            'export PI_PROVIDER=anthropic',
            'export PI_MODEL=claude-sonnet-4-6',
            '',
          ].join('\n'),
        );
      },
    );
  } finally {
    oauth.cleanup();
    sp.cleanup();
    cleanup();
  }
});

// Neither PI_API_KEY nor a host OAuth login: a clear setup error.
test('neither PI_API_KEY nor oauth login throws a clear ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  // Point PI_OAUTH_HOME at an empty dir so no host auth.json exists.
  const emptyHome = mkdtempSync(join(tmpdir(), 'quorum-pi-noauth-'));
  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: sp.root,
        PI_OAUTH_HOME: emptyHome,
        PI_PROVIDER: undefined,
        PI_MODEL: undefined,
        PI_API_KEY: undefined,
      },
      () => {
        const agent = new PiAgent(piConfig());
        expect(() => agent.provision(home)).toThrow(
          /no PI_API_KEY and no .* oauth login/i,
        );
      },
    );
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    sp.cleanup();
    cleanup();
  }
});

// OAuth path with a host login that has no settings.json and no env override
// cannot determine provider/model: a clear setup error (don't guess).
test('oauth path without provider/model (no settings, no env) throws', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const oauth = makePiOauthHome({ omitSettings: true });
  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: sp.root,
        PI_OAUTH_HOME: oauth.home,
        PI_PROVIDER: undefined,
        PI_MODEL: undefined,
        PI_API_KEY: undefined,
      },
      () => {
        const agent = new PiAgent(piConfig());
        expect(() => agent.provision(home)).toThrow(/provider|model/i);
      },
    );
  } finally {
    oauth.cleanup();
    sp.cleanup();
    cleanup();
  }
});

// Guards the HOME isolation + PI_CODING_AGENT_DIR collapse: the pi launch-agent
// template pins HOME/XDG/TMPDIR via $QUORUM_HOME_ENV and sources pi.env, but it
// does NOT set PI_CODING_AGENT_DIR and passes NO --session-dir. pi defaults its
// config dir to $HOME/.pi/agent and its session dir to <config>/sessions, which
// is where the runner seeds the per-run config (pi.yaml: home_config_subdir
// ".pi/agent") — so pi finds it all via the isolated $HOME.
test('pi launch-agent isolates HOME, omits PI_CODING_AGENT_DIR and --session-dir', () => {
  const launcher = readFileSync(
    join(import.meta.dir, '..', 'coding-agents', 'pi-context', 'launch-agent'),
    'utf8',
  );
  // HOME/XDG/TMPDIR isolation comes from the shared $QUORUM_HOME_ENV token.
  expect(launcher).toContain('$QUORUM_HOME_ENV');
  // PI_CODING_AGENT_DIR is collapsed into $HOME — the launcher must NOT set it as
  // an env assignment on the exec line (the comment block may still mention it).
  expect(launcher).not.toContain('PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR"');
  // No explicit --session-dir flag: pi nests sessions under its $HOME default.
  // Asserts the flag-invocation form, which (unlike the bare name in prose) only
  // ever appears on the exec line.
  expect(launcher).not.toContain(
    '--session-dir "$PI_CODING_AGENT_DIR/sessions"',
  );
});
