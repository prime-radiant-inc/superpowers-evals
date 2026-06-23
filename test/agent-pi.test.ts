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
import type { Credential } from '../src/contracts/credential.ts';
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
    home_config_subdir: '.pi/agent',
    session_log_dir: '${QUORUM_AGENT_HOME}/.pi/agent/sessions',
    session_log_glob: '**/*.jsonl',
    normalizer: 'pi',
    required_env: ['SUPERPOWERS_ROOT'],
    os_support: ['linux'],
    max_time: '10m',
  };
}

// A minimal stub CommandRunner — pi provision() doesn't shell out, but the
// interface requires the arg.
const stubRunner = {
  run: () => ({ status: 0, stdout: '', stderr: '' }),
};

// The env keys provision() reads (after B2 rewrite only SUPERPOWERS_ROOT and
// PI_OAUTH_HOME remain; keep PI_API_KEY_FIXTURE for api-key credential tests).
const PI_ENV_KEYS = [
  'SUPERPOWERS_ROOT',
  'PI_OAUTH_HOME',
  'PI_API_KEY_FIXTURE',
] as const;

// Set the given env, run body, then restore every touched key.
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

// Build a synthetic api-key credential for the custom-endpoint (GLM/ollama) path.
function makeApiKeyCredential(overrides?: Partial<Credential>): Credential {
  return {
    model: 'glm-5.2-fp8',
    harnesses: ['pi'],
    api: 'openai-chat',
    base_url: 'https://example.com/v1',
    auth: 'api-key',
    api_key_env: 'PI_API_KEY_FIXTURE',
    compat: { thinking_format: 'zai' },
    ...overrides,
  };
}

// Build a synthetic oauth credential.
function makeOauthCredential(overrides?: Partial<Credential>): Credential {
  return {
    model: 'gpt-5.5',
    harnesses: ['pi'],
    api: 'openai-chat',
    auth: 'oauth',
    compat: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// B2: credential-driven api-key path (custom endpoint, e.g. GLM/ollama)
// ---------------------------------------------------------------------------

test('api-key credential: provision writes models.json with quorum provider', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential();
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'test-api-key-abc123' },
      () => {
        const agent = new PiAgent(piConfig());
        agent.provision(home, stubRunner, credential);

        const modelsPath = join(home.configDir, 'models.json');
        expect(existsSync(modelsPath)).toBe(true);
        const models: unknown = JSON.parse(readFileSync(modelsPath, 'utf8'));
        expect(models).toMatchObject({
          providers: {
            quorum: {
              baseUrl: 'https://example.com/v1',
              api: 'openai-completions',
              apiKey: 'test-api-key-abc123',
              models: [
                {
                  id: 'glm-5.2-fp8',
                  name: 'glm-5.2-fp8',
                  reasoning: true,
                  compat: {
                    thinkingFormat: 'zai',
                  },
                },
              ],
            },
          },
        });
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('api-key credential: models.json is mode 0600 and auth.json carries resolved key', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential();
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'resolved-secret-key' },
      () => {
        const agent = new PiAgent(piConfig());
        agent.provision(home, stubRunner, credential);

        const modelsPath = join(home.configDir, 'models.json');
        expect(mode600(modelsPath)).toBe(0o600);

        // auth.json must contain the RESOLVED key, not '$PI_API_KEY' placeholder.
        const authPath = join(home.configDir, 'auth.json');
        expect(existsSync(authPath)).toBe(true);
        expect(mode600(authPath)).toBe(0o600);
        const auth: unknown = JSON.parse(readFileSync(authPath, 'utf8'));
        expect(auth).toEqual({
          quorum: { type: 'api_key', key: 'resolved-secret-key' },
        });
        // Explicitly confirm the placeholder is NOT written.
        expect(JSON.stringify(auth)).not.toContain('$PI_API_KEY');
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('api-key credential: settings.json uses credential.model and quorum provider', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential();
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        agent.provision(home, stubRunner, credential);

        const settings: unknown = JSON.parse(
          readFileSync(join(home.configDir, 'settings.json'), 'utf8'),
        );
        expect(settings).toEqual({
          defaultProvider: 'quorum',
          defaultModel: 'glm-5.2-fp8',
          defaultThinkingLevel: 'medium',
        });
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('api-key credential: pi.env carries resolved key, not placeholder', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential();
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'actual-secret' },
      () => {
        const agent = new PiAgent(piConfig());
        agent.provision(home, stubRunner, credential);

        const envBody = readFileSync(join(home.configDir, 'pi.env'), 'utf8');
        expect(envBody).toContain('export PI_PROVIDER=quorum');
        expect(envBody).toContain('export PI_MODEL=glm-5.2-fp8');
        expect(envBody).toContain('export PI_API_KEY=actual-secret');
        expect(envBody).not.toContain('$PI_API_KEY');
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('api-key credential without thinking_format: reasoning omitted from models.json', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential({ compat: {} });
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        agent.provision(home, stubRunner, credential);

        const models: {
          providers: { quorum: { models: { reasoning?: boolean }[] } };
        } = JSON.parse(
          readFileSync(join(home.configDir, 'models.json'), 'utf8'),
        );
        const model = models.providers.quorum.models[0];
        // reasoning should not be set when no thinking_format in compat
        expect(model).not.toHaveProperty('reasoning');
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('api-key credential with max_tokens_field: compat.maxTokensField in models.json', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential({
    compat: { thinking_format: 'zai', max_tokens_field: 'max_tokens' },
  });
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        agent.provision(home, stubRunner, credential);

        const models: {
          providers: {
            quorum: { models: { compat: Record<string, unknown> }[] };
          };
        } = JSON.parse(
          readFileSync(join(home.configDir, 'models.json'), 'utf8'),
        );
        const [firstModel] = models.providers.quorum.models;
        const modelCompat = firstModel?.compat ?? {};
        expect(modelCompat['thinkingFormat']).toBe('zai');
        expect(modelCompat['maxTokensField']).toBe('max_tokens');
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('api-key credential: provision seeds config dir + sessions subdir', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential();
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        const returned = agent.provision(home, stubRunner, credential);

        expect(existsSync(home.configDir)).toBe(true);
        expect(statSync(home.configDir).isDirectory()).toBe(true);
        const sessions = join(home.configDir, 'sessions');
        expect(existsSync(sessions)).toBe(true);
        expect(statSync(sessions).isDirectory()).toBe(true);
        expect(returned).toEqual({});
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('api-key credential: unsupported api (gemini) throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential({ api: 'gemini' });
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        expect(() => agent.provision(home, stubRunner, credential)).toThrow(
          /gemini.*not supported|unsupported api.*gemini/i,
        );
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('api-key credential: unsupported api (anthropic) throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential({ api: 'anthropic' });
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        expect(() => agent.provision(home, stubRunner, credential)).toThrow(
          ProvisionError,
        );
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('api-key credential: missing base_url throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential({ base_url: undefined });
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        expect(() => agent.provision(home, stubRunner, credential)).toThrow(
          ProvisionError,
        );
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

test('undefined credential throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  try {
    withEnv({ SUPERPOWERS_ROOT: sp.root }, () => {
      const agent = new PiAgent(piConfig());
      expect(() => agent.provision(home, stubRunner, undefined)).toThrow(
        /pi requires a credential/i,
      );
    });
  } finally {
    sp.cleanup();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Structural guards (SUPERPOWERS_ROOT validation, pi on PATH)
// ---------------------------------------------------------------------------

// B2-pi-superpowers-source-validation-missing: SUPERPOWERS_ROOT must actually
// contain the Pi support files (package.json, .pi/extensions/superpowers.ts,
// skills/using-superpowers/SKILL.md + references/pi-tools.md). A checkout
// missing any of them is a setup failure naming the absent paths, not a silent
// meaningless run.
test('missing Pi support files under SUPERPOWERS_ROOT throws naming the absent paths', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential();
  // Remove one required file so validation must fail.
  const removed = join(
    sp.root,
    'skills/using-superpowers/references/pi-tools.md',
  );
  rmSync(removed);
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        expect(() => agent.provision(home, stubRunner, credential)).toThrow(
          new RegExp(
            `SUPERPOWERS_ROOT is missing Pi support files:.*${removed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          ),
        );
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

// A complete SUPERPOWERS_ROOT (with ~ expansion via HOME) passes validation.
test('a complete SUPERPOWERS_ROOT passes source validation', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential();
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        expect(() =>
          agent.provision(home, stubRunner, credential),
        ).not.toThrow();
      },
    );
  } finally {
    sp.cleanup();
    cleanup();
  }
});

// H3: a `pi` binary absent from PATH is a setup-stage failure with a precise
// message, not an opaque downstream launch failure.
test('pi genuinely absent from PATH throws a precise setup error (Bun.which)', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential();
  const path = makePathDir(false);
  const prevPath = process.env['PATH'];
  process.env['PATH'] = path.dir;
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        expect(() => agent.provision(home, stubRunner, credential)).toThrow(
          /pi not found on PATH; cannot run Pi evals/,
        );
      },
    );
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
// provisioning proceeds, returning an empty env map.
test('pi present on PATH resolves via Bun.which and provisions', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential = makeApiKeyCredential();
  const path = makePathDir(true);
  const prevPath = process.env['PATH'];
  process.env['PATH'] = path.dir;
  try {
    withEnv(
      { SUPERPOWERS_ROOT: sp.root, PI_API_KEY_FIXTURE: 'any-key' },
      () => {
        const agent = new PiAgent(piConfig());
        const returned = agent.provision(home, stubRunner, credential);
        expect(returned).toEqual({});
      },
    );
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
// OAuth credential path
// ---------------------------------------------------------------------------

// Build a fake host PI_OAUTH_HOME laying down the OAuth credential files the
// way `pi` writes them: <home>/agent/{auth.json,settings.json}.
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

// OAuth credential path: adapter copies the host auth.json verbatim into the
// isolated config dir at mode 0600, writes settings.json + pi.env carrying
// provider/model (from host settings) and NO PI_API_KEY.
// credential.model overrides the host defaultModel.
test('oauth credential: seeds host auth.json and uses credential.model', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const oauth = makePiOauthHome({ provider: 'openai-codex', model: 'gpt-5.5' });
  const credential = makeOauthCredential({ model: 'gpt-5.5-override' });
  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: sp.root,
        PI_OAUTH_HOME: oauth.home,
      },
      () => {
        const agent = new PiAgent(piConfig());
        const returned = agent.provision(home, stubRunner, credential);

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

        // settings.json: provider from host settings, model from credential.
        const settings: unknown = JSON.parse(
          readFileSync(join(home.configDir, 'settings.json'), 'utf8'),
        );
        expect(settings).toEqual({
          defaultProvider: 'openai-codex',
          defaultModel: 'gpt-5.5-override',
          defaultThinkingLevel: 'medium',
        });

        // pi.env carries provider/model, NO PI_API_KEY.
        const envBody = readFileSync(join(home.configDir, 'pi.env'), 'utf8');
        expect(envBody).toBe(
          [
            'export PI_PROVIDER=openai-codex',
            'export PI_MODEL=gpt-5.5-override',
            '',
          ].join('\n'),
        );
        expect(envBody).not.toContain('PI_API_KEY');

        expect(returned).toEqual({});
      },
    );
  } finally {
    oauth.cleanup();
    sp.cleanup();
    cleanup();
  }
});

// OAuth path: no host auth.json exists → clear setup error.
test('oauth credential: no host auth.json throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const emptyHome = mkdtempSync(join(tmpdir(), 'quorum-pi-noauth-'));
  const credential = makeOauthCredential();
  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: sp.root,
        PI_OAUTH_HOME: emptyHome,
      },
      () => {
        const agent = new PiAgent(piConfig());
        expect(() => agent.provision(home, stubRunner, credential)).toThrow(
          /no .* oauth login|no PI_API_KEY/i,
        );
      },
    );
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    sp.cleanup();
    cleanup();
  }
});

// OAuth path without settings.json and no host defaultProvider: clear error.
test('oauth credential: no host settings.json and no defaultProvider throws', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const oauth = makePiOauthHome({ omitSettings: true });
  const credential = makeOauthCredential();
  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: sp.root,
        PI_OAUTH_HOME: oauth.home,
      },
      () => {
        const agent = new PiAgent(piConfig());
        expect(() => agent.provision(home, stubRunner, credential)).toThrow(
          /provider/i,
        );
      },
    );
  } finally {
    oauth.cleanup();
    sp.cleanup();
    cleanup();
  }
});

// subscription credential throws (pi has no subscription path).
test('subscription credential throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  const sp = makeSuperpowersRoot();
  const credential: Credential = {
    model: 'some-model',
    harnesses: ['pi'],
    api: 'openai-chat',
    auth: 'subscription',
    compat: {},
  };
  try {
    withEnv({ SUPERPOWERS_ROOT: sp.root }, () => {
      const agent = new PiAgent(piConfig());
      expect(() => agent.provision(home, stubRunner, credential)).toThrow(
        ProvisionError,
      );
    });
  } finally {
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
