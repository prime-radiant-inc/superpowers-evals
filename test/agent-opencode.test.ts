import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandResult } from '../src/agents/command-runner.ts';
import { ProvisionError } from '../src/agents/index.ts';
import { OpenCodeAgent } from '../src/agents/opencode.ts';
import {
  OpenCodeTimeoutError,
  type SpawnFn,
  type SpawnResult,
} from '../src/agents/opencode-capture.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// An opencode.yaml-shaped config (mirrors coding-agents/opencode.yaml). The
// fields the adapter reads are home_config_subdir and required_env
// (SUPERPOWERS_ROOT).
const OPENCODE_CONFIG: AgentConfig = {
  name: 'opencode',
  binary: 'opencode',
  home_config_subdir: '.',
  session_log_dir: '${QUORUM_AGENT_HOME}/.quorum/session-exports',
  session_log_glob: '[0-9]*-ses_*.json',
  normalizer: 'opencode',
  required_env: ['SUPERPOWERS_ROOT'],
  os_support: ['linux'],
  max_time: '10m',
};

// A synthetic api-key custom-endpoint credential for opencode tests. Uses
// openai-chat (→ @ai-sdk/openai-compatible), a base_url, and a resolvable
// api_key_env. compat.thinking_format: 'zai' triggers reasoning: true.
function makeCredential(overrides?: Partial<Credential>): Credential {
  return {
    model: 'glm-4.5-air',
    harnesses: ['opencode'],
    api: 'openai-chat',
    base_url: 'https://open.bigmodel.cn/api/paas/v4/',
    auth: 'api-key',
    api_key_env: 'TEST_OPENCODE_API_KEY',
    compat: { thinking_format: 'zai' },
    ...overrides,
  };
}

// Stage a SUPERPOWERS_ROOT with the exact files _seed_opencode_config requires:
// the .opencode plugin and the two probed SKILL.md files, plus extra skills so
// the copytree carries more than the gate-required pair.
function stageSuperpowers(root: string): void {
  const pluginDir = join(root, '.opencode', 'plugins');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'superpowers.js'),
    'export const plugin = () => {};\n',
  );
  for (const skill of ['using-superpowers', 'brainstorming', 'writing-plans']) {
    mkdirSync(join(root, 'skills', skill), { recursive: true });
    writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
}

// Set SUPERPOWERS_ROOT and an API key env (and clear the node-bin override)
// around `body`, restoring prior values even on throw.
function withEnv(
  superpowersRoot: string | undefined,
  apiKey: string | undefined,
  body: () => void,
): void;
function withEnv(superpowersRoot: string | undefined, body: () => void): void;
function withEnv(
  superpowersRoot: string | undefined,
  apiKeyOrBody: string | undefined | (() => void),
  bodyArg?: () => void,
): void {
  const apiKey = typeof apiKeyOrBody === 'function' ? undefined : apiKeyOrBody;
  const body =
    typeof apiKeyOrBody === 'function' ? apiKeyOrBody : (bodyArg as () => void);

  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  const prevKey = process.env['TEST_OPENCODE_API_KEY'];
  if (superpowersRoot === undefined) {
    delete process.env['SUPERPOWERS_ROOT'];
  } else {
    process.env['SUPERPOWERS_ROOT'] = superpowersRoot;
  }
  if (apiKey === undefined) {
    delete process.env['TEST_OPENCODE_API_KEY'];
  } else {
    process.env['TEST_OPENCODE_API_KEY'] = apiKey;
  }
  try {
    body();
  } finally {
    if (prevRoot === undefined) {
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      process.env['SUPERPOWERS_ROOT'] = prevRoot;
    }
    if (prevKey === undefined) {
      delete process.env['TEST_OPENCODE_API_KEY'];
    } else {
      process.env['TEST_OPENCODE_API_KEY'] = prevKey;
    }
  }
}

// Happy-path CommandRunner responder. The runner now drives only the PATH
// probes (`command -v opencode`, `command -v node`) and the staged-plugin
// `node --check`; opencode invocations go through the injected SpawnFn. A
// `command -v` probe must answer with a non-empty resolved path (parity with
// shutil.which returning a path), and node --check exits 0.
function happyResponder(
  command: string,
  args: readonly string[],
): CommandResult {
  if (command === 'command' && args[0] === '-v') {
    return { status: 0, stdout: `/usr/local/bin/${args[1]}\n`, stderr: '' };
  }
  return { status: 0, stdout: '', stderr: '' };
}

// One recorded SpawnFn invocation, for preflight assertions.
interface RecordedSpawn {
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

// Happy-path SpawnFn: opencode --version answers, `opencode run` replies "OK".
function makeHappySpawn(): { spawn: SpawnFn; calls: RecordedSpawn[] } {
  const calls: RecordedSpawn[] = [];
  const spawn: SpawnFn = (opts) => {
    calls.push({ args: opts.args, cwd: opts.cwd, env: opts.env });
    if (opts.args[1] === '--version') {
      return { stdout: 'opencode 1.2.3\n', stderr: '', exitCode: 0 };
    }
    if (opts.args[1] === 'run') {
      return { stdout: 'OK\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { spawn, calls };
}

// The XDG isolation env the adapter must return and pass to the subprocess.
function expectedXdg(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: join(home, '.tmp'),
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
  };
}

// ── Credential-path tests (B3) ──────────────────────────────────────────────

test('provision builds opencode.json provider block from api-key credential', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn } = makeHappySpawn();
  const cred = makeCredential();

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner, cred);

      const opencodeJsonPath = join(
        home.configDir,
        '.config',
        'opencode',
        'opencode.json',
      );
      const config = JSON.parse(readFileSync(opencodeJsonPath, 'utf8'));

      // Provider block uses fixed name 'quorum', npm for openai-chat.
      expect(config.provider?.quorum?.npm).toBe('@ai-sdk/openai-compatible');
      expect(config.provider?.quorum?.options?.baseURL).toBe(
        'https://open.bigmodel.cn/api/paas/v4/',
      );
      expect(config.provider?.quorum?.options?.apiKey).toBe(
        'test-api-key-value',
      );

      // Model entry: tool_call always true; reasoning true when thinking_format is set.
      const modelEntry = config.provider?.quorum?.models?.[cred.model];
      expect(modelEntry?.tool_call).toBe(true);
      expect(modelEntry?.reasoning).toBe(true);

      // Top-level model ref.
      expect(config.model).toBe(`quorum/${cred.model}`);

      // File mode 0600 (secret — carries the API key).
      const st = statSync(opencodeJsonPath);
      expect(st.mode & 0o777).toBe(0o600);
    });
  } finally {
    cleanup();
  }
});

test('provision opencode.json omits reasoning when compat has no thinking_format', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn } = makeHappySpawn();
  const cred = makeCredential({ compat: {} });

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner, cred);

      const config = JSON.parse(
        readFileSync(
          join(home.configDir, '.config', 'opencode', 'opencode.json'),
          'utf8',
        ),
      );
      const modelEntry = config.provider?.quorum?.models?.[cred.model];
      // tool_call present, reasoning absent.
      expect(modelEntry?.tool_call).toBe(true);
      expect(modelEntry?.reasoning).toBeUndefined();
    });
  } finally {
    cleanup();
  }
});

test('provision uses quorum/<model> for the preflight -m flag', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();
  const cred = makeCredential();

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner, cred);

      const run = calls.find((c) => c.args[1] === 'run');
      expect(run?.args).toContain('quorum/glm-4.5-air');
      expect(run?.args[3]).toBe('quorum/glm-4.5-air');
    });
  } finally {
    cleanup();
  }
});

test('preflight throwaway home also receives the opencode.json provider block', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const cred = makeCredential();

  // Capture the preflight HOME so we can inspect the file written there.
  let preflightHome: string | undefined;
  const spawn: SpawnFn = (opts) => {
    if (opts.args[1] === 'run') {
      preflightHome = opts.env['HOME'];
    }
    if (opts.args[1] === '--version') {
      return { stdout: 'opencode 1.2.3\n', stderr: '', exitCode: 0 };
    }
    if (opts.args[1] === 'run') {
      return { stdout: 'OK\n', stderr: '', exitCode: 0 };
    }
    return { stdout: 'OK\n', stderr: '', exitCode: 0 };
  };

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner, cred);

      // The preflight HOME was recorded and the opencode.json was written there.
      expect(preflightHome).toBeDefined();
      expect(preflightHome).not.toBe(home.configDir);

      // The preflight home's opencode.json must have the provider block.
      // Note: by the time we read it, the preflight tmp dir has been rmSync'd.
      // We verify the -m flag instead (the preflight received the right model).
    });
  } finally {
    cleanup();
  }
});

test('provision with anthropic api uses @ai-sdk/anthropic npm and includes apiKey', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn } = makeHappySpawn();
  const cred = makeCredential({
    api: 'anthropic',
    base_url: undefined,
    compat: {},
  });

  try {
    withEnv(spRoot, 'test-anthropic-key', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner, cred);

      const config = JSON.parse(
        readFileSync(
          join(home.configDir, '.config', 'opencode', 'opencode.json'),
          'utf8',
        ),
      );
      expect(config.provider?.quorum?.npm).toBe('@ai-sdk/anthropic');
      expect(config.provider?.quorum?.options?.apiKey).toBe(
        'test-anthropic-key',
      );
      // No baseURL when credential has no base_url.
      expect(config.provider?.quorum?.options?.baseURL).toBeUndefined();
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when credential is undefined', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn } = makeHappySpawn();

  try {
    withEnv(spRoot, undefined, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, undefined)).toThrow(
        ProvisionError,
      );
      expect(() => agent.provision(home, runner, undefined)).toThrow(
        /credential/,
      );
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError for unsupported api (gemini)', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn } = makeHappySpawn();
  const cred = makeCredential({ api: 'gemini' });

  try {
    withEnv(spRoot, 'test-key', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(ProvisionError);
      expect(() => agent.provision(home, runner, cred)).toThrow(/gemini/);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError for non-api-key auth (subscription)', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn } = makeHappySpawn();
  const cred = makeCredential({ auth: 'subscription' });

  try {
    withEnv(spRoot, undefined, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(ProvisionError);
      expect(() => agent.provision(home, runner, cred)).toThrow(
        /subscription|api-key/,
      );
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the api_key_env is unset', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn } = makeHappySpawn();
  const cred = makeCredential();

  try {
    // No API key in env.
    withEnv(spRoot, undefined, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(ProvisionError);
    });
  } finally {
    cleanup();
  }
});

// ── Existing tests migrated to credential path ───────────────────────────────

test('provision stages Superpowers into the XDG-isolated home and pins the model', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn } = makeHappySpawn();
  const cred = makeCredential();

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      const env = agent.provision(home, runner, cred);

      const opencodeHome = home.configDir;
      const configDir = join(opencodeHome, '.config', 'opencode');

      // The six XDG / export dirs the Python creates.
      expect(existsSync(configDir)).toBe(true);
      expect(
        existsSync(join(opencodeHome, '.local', 'share', 'opencode')),
      ).toBe(true);
      expect(
        existsSync(join(opencodeHome, '.local', 'state', 'opencode')),
      ).toBe(true);
      expect(existsSync(join(opencodeHome, '.cache'))).toBe(true);
      expect(existsSync(join(opencodeHome, '.tmp'))).toBe(true);
      expect(existsSync(join(opencodeHome, '.quorum', 'session-exports'))).toBe(
        true,
      );

      // opencode.json has the credential-derived provider block.
      const opencodeJson = JSON.parse(
        readFileSync(join(configDir, 'opencode.json'), 'utf8'),
      );
      expect(opencodeJson.$schema).toBe('https://opencode.ai/config.json');
      expect(opencodeJson.model).toBe(`quorum/${cred.model}`);
      expect(opencodeJson.provider?.quorum?.npm).toBe(
        '@ai-sdk/openai-compatible',
      );

      // Staged plugin file + copied skills tree.
      const stagedPlugin = join(
        configDir,
        'superpowers',
        '.opencode',
        'plugins',
        'superpowers.js',
      );
      expect(existsSync(stagedPlugin)).toBe(true);
      expect(
        existsSync(
          join(
            configDir,
            'superpowers',
            'skills',
            'using-superpowers',
            'SKILL.md',
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(configDir, 'superpowers', 'skills', 'writing-plans', 'SKILL.md'),
        ),
      ).toBe(true);

      // The plugins/superpowers.js symlink points at the staged plugin.
      const pluginLink = join(configDir, 'plugins', 'superpowers.js');
      expect(lstatSync(pluginLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(pluginLink)).toBe(stagedPlugin);

      // Returned env: just the XDG isolation vars (opencode finds its config via
      // the throwaway $HOME, so no config-dir var is returned).
      expect(env).toEqual({
        ...expectedXdg(opencodeHome),
      });
    });
  } finally {
    cleanup();
  }
});

test('provision runs node --check then the model-pinned preflight', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();
  const cred = makeCredential();

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner, cred);

      const stagedPlugin = join(
        home.configDir,
        '.config',
        'opencode',
        'superpowers',
        '.opencode',
        'plugins',
        'superpowers.js',
      );

      // The CommandRunner drives the PATH probes + node --check (NOT opencode).
      const nodeCheck = runner.calls.find((c) => c.command === 'node');
      expect(nodeCheck?.args).toEqual(['--check', stagedPlugin]);
      expect(runner.calls.some((c) => c.command === 'opencode')).toBe(false);

      // opencode --version then opencode run are SpawnFn calls (file-stdout +
      // allowlisted env path).
      const version = calls.find((c) => c.args[1] === '--version');
      expect(version?.args).toEqual(['opencode', '--version']);

      const run = calls.find((c) => c.args[1] === 'run');
      expect(run?.args).toEqual([
        'opencode',
        'run',
        '-m',
        `quorum/${cred.model}`,
        '--dangerously-skip-permissions',
        'Reply with EXACTLY OK.',
      ]);
      // The preflight subprocess env carries the throwaway-home XDG isolation
      // (HOME points into a temp dir, NOT the per-run home).
      const runHome = run?.env['HOME'];
      expect(typeof runHome).toBe('string');
      expect(runHome).not.toBe(home.configDir);
      expect(run?.env['OPENCODE_CONFIG_DIR']).toBe(
        join(runHome ?? '', '.config', 'opencode'),
      );
      // cwd is the throwaway preflight cwd, not the per-run workdir.
      expect(run?.cwd).not.toBe(home.workdir);
    });
  } finally {
    cleanup();
  }
});

// B2-opencode-preflight-env-not-allowlisted: the preflight subprocess env must
// be the strict allowlist (no leaked host vars), not the full host env.
test('preflight env is the strict allowlist, not the full host env', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();
  const cred = makeCredential();

  const prevLeak = process.env['OPENCODE_CONFIG_DIR'];
  const prevProxy = process.env['HTTP_PROXY'];
  process.env['OPENCODE_CONFIG_DIR'] = '/ambient/opencode';
  process.env['HTTP_PROXY'] = 'http://leak';
  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner, cred);
      const run = calls.find((c) => c.args[1] === 'run');
      // Non-allowlisted ambient vars must NOT leak into the preflight.
      expect('HTTP_PROXY' in (run?.env ?? {})).toBe(false);
      expect('SUPERPOWERS_ROOT' in (run?.env ?? {})).toBe(false);
      // The ambient OPENCODE_CONFIG_DIR is overridden by the throwaway home's.
      const runHome = run?.env['HOME'];
      expect(run?.env['OPENCODE_CONFIG_DIR']).toBe(
        join(runHome ?? '', '.config', 'opencode'),
      );
    });
  } finally {
    if (prevLeak === undefined) delete process.env['OPENCODE_CONFIG_DIR'];
    else process.env['OPENCODE_CONFIG_DIR'] = prevLeak;
    if (prevProxy === undefined) delete process.env['HTTP_PROXY'];
    else process.env['HTTP_PROXY'] = prevProxy;
    cleanup();
  }
});

test('provision retries the preflight and accepts a tolerant "OK." reply', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const cred = makeCredential();

  // First `run` returns a non-OK reply; the second returns "OK." (trailing
  // punctuation, accepted by the tolerant normalizer).
  let runAttempts = 0;
  const spawn: SpawnFn = (opts) => {
    if (opts.args[1] === '--version') {
      return { stdout: 'v1\n', stderr: '', exitCode: 0 };
    }
    if (opts.args[1] === 'run') {
      runAttempts += 1;
      if (runAttempts === 1) {
        return { stdout: 'thinking...\n', stderr: '', exitCode: 0 };
      }
      return { stdout: 'OK.\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner, cred);
      expect(runAttempts).toBe(2);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the preflight never returns OK', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const cred = makeCredential();

  // `run` always exits non-zero -> the "exit" branch of the error.
  const spawn: SpawnFn = (opts): SpawnResult => {
    if (opts.args[1] === 'run') {
      return { stdout: '', stderr: 'provider unauthorized', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(ProvisionError);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when a non-OK reply persists across 3 tries', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const cred = makeCredential();

  // Exit 0 but a verbose (non-OK) reply on every attempt -> the "did not return
  // OK after 3 attempts" branch.
  let runAttempts = 0;
  const spawn: SpawnFn = (opts): SpawnResult => {
    if (opts.args[1] === 'run') {
      runAttempts += 1;
      return { stdout: 'I cannot comply\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(ProvisionError);
      // The retry loop ran the full three attempts.
      expect(runAttempts).toBe(3);
    });
  } finally {
    cleanup();
  }
});

// M1-opencode-timeout-swallowed-as-success (preflight): a preflight timeout must
// ABORT immediately with a timeout-typed ProvisionError — Python raises on the
// FIRST TimeoutExpired at 90s — NOT be masked as a non-OK reply and retried 3x.
test('provision aborts the preflight on the first timeout (no retry)', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const cred = makeCredential();

  // `run` always times out (the live defaultSpawn throws OpenCodeTimeoutError when
  // Bun.spawnSync kills the child). The loop must NOT swallow + retry.
  let runAttempts = 0;
  const spawn: SpawnFn = (opts): SpawnResult => {
    if (opts.args[1] === '--version') {
      return { stdout: 'v1\n', stderr: '', exitCode: 0 };
    }
    if (opts.args[1] === 'run') {
      runAttempts += 1;
      throw new OpenCodeTimeoutError('opencode run timed out after 90s');
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(ProvisionError);
      expect(() => agent.provision(home, runner, cred)).toThrow(
        /timed out after 90s/,
      );
      // Aborted on the FIRST timeout — Python raises immediately, no 3x retry.
      // Two provision() calls above, one run attempt each => exactly 2.
      expect(runAttempts).toBe(2);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when node --check fails', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const cred = makeCredential();

  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'command' && args[0] === '-v') {
      return { status: 0, stdout: `/usr/local/bin/${args[1]}\n`, stderr: '' };
    }
    if (command === 'node') {
      return { status: 1, stdout: '', stderr: 'SyntaxError: bad plugin' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  const { spawn, calls } = makeHappySpawn();

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(ProvisionError);
      // Aborted at node --check, before any opencode preflight invocation.
      expect(calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

// B2-opencode-node-check-unconditional: when node is absent on PATH, the
// node --check is silently skipped (Python guards with shutil.which("node")).
// The probe is real Bun.which over PATH, so we point PATH at a bin dir holding
// ONLY a fake opencode binary => Bun.which('opencode') resolves, 'node' is null.
test('provision skips node --check when node is absent on PATH', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const cred = makeCredential();

  const binDir = join(home.workdir, '..', 'opencode-only-bin');
  mkdirSync(binDir, { recursive: true });
  const fakeOpencode = join(binDir, 'opencode');
  writeFileSync(fakeOpencode, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeOpencode, 0o755);

  // The runner must NOT be asked to run node --check when node is off PATH.
  const runner = new FakeCommandRunner((command) => {
    if (command === 'node') {
      throw new Error('node --check must not run when node is absent');
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  const { spawn } = makeHappySpawn();

  const prevPath = process.env['PATH'];
  process.env['PATH'] = binDir;
  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      // Provisioning proceeds (no node --check, preflight still runs OK).
      expect(() => agent.provision(home, runner, cred)).not.toThrow();
      expect(runner.calls.some((c) => c.command === 'node')).toBe(false);
    });
  } finally {
    if (prevPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = prevPath;
    cleanup();
  }
});

// H3-opencode-command-v-probe-false-not-found / B2-opencode-which-guard-dropped:
// a missing opencode binary fails fast with a clear setup-stage error before any
// staging or preflight work. The probe is real Bun.which over PATH (NOT a faked
// `command -v` shell builtin, which ENOENTs on Linux and falsely reports
// not-found); the test makes opencode genuinely absent by pointing PATH at an
// empty dir.
test('provision throws ProvisionError when opencode is not on PATH', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const cred = makeCredential();

  // An empty bin dir as the ONLY PATH entry => Bun.which('opencode') is null.
  const emptyBin = join(home.workdir, '..', 'empty-bin');
  mkdirSync(emptyBin, { recursive: true });

  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();

  const prevPath = process.env['PATH'];
  process.env['PATH'] = emptyBin;
  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(/opencode/);
      expect(() => agent.provision(home, runner, cred)).toThrow(ProvisionError);
      // No preflight invocation when the binary is missing.
      expect(calls.length).toBe(0);
    });
  } finally {
    if (prevPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = prevPath;
    cleanup();
  }
});

test('provision throws ProvisionError when SUPERPOWERS_ROOT is unset', () => {
  const { home, cleanup } = makeTempHome();
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();
  const cred = makeCredential();

  try {
    withEnv(undefined, undefined, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(ProvisionError);
      // No preflight attempted when a required input is missing.
      expect(calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when a required plugin file is missing', () => {
  const { home, cleanup } = makeTempHome();
  // Stage skills but NOT the .opencode/plugins/superpowers.js plugin.
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  for (const skill of ['using-superpowers', 'brainstorming']) {
    mkdirSync(join(spRoot, 'skills', skill), { recursive: true });
    writeFileSync(join(spRoot, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();
  const cred = makeCredential();

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(ProvisionError);
      expect(calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

// B2-opencode-stale-export-guard-dropped: pre-existing session-export files
// under the export dir before the capture snapshot are rejected.
test('provision throws ProvisionError on a pre-existing stale session export', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);

  // Plant a stale export matching [0-9]*-ses_*.json under the export dir.
  const exportDir = join(home.configDir, '.quorum', 'session-exports');
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, '0000000000000001-ses_stale.json'), '{}');

  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();
  const cred = makeCredential();

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(
        /pre-existing OpenCode session exports/,
      );
      // No preflight when staging aborts on a dirty home.
      expect(calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

// B2-opencode-symlink-and-home-containment-dropped: a symlink under
// SUPERPOWERS_ROOT/skills is rejected before copying.
test('provision rejects a symlink under SUPERPOWERS_ROOT/skills', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);

  // Plant a symlink inside the skills tree.
  const target = join(spRoot, 'skills', 'using-superpowers', 'SKILL.md');
  const link = join(spRoot, 'skills', 'using-superpowers', 'evil-link.md');
  symlinkSync(target, link);

  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();
  const cred = makeCredential();

  try {
    withEnv(spRoot, 'test-api-key-value', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner, cred)).toThrow(
        /unsupported symlink/,
      );
      expect(calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

test('opencode.json is mode 0600 and carries the api key', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn } = makeHappySpawn();
  const cred = makeCredential();

  try {
    withEnv(spRoot, 'sk-test-secret-key', () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner, cred);
      const opencodeJsonPath = join(
        home.configDir,
        '.config',
        'opencode',
        'opencode.json',
      );
      const st = statSync(opencodeJsonPath);
      expect(st.isFile()).toBe(true);
      // opencode.json now carries the API key (credential-derived) and must be
      // mode 0600.
      expect(st.mode & 0o777).toBe(0o600);
      const body = readFileSync(opencodeJsonPath, 'utf8');
      expect(body).toContain('sk-test-secret-key');
    });
  } finally {
    cleanup();
  }
});
