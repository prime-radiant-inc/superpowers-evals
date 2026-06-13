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
// adapter reads are agent_config_env (CODEX_HOME) and required_env.
const CODEX_CONFIG: AgentConfig = {
  name: 'codex',
  binary: 'codex',
  agent_config_env: 'CODEX_HOME',
  session_log_dir: '${CODEX_HOME}/sessions',
  session_log_glob: '**/rollout-*.jsonl',
  normalizer: 'codex',
  required_env: ['OPENAI_API_KEY', 'SUPERPOWERS_ROOT'],
  max_time: '10m',
};

const API_KEY = 'sk-codex-test';

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

// Set OPENAI_API_KEY + SUPERPOWERS_ROOT around `body`, restoring prior values
// even on throw (mirrors runner-e2e.test.ts's env save/restore).
function withEnv(superpowersRoot: string, body: () => void): void {
  const prevKey = process.env['OPENAI_API_KEY'];
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  process.env['OPENAI_API_KEY'] = API_KEY;
  process.env['SUPERPOWERS_ROOT'] = superpowersRoot;
  try {
    body();
  } finally {
    if (prevKey === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = prevKey;
    }
    if (prevRoot === undefined) {
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      process.env['SUPERPOWERS_ROOT'] = prevRoot;
    }
  }
}

// Responder for the happy path: codex login succeeds, codex app-server emits the
// canned hooks/list response, everything else is a default success.
function happyResponder(
  command: string,
  args: readonly string[],
): CommandResult {
  if (command === 'codex' && args[0] === 'app-server') {
    return { status: 0, stdout: appServerStdout(), stderr: '' };
  }
  return { status: 0, stdout: '', stderr: '' };
}

test('provision seeds CODEX_HOME, logs in, and stages the trusted plugin hook', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(spRoot, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      const env = agent.provision(home, runner);

      // Returned env: at minimum CODEX_HOME -> configDir.
      expect(env).toEqual({ CODEX_HOME: home.configDir });

      // Config dir + the staged plugin tree exist.
      expect(existsSync(home.configDir)).toBe(true);
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

      // Subprocess calls: login (key on stdin, CODEX_HOME in env) then
      // app-server (workdir cwd, both JSON-RPC requests on stdin).
      expect(runner.calls.length).toBe(2);

      const login = runner.calls[0];
      expect(login?.command).toBe('codex');
      expect(login?.args).toEqual(['login', '--with-api-key']);
      expect(login?.options?.input).toBe(API_KEY);
      expect(login?.options?.env?.['CODEX_HOME']).toBe(home.configDir);

      const appServer = runner.calls[1];
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
  // skeletonRoot holding codex-home-skeleton/auth.json — proves the skeleton is
  // seeded before the login ceremony (the file survives into configDir).
  const { home: base, cleanup } = makeTempHome();
  const skeletonRoot = join(base.workdir, '..', 'skeletons');
  const skeleton = join(skeletonRoot, 'codex-home-skeleton');
  mkdirSync(skeleton, { recursive: true });
  writeFileSync(join(skeleton, 'auth.json'), '{"seeded":true}\n');
  const home = { ...base, skeletonRoot };

  const spRoot = join(base.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(spRoot, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      agent.provision(home, runner);
      const seeded = join(home.configDir, 'auth.json');
      expect(existsSync(seeded)).toBe(true);
      expect(JSON.parse(readFileSync(seeded, 'utf8'))).toEqual({
        seeded: true,
      });
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when codex login exits non-zero', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  // login fails; the adapter must abort before the app-server step.
  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'codex' && args[0] === 'login') {
      return { status: 1, stdout: '', stderr: 'bad api key' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  try {
    withEnv(spRoot, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      // Only the login was attempted (no app-server call after the failure).
      expect(runner.calls.length).toBe(1);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when app-server reports no superpowers hook', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  // login OK, but hooks/list returns an empty hook set.
  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'codex' && args[0] === 'app-server') {
      const reply = { jsonrpc: '2.0', id: 2, result: { data: [] } };
      return { status: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  try {
    withEnv(spRoot, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when OPENAI_API_KEY is unset', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  const prevKey = process.env['OPENAI_API_KEY'];
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  delete process.env['OPENAI_API_KEY'];
  process.env['SUPERPOWERS_ROOT'] = spRoot;
  try {
    const agent = new CodexAgent(CODEX_CONFIG);
    expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
    expect(runner.calls.length).toBe(0);
  } finally {
    if (prevKey === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = prevKey;
    }
    if (prevRoot === undefined) {
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      process.env['SUPERPOWERS_ROOT'] = prevRoot;
    }
    cleanup();
  }
});

// A mode-0600 secret env file: codex writes its secret into auth.json via the
// login subprocess (not a quorum-written file), so there is no quorum-authored
// secret file to assert mode on here. This test documents that and asserts the
// adapter does NOT leak the key into a world-readable quorum-written file in
// CODEX_HOME (parity: the key only reaches codex via stdin).
test('provision does not write the OPENAI_API_KEY into any config file', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(spRoot, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      agent.provision(home, runner);
      const configToml = readFileSync(
        join(home.configDir, 'config.toml'),
        'utf8',
      );
      expect(configToml).not.toContain(API_KEY);
    });
  } finally {
    cleanup();
  }
});

// statSync is imported for parity with the spec's mode-0600 guidance; codex has
// no quorum-written secret file, so this guards that if config.toml ever gains a
// secret, the mode contract is visible. Asserts config.toml exists and is a
// regular file (mode bits are filesystem-default for non-secret config).
test('config.toml is a regular readable file after provision', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(spRoot, () => {
      const agent = new CodexAgent(CODEX_CONFIG);
      agent.provision(home, runner);
      const st = statSync(join(home.configDir, 'config.toml'));
      expect(st.isFile()).toBe(true);
    });
  } finally {
    cleanup();
  }
});
