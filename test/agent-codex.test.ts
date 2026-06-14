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
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// A codex.yaml-shaped config (mirrors coding-agents/codex.yaml). The fields the
// adapter reads are agent_config_env (CODEX_HOME) and required_env. required_env
// no longer carries OPENAI_API_KEY (codex uses ChatGPT subscription auth).
const CODEX_CONFIG: AgentConfig = {
  name: 'codex',
  binary: 'codex',
  agent_config_env: 'CODEX_HOME',
  session_log_dir: '${CODEX_HOME}/sessions',
  session_log_glob: '**/rollout-*.jsonl',
  normalizer: 'codex',
  required_env: ['SUPERPOWERS_ROOT'],
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
      const env = agent.provision(home, runner);

      // Returned env: at minimum CODEX_HOME -> configDir.
      expect(env).toEqual({ CODEX_HOME: home.configDir });

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
      agent.provision(home, runner);
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

test('plugin copy drops only evals/results, keeping a results dir elsewhere', () => {
  // Mirrors _ignore_codex_plugin_copy: `results` is excluded ONLY when the
  // directory being copied is named `evals`. A legitimate `results` dir nested
  // under a skill must survive into the staged plugin.
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  // A non-evals `results` dir that MUST be copied.
  mkdirSync(join(spRoot, 'skills', 'my-skill', 'results'), { recursive: true });
  writeFileSync(join(spRoot, 'skills', 'my-skill', 'results', 'keep.txt'), 'k');
  // An `evals/results` dir that MUST be dropped.
  mkdirSync(join(spRoot, 'evals', 'results'), { recursive: true });
  writeFileSync(join(spRoot, 'evals', 'results', 'drop.txt'), 'd');
  // A real file under evals (not results) that MUST be copied.
  writeFileSync(join(spRoot, 'evals', 'keep-evals.txt'), 'e');
  const runner = unusedRunner();

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG, new FakeAppServerClient());
      agent.provision(home, runner);
      const pluginRoot = join(
        home.configDir,
        'plugins',
        'cache',
        'debug',
        'superpowers',
        'local',
      );
      // The skill's results dir survives (only evals/results is special).
      expect(
        existsSync(
          join(pluginRoot, 'skills', 'my-skill', 'results', 'keep.txt'),
        ),
      ).toBe(true);
      // evals/results is dropped, but other evals content survives.
      expect(existsSync(join(pluginRoot, 'evals', 'results'))).toBe(false);
      expect(existsSync(join(pluginRoot, 'evals', 'keep-evals.txt'))).toBe(
        true,
      );
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
      agent.provision(home, runner);
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
      expect(() => agent.provision(home, runner)).toThrow(
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
      expect(() => agent.provision(home, runner)).toThrow(/not found/);
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
      expect(() => agent.provision(home, runner)).toThrow(/not valid JSON/);
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
      expect(() => agent.provision(home, runner)).toThrow(
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
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
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
      agent.provision(home, runner);
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
      agent.provision(home, runner);
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
      expect(() => agent.provision(home, runner)).toThrow();
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

// Guards the inherited 74e4a2d HOME isolation: the codex launch-agent template
// scrubs OpenAI env, pins HOME under $CODEX_HOME, and isolates XDG/TMPDIR so the
// staged superpowers@debug plugin is the version under test (no host bleed).
test('codex launch-agent isolates HOME, XDG, TMPDIR and scrubs OPENAI_API_KEY', () => {
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
  expect(launcher).toContain('HOME="$codex_agent_home"');
  expect(launcher).toContain('XDG_CONFIG_HOME=');
  expect(launcher).toContain('XDG_DATA_HOME=');
  expect(launcher).toContain('TMPDIR=');
  expect(launcher).toContain('-u OPENAI_API_KEY');
  expect(launcher).toContain('CODEX_HOME="$CODEX_HOME"');
});
