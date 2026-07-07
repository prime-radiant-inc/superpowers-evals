import { expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CodexAgent, writePrivateFileNoFollow } from '../src/agents/codex.ts';
import {
  type AppServerClient,
  type AppServerHook,
  type AppServerSpawn,
  type ReadHookArgs,
  SpawnAppServerClient,
} from '../src/agents/codex-app-server.ts';
import { ProvisionError } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// A codex.yaml-shaped config (mirrors coding-agents/codex.yaml). The fields the
// adapter reads are home_config_subdir and required_env. required_env no longer
// carries OPENAI_API_KEY (codex uses ChatGPT subscription auth).
const CODEX_CONFIG: AgentConfig = {
  name: 'codex',
  binary: 'codex',
  home_config_subdir: '.codex',
  session_log_dir: '${QUORUM_AGENT_HOME}/.codex/sessions',
  session_log_glob: '**/rollout-*.jsonl',
  normalizer: 'codex',
  required_env: ['SUPERPOWERS_ROOT'],
  os_support: ['linux'],
  max_time: '10m',
};

// A canned app-server hooks/list response carrying exactly one superpowers@debug
// SessionStart hook with the shape selectSuperpowersHook accepts. Used to drive
// the real SpawnAppServerClient through a fake spawn (selector + config-write
// integration), so provision exercises the genuine app-server read path.
function appServerStdout(): string {
  const initializeReply = { jsonrpc: '2.0', id: 1, result: {} };
  const hooksListReply = {
    jsonrpc: '2.0',
    id: 2,
    result: {
      data: [
        {
          hooks: [
            {
              pluginId: 'superpowers@debug',
              source: 'plugin',
              eventName: 'sessionStart',
              matcher: 'startup|clear|compact',
              command: 'bash .claude/hooks/run-hook.cmd session-start',
              trustStatus: 'untrusted',
              key: 'superpowers@debug:sessionStart',
              currentHash: 'abc123def456',
            },
          ],
        },
      ],
    },
  };
  return `${JSON.stringify(initializeReply)}\n${JSON.stringify(hooksListReply)}\n`;
}

// The hook the happy-path FakeAppServerClient returns.
const HAPPY_HOOK: AppServerHook = {
  key: 'superpowers@debug:sessionStart',
  currentHash: 'abc123def456',
};

// Test double for the bounded app-server read seam. Records every readHook call
// (so tests can assert the configDir/workdir/timeout the agent passes) and
// returns a canned hook — or throws, to model a selection/timeout failure.
class FakeAppServerClient implements AppServerClient {
  readonly calls: ReadHookArgs[] = [];
  private readonly outcome: AppServerHook | (() => never);
  constructor(outcome: AppServerHook | (() => never) = HAPPY_HOOK) {
    this.outcome = outcome;
  }
  readHook(args: ReadHookArgs): AppServerHook {
    this.calls.push(args);
    if (typeof this.outcome === 'function') {
      return this.outcome();
    }
    return this.outcome;
  }
}

// A real SpawnAppServerClient backed by a fake spawn returning `stdout`, so the
// genuine parse/select + config-write path runs without spawning codex.
function spawnBackedClient(stdout: string): SpawnAppServerClient {
  const spawn: AppServerSpawn = () => ({
    status: 0,
    stdout,
    stderr: '',
    timedOut: false,
  });
  return new SpawnAppServerClient(spawn);
}

// Stage a SUPERPOWERS_ROOT the adapter can copytree (one staged file proves the
// plugin copy ran) plus the dirs the copy filter must drop.
function stageSuperpowers(root: string): void {
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'a-skill.md'), '# skill\n');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg.txt'), 'x\n');
}

// Default ChatGPT subscription auth.json contents the adapter accepts.
const SUBSCRIPTION_AUTH = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: { refresh_token: 'r' },
} as const;

// Default subscription credential passed to all pre-B4 tests so provision()
// takes the subscription branch (the only path these tests exercise).
const SUBSCRIPTION_CRED: Credential = {
  model: 'codex-sub',
  harnesses: ['codex'],
  api: 'openai-responses',
  auth: 'subscription',
  compat: {},
};

// Stage a host auth dir <authParent>/.codex/auth.json holding `auth`, point the
// adapter at it via CODEX_AUTH_HOME, set SUPERPOWERS_ROOT, and restore prior env
// even on throw. CODEX_AUTH_HOME is the adapter's test seam for the host
// ~/.codex location (homedir() ignores a mid-process $HOME change). When `auth`
// is undefined the .codex dir is created but no auth.json is written (missing
// case); a string is written verbatim (invalid-JSON case).
function withHostAuth(
  authParent: string,
  superpowersRoot: string,
  auth: unknown,
  body: () => void,
): void {
  const codexDir = join(authParent, '.codex');
  mkdirSync(codexDir, { recursive: true });
  if (auth !== undefined) {
    writeFileSync(
      join(codexDir, 'auth.json'),
      typeof auth === 'string' ? auth : `${JSON.stringify(auth)}\n`,
    );
  }
  const prevAuthHome = process.env['CODEX_AUTH_HOME'];
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  process.env['CODEX_AUTH_HOME'] = codexDir;
  process.env['SUPERPOWERS_ROOT'] = superpowersRoot;
  try {
    body();
  } finally {
    if (prevAuthHome === undefined) {
      delete process.env['CODEX_AUTH_HOME'];
    } else {
      process.env['CODEX_AUTH_HOME'] = prevAuthHome;
    }
    if (prevRoot === undefined) {
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      process.env['SUPERPOWERS_ROOT'] = prevRoot;
    }
  }
}

// The shared CommandRunner is unused by codex provisioning (auth is a file copy;
// the app-server has its own timed seam), but provision() requires the argument
// per the CodingAgent contract — so every test passes a recording runner and
// asserts it received zero calls.
function unusedRunner(): FakeCommandRunner {
  return new FakeCommandRunner();
}

test('provision copies subscription auth and stages the trusted plugin hook', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  // Drive the REAL SpawnAppServerClient via a fake spawn so the genuine
  // parse/select + trusted_hash config-write integration runs.
  const appServer = spawnBackedClient(appServerStdout());

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      const env = agent.provision(home, runner, SUBSCRIPTION_CRED);

      // Returned env is empty: codex finds CODEX_HOME via its $HOME/.codex
      // default, so no config-dir var is returned.
      expect(env).toEqual({});

      // Config dir exists and the host subscription auth was copied in, 0600.
      expect(existsSync(home.configDir)).toBe(true);
      const seeded = join(home.configDir, 'auth.json');
      expect(existsSync(seeded)).toBe(true);
      expect(JSON.parse(readFileSync(seeded, 'utf8'))).toEqual({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: { refresh_token: 'r' },
      });
      expect(statSync(seeded).mode & 0o777).toBe(0o600);

      // The staged plugin tree exists.
      const pluginRoot = join(
        home.configDir,
        'plugins',
        'cache',
        'debug',
        'superpowers',
        'local',
      );
      expect(existsSync(pluginRoot)).toBe(true);
      // The copytree carried a real file...
      expect(existsSync(join(pluginRoot, 'skills', 'a-skill.md'))).toBe(true);
      // ...and dropped the ignored dirs.
      expect(existsSync(join(pluginRoot, '.git'))).toBe(false);
      expect(existsSync(join(pluginRoot, 'node_modules'))).toBe(false);

      // config.toml: features + plugin enable, then the appended trusted_hash
      // block keyed on the hook the app-server reported.
      const configToml = readFileSync(
        join(home.configDir, 'config.toml'),
        'utf8',
      );
      expect(configToml).toContain('[features]');
      expect(configToml).toContain('plugins = true');
      expect(configToml).toContain('hooks = true');
      expect(configToml).toContain('plugin_hooks = true');
      expect(configToml).toContain('[plugins."superpowers@debug"]');
      expect(configToml).toContain('enabled = true');
      expect(configToml).toContain(
        '[hooks.state."superpowers@debug:sessionStart"]',
      );
      expect(configToml).toContain('trusted_hash = "abc123def456"');

      // Codex provisioning never touches the shared CommandRunner: auth is a
      // file copy and the app-server has its own bounded seam.
      expect(runner.calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

test('provision drives the app-server with the run cwd, CODEX_HOME, and a bounded deadline', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = new FakeAppServerClient();

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      agent.provision(home, runner, SUBSCRIPTION_CRED);
      // Exactly one bounded app-server read, scoped to the run's CODEX_HOME and
      // workdir, with a non-zero per-handshake deadline (no infinite block).
      expect(appServer.calls.length).toBe(1);
      const call = appServer.calls[0];
      expect(call?.configDir).toBe(home.configDir);
      expect(call?.workdir).toBe(home.workdir);
      expect(call?.timeoutMs).toBeGreaterThan(0);
    });
  } finally {
    cleanup();
  }
});

test('plugin copy drops the whole evals subtree at the root, keeping a results dir elsewhere', () => {
  // The ENTIRE `<root>/evals` submodule is excluded (results/, worktrees/,
  // node_modules/, and any other content), but a legitimate `results` dir
  // nested under a skill — whose parent is NOT the root — must survive.
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  // A non-evals `results` dir that MUST be copied.
  mkdirSync(join(spRoot, 'skills', 'my-skill', 'results'), { recursive: true });
  writeFileSync(join(spRoot, 'skills', 'my-skill', 'results', 'keep.txt'), 'k');
  // An `evals/results` dir that MUST be dropped (part of the evals subtree).
  mkdirSync(join(spRoot, 'evals', 'results'), { recursive: true });
  writeFileSync(join(spRoot, 'evals', 'results', 'drop.txt'), 'd');
  // Any other file under evals MUST now also be dropped — the whole subtree goes.
  writeFileSync(join(spRoot, 'evals', 'keep-evals.txt'), 'e');
  const runner = unusedRunner();

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG, new FakeAppServerClient());
      agent.provision(home, runner, SUBSCRIPTION_CRED);
      const pluginRoot = join(
        home.configDir,
        'plugins',
        'cache',
        'debug',
        'superpowers',
        'local',
      );
      // The skill's results dir survives (only the root-level evals is special).
      expect(
        existsSync(
          join(pluginRoot, 'skills', 'my-skill', 'results', 'keep.txt'),
        ),
      ).toBe(true);
      // The entire root-level evals/ subtree is dropped.
      expect(existsSync(join(pluginRoot, 'evals'))).toBe(false);
    });
  } finally {
    cleanup();
  }
});

test('provision copies a codex-home-skeleton when one is staged', () => {
  // skeletonRoot holding codex-home-skeleton/seed.txt — proves the skeleton is
  // seeded before the auth copy (the file survives into configDir).
  const { home: base, cleanup } = makeTempHome();
  const skeletonRoot = join(base.workdir, '..', 'skeletons');
  const skeleton = join(skeletonRoot, 'codex-home-skeleton');
  mkdirSync(skeleton, { recursive: true });
  writeFileSync(join(skeleton, 'seed.txt'), 'seeded\n');
  const home = { ...base, skeletonRoot };

  const authParent = join(base.workdir, '..', 'host-auth');
  const spRoot = join(base.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG, new FakeAppServerClient());
      agent.provision(home, runner, SUBSCRIPTION_CRED);
      const seeded = join(home.configDir, 'seed.txt');
      expect(existsSync(seeded)).toBe(true);
      expect(readFileSync(seeded, 'utf8')).toBe('seeded\n');
    });
  } finally {
    cleanup();
  }
});

test('provision throws when host auth is API-key auth, not subscription', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  // The app-server must never be reached — fail loudly if it is.
  const appServer = new FakeAppServerClient(() => {
    throw new Error('app-server should not be reached');
  });

  // api_key mode (and a present OPENAI_API_KEY) must be rejected — never copied.
  const apiKeyAuth = {
    auth_mode: 'api_key',
    OPENAI_API_KEY: 'sk-host',
    tokens: { refresh_token: 'r' },
  };

  try {
    withHostAuth(authParent, spRoot, apiKeyAuth, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      expect(() => agent.provision(home, runner, SUBSCRIPTION_CRED)).toThrow(
        /ChatGPT subscription auth/,
      );
      // The adapter aborts before the app-server step (and never the runner).
      expect(appServer.calls.length).toBe(0);
      expect(runner.calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

test('provision throws when host auth.json is missing', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = new FakeAppServerClient(() => {
    throw new Error('app-server should not be reached');
  });

  try {
    // auth === undefined -> .codex/ exists but no auth.json file.
    withHostAuth(authParent, spRoot, undefined, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      expect(() => agent.provision(home, runner, SUBSCRIPTION_CRED)).toThrow(
        /not found/,
      );
      expect(appServer.calls.length).toBe(0);
      expect(runner.calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

test('provision throws when host auth.json is not valid JSON', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = new FakeAppServerClient(() => {
    throw new Error('app-server should not be reached');
  });

  try {
    withHostAuth(authParent, spRoot, '{not json', () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      expect(() => agent.provision(home, runner, SUBSCRIPTION_CRED)).toThrow(
        /not valid JSON/,
      );
      expect(appServer.calls.length).toBe(0);
      expect(runner.calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

test('provision throws when subscription auth is missing a refresh token', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = new FakeAppServerClient(() => {
    throw new Error('app-server should not be reached');
  });

  const noRefresh = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {},
  };

  try {
    withHostAuth(authParent, spRoot, noRefresh, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      expect(() => agent.provision(home, runner, SUBSCRIPTION_CRED)).toThrow(
        /missing a refresh token/,
      );
      expect(appServer.calls.length).toBe(0);
      expect(runner.calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when app-server reports no superpowers hook', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  // auth OK, but hooks/list returns an empty hook set — drive the REAL
  // SpawnAppServerClient so the genuine selector raises.
  const emptyReply = { jsonrpc: '2.0', id: 2, result: { data: [] } };
  const appServer = spawnBackedClient(`${JSON.stringify(emptyReply)}\n`);

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      expect(() => agent.provision(home, runner, SUBSCRIPTION_CRED)).toThrow(
        ProvisionError,
      );
    });
  } finally {
    cleanup();
  }
});

// The copied auth.json is the only secret-bearing quorum-written file under
// CODEX_HOME, and it is mode-0600. The adapter never writes the host's
// (subscription) auth into config.toml — assert the config carries no token.
test('provision does not write the refresh token into config.toml', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = spawnBackedClient(appServerStdout());

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      agent.provision(home, runner, SUBSCRIPTION_CRED);
      const configToml = readFileSync(
        join(home.configDir, 'config.toml'),
        'utf8',
      );
      expect(configToml).not.toContain('refresh_token');
    });
  } finally {
    cleanup();
  }
});

// statSync is imported for the auth.json mode-0600 guard above; codex's only
// non-secret quorum-written file is config.toml. Assert it exists and is a
// regular file (mode bits are filesystem-default for non-secret config).
test('config.toml is a regular readable file after provision', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = new FakeAppServerClient();

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      agent.provision(home, runner, SUBSCRIPTION_CRED);
      const st = statSync(join(home.configDir, 'config.toml'));
      expect(st.isFile()).toBe(true);
    });
  } finally {
    cleanup();
  }
});

// The auth.json write must not follow a symlink at the destination: a
// pre-placed symlink at <CODEX_HOME>/auth.json must NOT be used to redirect the
// host's subscription credential to an attacker-controlled path (mirrors the
// O_NOFOLLOW protection on every Python secret write).
test('provision refuses to write the subscription auth through a dest symlink', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = new FakeAppServerClient();

  // An attacker-controlled file the symlink points at; it must stay untouched.
  const victimDir = join(home.workdir, '..', 'victim');
  mkdirSync(victimDir, { recursive: true });
  const victim = join(victimDir, 'secret-sink.json');
  writeFileSync(victim, 'ORIGINAL');

  // Pre-place CODEX_HOME/auth.json as a symlink to the victim before provision.
  mkdirSync(home.configDir, { recursive: true });
  symlinkSync(victim, join(home.configDir, 'auth.json'));

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      // The symlinked destination must be rejected, not followed.
      expect(() => agent.provision(home, runner, SUBSCRIPTION_CRED)).toThrow();
      // The victim file the symlink targeted is never overwritten...
      expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL');
      // ...and the destination is still a symlink, not a regular secret file.
      expect(
        lstatSync(join(home.configDir, 'auth.json')).isSymbolicLink(),
      ).toBe(true);
    });
  } finally {
    cleanup();
  }
});

// The exported writePrivateFileNoFollow building block (reused by Wave-2b's
// gemini/claude/copilot env-file writers): writes a 0600 file when the
// destination is fresh, and refuses to follow a symlink at the destination.
test('writePrivateFileNoFollow writes a fresh file at mode 0600', () => {
  const { home, cleanup } = makeTempHome();
  mkdirSync(home.configDir, { recursive: true });
  const dest = join(home.configDir, 'secret.env');
  try {
    writePrivateFileNoFollow(dest, "API_KEY='sk-xxx'\n");
    expect(readFileSync(dest, 'utf8')).toBe("API_KEY='sk-xxx'\n");
    expect(statSync(dest).mode & 0o777).toBe(0o600);
  } finally {
    cleanup();
  }
});

test('writePrivateFileNoFollow refuses to write through a dest symlink', () => {
  const { home, cleanup } = makeTempHome();
  mkdirSync(home.configDir, { recursive: true });
  const victim = join(home.configDir, 'victim');
  writeFileSync(victim, 'ORIGINAL');
  const dest = join(home.configDir, 'secret.env');
  symlinkSync(victim, dest);
  try {
    expect(() => writePrivateFileNoFollow(dest, 'SECRET')).toThrow();
    // The symlink target is never overwritten.
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL');
  } finally {
    cleanup();
  }
});

// Guards the HOME isolation + CODEX_HOME collapse: the codex launch-agent
// template scrubs OpenAI env and pins HOME/XDG/TMPDIR via $QUORUM_HOME_ENV so
// the staged superpowers@debug plugin is the version under test (no host
// bleed). It does NOT set CODEX_HOME: codex defaults CODEX_HOME to $HOME/.codex,
// which is where the runner seeds the per-run config (codex.yaml:
// home_config_subdir ".codex").
test('codex launch-agent isolates HOME, scrubs OPENAI_API_KEY, and omits CODEX_HOME', () => {
  const launcher = readFileSync(
    join(
      import.meta.dir,
      '..',
      'coding-agents',
      'codex-context',
      'launch-agent',
    ),
    'utf8',
  );
  // HOME/XDG/TMPDIR isolation comes from the shared $QUORUM_HOME_ENV token (the
  // standard every agent uses); codex now uses env -i + allowlist (PRI-2494).
  expect(launcher).toContain('$QUORUM_HOME_ENV');
  expect(launcher).toContain('env -i');
  expect(launcher).toContain('env_args=(');
  // CODEX_HOME is collapsed into $HOME — the launcher must NOT set it as an env
  // assignment on the exec line (the comment block may still mention the name).
  expect(launcher).not.toContain('CODEX_HOME="$CODEX_HOME"');
});

// ---------------------------------------------------------------------------
// B4: credential-driven branching (subscription + api-key)
// ---------------------------------------------------------------------------

// Synthetic subscription credential (codex_sub shape).
function makeSubscriptionCredential(
  overrides?: Partial<Credential>,
): Credential {
  return {
    model: 'codex-sub-model',
    harnesses: ['codex'],
    api: 'openai-responses',
    auth: 'subscription',
    compat: {},
    ...overrides,
  };
}

// Synthetic api-key credential (glm_5_2_responses shape).
function makeApiKeyCredential(overrides?: Partial<Credential>): Credential {
  return {
    model: 'glm-4-9b',
    harnesses: ['codex'],
    api: 'openai-responses',
    base_url: 'https://example.com/v1',
    auth: 'api-key',
    api_key_env: 'CODEX_B4_TEST_API_KEY',
    compat: {},
    ...overrides,
  };
}

// Helper: set env vars for the duration of `body`, restore on exit.
function withEnv(
  vars: Record<string, string | undefined>,
  body: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// B4-subscription: subscription credential copies auth.json, writes
// [features]/[plugins] + trusted_hash config.toml, and does NOT write
// codex-api.env or [model_providers].
test('subscription credential: auth.json seeded, no model_providers, no codex-api.env', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth-sub');
  const spRoot = join(home.workdir, '..', 'superpowers-src-sub');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = spawnBackedClient(appServerStdout());
  const credential = makeSubscriptionCredential();

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      const env = agent.provision(home, runner, credential);
      expect(env).toEqual({});

      // auth.json was copied and is mode 0600.
      const seeded = join(home.configDir, 'auth.json');
      expect(existsSync(seeded)).toBe(true);
      expect(JSON.parse(readFileSync(seeded, 'utf8'))).toMatchObject({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'r' },
      });
      expect(statSync(seeded).mode & 0o777).toBe(0o600);

      // config.toml has features/plugins but NO [model_providers] block.
      const configToml = readFileSync(
        join(home.configDir, 'config.toml'),
        'utf8',
      );
      expect(configToml).toContain('[features]');
      expect(configToml).toContain('plugins = true');
      expect(configToml).toContain('[plugins."superpowers@debug"]');
      expect(configToml).toContain('trusted_hash = "abc123def456"');
      expect(configToml).not.toContain('[model_providers');

      // No codex-api.env on the subscription path.
      expect(existsSync(join(home.configDir, 'codex-api.env'))).toBe(false);
    });
  } finally {
    cleanup();
  }
});

// B4-api-key: api-key credential writes config.toml with [model_providers."quorum"],
// wire_api = "responses" for openai-responses, env_key = CODEX_PROVIDER_API_KEY.
// No auth.json. codex-api.env exists at mode 0600 carrying the resolved key.
test('api-key credential: config.toml has model_providers quorum, no auth.json, codex-api.env at 0600', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src-api');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = spawnBackedClient(appServerStdout());
  const credential = makeApiKeyCredential();

  try {
    withEnv(
      { SUPERPOWERS_ROOT: spRoot, CODEX_B4_TEST_API_KEY: 'secret-key-xyz' },
      () => {
        const agent = new CodexAgent(CODEX_CONFIG, appServer);
        const env = agent.provision(home, runner, credential);
        expect(env).toEqual({});

        // No auth.json on the api-key path.
        expect(existsSync(join(home.configDir, 'auth.json'))).toBe(false);

        // config.toml has model/model_provider/[model_providers."quorum"] block.
        const configToml = readFileSync(
          join(home.configDir, 'config.toml'),
          'utf8',
        );
        expect(configToml).toContain('model = "glm-4-9b"');
        expect(configToml).toContain('model_provider = "quorum"');
        expect(configToml).toContain('[model_providers."quorum"]');
        expect(configToml).toContain('base_url = "https://example.com/v1"');
        expect(configToml).toContain('wire_api = "responses"');
        expect(configToml).toContain('env_key = "CODEX_PROVIDER_API_KEY"');
        // Features + plugin + trusted_hash are present (shared with subscription).
        expect(configToml).toContain('[features]');
        expect(configToml).toContain('[plugins."superpowers@debug"]');
        expect(configToml).toContain('trusted_hash = "abc123def456"');

        // codex-api.env exists at mode 0600 and carries the resolved key.
        const envFile = join(home.configDir, 'codex-api.env');
        expect(existsSync(envFile)).toBe(true);
        expect(statSync(envFile).mode & 0o777).toBe(0o600);
        const envContents = readFileSync(envFile, 'utf8');
        expect(envContents).toContain('CODEX_PROVIDER_API_KEY=');
        expect(envContents).toContain('secret-key-xyz');
        // The OPENAI_* name must NOT appear in the env file (would get scrubbed).
        expect(envContents).not.toContain('OPENAI_');
      },
    );
  } finally {
    cleanup();
  }
});

// B4-api-key wire_api mapping: openai-chat maps to "chat".
test('api-key credential: openai-chat maps to wire_api "chat"', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src-chat');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = new FakeAppServerClient();
  const credential = makeApiKeyCredential({ api: 'openai-chat' });

  try {
    withEnv(
      { SUPERPOWERS_ROOT: spRoot, CODEX_B4_TEST_API_KEY: 'chat-key' },
      () => {
        const agent = new CodexAgent(CODEX_CONFIG, appServer);
        agent.provision(home, runner, credential);
        const configToml = readFileSync(
          join(home.configDir, 'config.toml'),
          'utf8',
        );
        expect(configToml).toContain('wire_api = "chat"');
      },
    );
  } finally {
    cleanup();
  }
});

// B4: undefined credential throws ProvisionError.
test('undefined credential throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src-undef');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = new FakeAppServerClient(() => {
    throw new Error('app-server must not be reached');
  });

  try {
    withEnv({ SUPERPOWERS_ROOT: spRoot }, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      expect(() => agent.provision(home, runner, undefined)).toThrow(
        /codex requires a credential/i,
      );
    });
  } finally {
    cleanup();
  }
});

// B4: oauth credential throws ProvisionError.
test('oauth credential throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src-oauth');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = unusedRunner();
  const appServer = new FakeAppServerClient(() => {
    throw new Error('app-server must not be reached');
  });
  const credential: Credential = {
    model: 'codex-model',
    harnesses: ['codex'],
    api: 'openai-responses',
    auth: 'oauth',
    compat: {},
  };

  try {
    withEnv({ SUPERPOWERS_ROOT: spRoot }, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      expect(() => agent.provision(home, runner, credential)).toThrow(/oauth/i);
    });
  } finally {
    cleanup();
  }
});

// B4: launch-agent sources $CODEX_ENV_FILE conditionally (for api-key path).
test('codex launch-agent sources $CODEX_ENV_FILE conditionally', () => {
  const launcher = readFileSync(
    join(
      import.meta.dir,
      '..',
      'coding-agents',
      'codex-context',
      'launch-agent',
    ),
    'utf8',
  );
  // The conditional source must appear so the api-key path injects CODEX_PROVIDER_API_KEY.
  expect(launcher).toContain('$CODEX_ENV_FILE');
  // It must be conditional ([ -f … ] && . syntax) so subscription path (no file) is safe.
  expect(launcher).toMatch(/\[\s*-f\s+"\$CODEX_ENV_FILE"\s*\]/);
});
