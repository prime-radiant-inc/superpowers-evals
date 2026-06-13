import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandResult } from '../src/agents/command-runner.ts';
import { ProvisionError } from '../src/agents/index.ts';
import { KimiAgent } from '../src/agents/kimi.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// A kimi.yaml-shaped config (mirrors coding-agents/kimi.yaml). The fields the
// adapter reads are binary, agent_config_env (KIMI_CODE_HOME), and required_env.
const KIMI_CONFIG: AgentConfig = {
  name: 'kimi',
  binary: 'kimi',
  agent_config_env: 'KIMI_CODE_HOME',
  session_log_dir: '${KIMI_CODE_HOME}/sessions',
  session_log_glob: '**/wire.jsonl',
  normalizer: 'kimi',
  required_env: ['SUPERPOWERS_ROOT', 'KIMI_MODEL_API_KEY'],
  max_time: '10m',
};

const API_KEY = 'kimi-model-key-abcdef';
const RESOLVED_BINARY = '/usr/local/bin/kimi';

// The model-provider defaults the adapter bakes in (must equal the Python's
// DEFAULT_KIMI_MODEL_ENV + KIMI_RUNTIME_FLAGS, modulo the host-overlaid key).
const EXPECTED_MODEL_ENV: Record<string, string> = {
  KIMI_MODEL_NAME: 'kimi-for-coding',
  KIMI_MODEL_PROVIDER_TYPE: 'kimi',
  KIMI_MODEL_BASE_URL: 'https://api.kimi.com/coding/v1',
  KIMI_MODEL_MAX_CONTEXT_SIZE: '262144',
  KIMI_MODEL_CAPABILITIES: 'thinking,image_in,video_in,tool_use',
  KIMI_MODEL_DEFAULT_THINKING: 'true',
  KIMI_DISABLE_TELEMETRY: '1',
  KIMI_DISABLE_CRON: '1',
  KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: 'false',
  KIMI_MODEL_API_KEY: API_KEY,
};

// Stage a SUPERPOWERS_ROOT that validate_superpowers_kimi_root accepts: the
// .kimi-plugin/plugin.json manifest plus the two required seed skills.
function stageSuperpowers(root: string): void {
  mkdirSync(join(root, '.kimi-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.kimi-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        name: 'superpowers',
        skills: './skills/',
        sessionStart: { skill: 'using-superpowers' },
        skillInstructions: 'Use skills aggressively.',
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(root, 'skills', 'using-superpowers'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'using-superpowers', 'SKILL.md'),
    '# using-superpowers\n',
  );
  mkdirSync(join(root, 'skills', 'brainstorming'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'brainstorming', 'SKILL.md'),
    '# brainstorming\n',
  );
}

// Set SUPERPOWERS_ROOT + KIMI_MODEL_API_KEY (and optional extra keys) around
// `body`, restoring prior values even on throw. getEnv reads process.env;
// biome noProcessEnv is OFF for test/agent-*.test.ts.
function withEnv(
  vars: Readonly<Record<string, string | undefined>>,
  body: () => void,
): void {
  const keys = Object.keys(vars);
  const prev = new Map<string, string | undefined>();
  for (const key of keys) {
    prev.set(key, process.env[key]);
    const value = vars[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    body();
  } finally {
    for (const key of keys) {
      const original = prev.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

// Happy preflight responder: `command -v kimi` resolves the binary; the kimi
// auth preflight replies with a stream-json assistant "OK" line.
function happyResponder(
  command: string,
  args: readonly string[],
): CommandResult {
  if (command === 'command' && args[0] === '-v') {
    return { status: 0, stdout: `${RESOLVED_BINARY}\n`, stderr: '' };
  }
  if (command === RESOLVED_BINARY) {
    const reply = { role: 'assistant', content: 'OK' };
    return { status: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: '' };
  }
  return { status: 0, stdout: '', stderr: '' };
}

test('provision seeds KIMI_CODE_HOME, runs the preflight, installs the plugin', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
        KIMI_MODEL_NAME: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        const env = agent.provision(home, runner);

        // Returned env: KIMI_CODE_HOME -> configDir, plus the launcher pointers.
        expect(env['KIMI_CODE_HOME']).toBe(home.configDir);
        expect(env['KIMI_BINARY']).toBe(RESOLVED_BINARY);
        expect(typeof env['KIMI_ENV_FILE']).toBe('string');
        expect(existsSync(env['KIMI_ENV_FILE'] ?? '')).toBe(true);

        // The kimi home + the seeded subdirs all exist.
        expect(existsSync(home.configDir)).toBe(true);
        for (const child of [
          'home',
          'cache',
          'xdg-config',
          'xdg-cache',
          'xdg-data',
        ]) {
          expect(existsSync(join(home.configDir, child))).toBe(true);
        }

        // plugins/installed.json registers the local checkout as the sole
        // enabled plugin.
        const installedPath = join(home.configDir, 'plugins', 'installed.json');
        expect(existsSync(installedPath)).toBe(true);
        const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
        expect(installed.version).toBe(1);
        expect(installed.plugins.length).toBe(1);
        const plugin = installed.plugins[0];
        expect(plugin.id).toBe('superpowers');
        expect(plugin.source).toBe('local-path');
        expect(plugin.enabled).toBe(true);
        // root is the resolved (realpath-independent) absolute checkout.
        expect(typeof plugin.root).toBe('string');
        expect(plugin.originalSource).toBe(plugin.root);
        expect(typeof plugin.installedAt).toBe('string');
        expect(plugin.updatedAt).toBe(plugin.installedAt);

        // effective-kimi-model-config.json: redacted summary.
        const summaryPath = join(
          home.configDir,
          'effective-kimi-model-config.json',
        );
        expect(existsSync(summaryPath)).toBe(true);
        const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
        expect(summary.kimi_binary).toBe(RESOLVED_BINARY);
        expect(summary.kimi_version).toBe(null);
        // The API key is redacted, not leaked.
        expect(summary.model_env.KIMI_MODEL_API_KEY).toBe('<present>');
        expect(summary.model_env.KIMI_MODEL_NAME).toBe('kimi-for-coding');
        expect(summary.model_env.KIMI_DISABLE_TELEMETRY).toBe('1');
        expect(JSON.stringify(summary)).not.toContain(API_KEY);

        // The runtime env file: mode 0600, carries the model env + XDG/HOME, and
        // does NOT leak into a world-readable file.
        const envFilePath = env['KIMI_ENV_FILE'] ?? '';
        const mode = statSync(envFilePath).mode & 0o777;
        expect(mode).toBe(0o600);
        const envFileBody = readFileSync(envFilePath, 'utf8');
        expect(envFileBody).toContain(`KIMI_MODEL_API_KEY='${API_KEY}'`);
        expect(envFileBody).toContain("KIMI_DISABLE_TELEMETRY='1'");
        expect(envFileBody).toContain(`KIMI_CODE_HOME='${home.configDir}'`);
        expect(envFileBody).toContain(`HOME='${join(home.configDir, 'home')}'`);
        expect(envFileBody).toContain(
          `XDG_CONFIG_HOME='${join(home.configDir, 'xdg-config')}'`,
        );

        // Subprocess calls: the PATH probe then the auth preflight.
        expect(runner.calls.length).toBe(2);

        const probe = runner.calls[0];
        expect(probe?.command).toBe('command');
        expect(probe?.args).toEqual(['-v', 'kimi']);

        const preflight = runner.calls[1];
        expect(preflight?.command).toBe(RESOLVED_BINARY);
        expect(preflight?.args).toEqual([
          '-p',
          'Reply with EXACTLY OK.',
          '--output-format=stream-json',
        ]);
        // The preflight env carries the model env + isolated KIMI/XDG dirs.
        expect(preflight?.options?.env?.['KIMI_MODEL_API_KEY']).toBe(API_KEY);
        expect(preflight?.options?.env?.['KIMI_MODEL_NAME']).toBe(
          'kimi-for-coding',
        );
        expect(preflight?.options?.env?.['KIMI_CODE_HOME']).toBeDefined();
      },
    );
  } finally {
    cleanup();
  }
});

test('preflight env equals the effective model env overlaid on the hermetic XDG dirs', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
        KIMI_MODEL_NAME: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        agent.provision(home, runner);
        const preflightEnv = runner.calls[1]?.options?.env ?? {};
        for (const [key, value] of Object.entries(EXPECTED_MODEL_ENV)) {
          expect(preflightEnv[key]).toBe(value);
        }
      },
    );
  } finally {
    cleanup();
  }
});

test('a host KIMI_MODEL_NAME override flows into the model env', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: 'kimi-custom',
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        agent.provision(home, runner);
        expect(runner.calls[1]?.options?.env?.['KIMI_MODEL_NAME']).toBe(
          'kimi-custom',
        );
        const summary = JSON.parse(
          readFileSync(
            join(home.configDir, 'effective-kimi-model-config.json'),
            'utf8',
          ),
        );
        expect(summary.model_env.KIMI_MODEL_NAME).toBe('kimi-custom');
      },
    );
  } finally {
    cleanup();
  }
});

test('a precomputed sentinel is validated instead of running the live preflight', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  const token = 'preflight-token-xyz';
  const sentinelPath = join(spRoot, '..', 'sentinel.json');
  const sentinel = {
    schema: 1,
    agent: 'kimi',
    kimi_binary: RESOLVED_BINARY,
    model: 'kimi-for-coding',
    provider: 'kimi',
    base_url: 'https://api.kimi.com/coding/v1',
    preflight_token_sha256: createHash('sha256').update(token).digest('hex'),
  };
  writeFileSync(sentinelPath, JSON.stringify(sentinel));

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: sentinelPath,
        QUORUM_KIMI_PREFLIGHT_TOKEN: token,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        agent.provision(home, runner);
        // Only the PATH probe ran; the live preflight was skipped.
        expect(runner.calls.length).toBe(1);
        expect(runner.calls[0]?.command).toBe('command');
      },
    );
  } finally {
    cleanup();
  }
});

test('a sentinel with a mismatched token hash throws ProvisionError', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  const sentinelPath = join(spRoot, '..', 'sentinel.json');
  const sentinel = {
    schema: 1,
    agent: 'kimi',
    kimi_binary: RESOLVED_BINARY,
    model: 'kimi-for-coding',
    provider: 'kimi',
    base_url: 'https://api.kimi.com/coding/v1',
    preflight_token_sha256: createHash('sha256')
      .update('the-real-token')
      .digest('hex'),
  };
  writeFileSync(sentinelPath, JSON.stringify(sentinel));

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: sentinelPath,
        QUORUM_KIMI_PREFLIGHT_TOKEN: 'a-different-token',
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the preflight does not reply OK', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  // PATH probe resolves, but the preflight assistant reply is not OK.
  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'command' && args[0] === '-v') {
      return { status: 0, stdout: `${RESOLVED_BINARY}\n`, stderr: '' };
    }
    const reply = { role: 'assistant', content: 'NOPE' };
    return { status: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: '' };
  });

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the preflight exits non-zero', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'command' && args[0] === '-v') {
      return { status: 0, stdout: `${RESOLVED_BINARY}\n`, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'auth rejected' };
  });

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the kimi binary is not on PATH', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  // The PATH probe fails: no binary resolved.
  const runner = new FakeCommandRunner(() => ({
    status: 1,
    stdout: '',
    stderr: '',
  }));

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
        // No preflight after the failed probe.
        expect(runner.calls.length).toBe(1);
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when SUPERPOWERS_ROOT is unset', () => {
  const { home, cleanup } = makeTempHome();
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: undefined,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
        // It aborts before any subprocess.
        expect(runner.calls.length).toBe(0);
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when KIMI_MODEL_API_KEY is unset', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: undefined,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError on an unsupported host KIMI_MODEL_* override', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        KIMI_MODEL_BASE_URL: 'https://evil.example/v1',
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when a required Superpowers Kimi file is missing', () => {
  const { home, cleanup } = makeTempHome();
  // Stage a root missing the .kimi-plugin manifest (only the skills exist).
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(join(spRoot, 'skills', 'using-superpowers'), { recursive: true });
  writeFileSync(
    join(spRoot, 'skills', 'using-superpowers', 'SKILL.md'),
    '# using-superpowers\n',
  );
  mkdirSync(join(spRoot, 'skills', 'brainstorming'), { recursive: true });
  writeFileSync(
    join(spRoot, 'skills', 'brainstorming', 'SKILL.md'),
    '# brainstorming\n',
  );
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the manifest name is wrong', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  // Corrupt the manifest name after staging.
  writeFileSync(
    join(spRoot, '.kimi-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'not-superpowers',
      skills: './skills/',
      sessionStart: { skill: 'using-superpowers' },
      skillInstructions: 'x',
    }),
  );
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
  }
});
