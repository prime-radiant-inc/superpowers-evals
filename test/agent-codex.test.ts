import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CodexAgent } from '../src/agents/codex.ts';
import type { CommandResult } from '../src/agents/command-runner.ts';
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
// SessionStart hook with the shape selectSuperpowersHook accepts.
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

// Responder for the happy path: codex app-server emits the canned hooks/list
// response, everything else is a default success.
function happyResponder(
  command: string,
  args: readonly string[],
): CommandResult {
  if (command === 'codex' && args[0] === 'app-server') {
    return { status: 0, stdout: appServerStdout(), stderr: '' };
  }
  return { status: 0, stdout: '', stderr: '' };
}

test('provision copies subscription auth and stages the trusted plugin hook', () => {
  const { home, cleanup } = makeTempHome();
  const authParent = join(home.workdir, '..', 'host-auth');
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
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

      // Exactly one subprocess call: app-server (no login). Auth is a file copy.
      expect(runner.calls.length).toBe(1);
      const appServer = runner.calls[0];
      expect(appServer?.command).toBe('codex');
      expect(appServer?.args).toEqual(['app-server', '--listen', 'stdio://']);
      expect(appServer?.options?.cwd).toBe(home.workdir);
      expect(appServer?.options?.env?.['CODEX_HOME']).toBe(home.configDir);
      const sentInput = appServer?.options?.input ?? '';
      expect(sentInput).toContain('"method":"initialize"');
      expect(sentInput).toContain('"method":"hooks/list"');
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
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
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
  const runner = new FakeCommandRunner(happyResponder);

  // api_key mode (and a present OPENAI_API_KEY) must be rejected — never copied.
  const apiKeyAuth = {
    auth_mode: 'api_key',
    OPENAI_API_KEY: 'sk-host',
    tokens: { refresh_token: 'r' },
  };

  try {
    withHostAuth(authParent, spRoot, apiKeyAuth, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(
        /ChatGPT subscription auth/,
      );
      // No subprocess calls: the adapter aborts before the app-server step.
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
  const runner = new FakeCommandRunner(happyResponder);

  try {
    // auth === undefined -> .codex/ exists but no auth.json file.
    withHostAuth(authParent, spRoot, undefined, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(/not found/);
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
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withHostAuth(authParent, spRoot, '{not json', () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(/not valid JSON/);
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
  const runner = new FakeCommandRunner(happyResponder);

  const noRefresh = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {},
  };

  try {
    withHostAuth(authParent, spRoot, noRefresh, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(
        /missing a refresh token/,
      );
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
  // auth OK, but hooks/list returns an empty hook set.
  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'codex' && args[0] === 'app-server') {
      const reply = { jsonrpc: '2.0', id: 2, result: { data: [] } };
      return { status: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
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
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
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
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withHostAuth(authParent, spRoot, SUBSCRIPTION_AUTH, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      agent.provision(home, runner);
      const st = statSync(join(home.configDir, 'config.toml'));
      expect(st.isFile()).toBe(true);
    });
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
