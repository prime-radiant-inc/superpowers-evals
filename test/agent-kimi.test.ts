import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
} from '../src/agents/command-runner.ts';
import { ProvisionError } from '../src/agents/index.ts';
import {
  KimiAgent,
  sanitizeKimiDiagnostic,
  writeKimiRuntimeEnvFile,
} from '../src/agents/kimi.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// A kimi.yaml-shaped config (mirrors coding-agents/kimi.yaml). The fields the
// adapter reads are binary, agent_config_env (KIMI_CODE_HOME), and required_env.
// `binary` is a REAL on-PATH executable so resolveKimiBinary's in-process
// Bun.which (mirroring shutil.which, H3) resolves it — there is no `command -v`
// subprocess probe to stub.
const KIMI_CONFIG: AgentConfig = {
  name: 'kimi',
  binary: 'sh',
  agent_config_env: 'KIMI_CODE_HOME',
  session_log_dir: '${KIMI_CODE_HOME}/sessions',
  session_log_glob: '**/wire.jsonl',
  normalizer: 'kimi',
  required_env: ['SUPERPOWERS_ROOT', 'KIMI_MODEL_API_KEY'],
  max_time: '10m',
};

const API_KEY = 'kimi-model-key-abcdef';
// The Bun.which-resolved path of KIMI_CONFIG.binary; the preflight subprocess is
// keyed on this resolved path, never a faked probe value.
const RESOLVED_BINARY = Bun.which(KIMI_CONFIG.binary) ?? '';

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

// Write the on-disk session attribution the live kimi process would produce: a
// session_index.jsonl row whose workDir == the preflight cwd, pointing at a
// sessionDir under <kimiHome>/sessions that contains a wire.jsonl. The preflight
// reads these from the throwaway kimiHome it created (KIMI_CODE_HOME in the env).
function writeKimiPreflightSession(
  options: CommandOptions | undefined,
  overrides?: {
    readonly workDir?: string;
    readonly sessionDir?: string;
    readonly omitWire?: boolean;
    readonly omitIndex?: boolean;
  },
): void {
  const env = options?.env ?? {};
  const kimiHome = env['KIMI_CODE_HOME'];
  const cwd = options?.cwd;
  if (kimiHome === undefined || cwd === undefined) {
    return;
  }
  // The live kimi process creates its own home; model that so session_index.jsonl
  // can be written even when the sessionDir is staged elsewhere.
  mkdirSync(kimiHome, { recursive: true });
  if (overrides?.omitIndex) {
    return;
  }
  const sessionDir =
    overrides?.sessionDir ?? join(kimiHome, 'sessions', 'session-0001');
  mkdirSync(sessionDir, { recursive: true });
  if (!overrides?.omitWire) {
    writeFileSync(join(sessionDir, 'wire.jsonl'), '{"event":"start"}\n');
  }
  const row = {
    workDir: overrides?.workDir ?? cwd,
    sessionDir,
  };
  writeFileSync(
    join(kimiHome, 'session_index.jsonl'),
    `${JSON.stringify(row)}\n`,
  );
}

// Happy preflight responder: the binary is resolved in-process via Bun.which (H3),
// so the only subprocess is the kimi auth preflight, keyed on the resolved binary
// path. It replies with a stream-json assistant "OK" line and writes the expected
// on-disk session attribution into the throwaway kimi home.
function happyResponder(
  command: string,
  _args: readonly string[],
  options: CommandOptions | undefined,
): CommandResult {
  if (command === RESOLVED_BINARY) {
    writeKimiPreflightSession(options);
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

        // Subprocess calls: only the auth preflight (binary resolution is the
        // in-process Bun.which from H3, not a `command -v` subprocess probe).
        expect(runner.calls.length).toBe(1);

        const preflight = runner.calls[0];
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
        const preflightEnv = runner.calls[0]?.options?.env ?? {};
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
        expect(runner.calls[0]?.options?.env?.['KIMI_MODEL_NAME']).toBe(
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
        // No subprocess at all: binary resolution is in-process (Bun.which) and
        // the sentinel path skips the live preflight.
        expect(runner.calls.length).toBe(0);
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
  // Binary resolves in-process (Bun.which); the preflight assistant reply is not OK.
  const runner = new FakeCommandRunner(() => {
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
  // Binary resolves in-process (Bun.which); the preflight subprocess exits non-zero.
  const runner = new FakeCommandRunner(() => ({
    status: 1,
    stdout: '',
    stderr: 'auth rejected',
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
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError naming the binary when it is not on PATH', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  // A binary name guaranteed absent from PATH; Bun.which resolves to null (H3).
  const absentConfig: AgentConfig = {
    ...KIMI_CONFIG,
    binary: 'no-such-kimi-binary-on-path-7f3a9',
  };

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(absentConfig);
        expect(() => agent.provision(home, runner)).toThrow(
          /'no-such-kimi-binary-on-path-7f3a9' not found on PATH/,
        );
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

// ---------------------------------------------------------------------------
// H2 (SECURITY): provision() runs every escaping diagnostic through
// sanitizeKimiDiagnostic, so a secret echoed by a failing subprocess (e.g. the
// API key in preflight stderr) is REDACTED before the message reaches the
// runner's catch and verdict.json — never leaked verbatim.
// ---------------------------------------------------------------------------

test('provision redacts a secret echoed in preflight stderr before it escapes', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  // The preflight subprocess fails AND echoes the API key in its stderr. Without
  // sanitization the raw key would flow into ProvisionError.message verbatim.
  const runner = new FakeCommandRunner(() => ({
    status: 1,
    stdout: '',
    stderr: `auth rejected for token ${API_KEY}`,
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
        let caught: unknown;
        try {
          agent.provision(home, runner);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ProvisionError);
        const message = (caught as ProvisionError).message;
        // The raw secret is gone; the same redaction sanitizeKimiDiagnostic applies.
        expect(message).not.toContain(API_KEY);
        expect(message).toContain('<redacted>');
        // The non-secret diagnostic context survives.
        expect(message).toContain('kimi auth preflight failed');
      },
    );
  } finally {
    cleanup();
  }
});

test('provision redacts an arbitrary sensitive env value leaked into a diagnostic', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const otherSecret = 'super-secret-token-value';
  const runner = new FakeCommandRunner(() => ({
    status: 1,
    stdout: '',
    stderr: `failure mentioning ${otherSecret}`,
  }));

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
        // A name containing TOKEN with a >=6-char value: sanitize must redact it.
        SERVICE_AUTH_TOKEN: otherSecret,
      },
      () => {
        const agent = new KimiAgent(KIMI_CONFIG);
        let caught: unknown;
        try {
          agent.provision(home, runner);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ProvisionError);
        const message = (caught as ProvisionError).message;
        expect(message).not.toContain(otherSecret);
        expect(message).toContain('<redacted>');
      },
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// sanitizeKimiDiagnostic (SECURITY)
// ---------------------------------------------------------------------------

test('sanitizeKimiDiagnostic redacts the KIMI_MODEL_API_KEY value', () => {
  const secret = 'kimi-model-key-abcdef';
  const env = { KIMI_MODEL_API_KEY: secret };
  const message = `kimi auth preflight failed; stderr: invalid token ${secret}`;
  const out = sanitizeKimiDiagnostic(message, env);
  expect(out).not.toContain(secret);
  expect(out).toContain('<redacted>');
});

test('sanitizeKimiDiagnostic redacts any env value >=6 chars whose name contains KEY/TOKEN/SECRET/PASSWORD', () => {
  const env = {
    MY_API_KEY: 'topsecretvalue',
    SERVICE_TOKEN: 'abcdef',
    DB_SECRET: 'hunter22',
    LOGIN_PASSWORD: 'p@ssword1',
    SAFE_VAR: 'plainvalue',
  };
  const message =
    'leak topsecretvalue and abcdef and hunter22 and p@ssword1 and plainvalue';
  const out = sanitizeKimiDiagnostic(message, env);
  expect(out).not.toContain('topsecretvalue');
  expect(out).not.toContain('abcdef');
  expect(out).not.toContain('hunter22');
  expect(out).not.toContain('p@ssword1');
  // A non-sensitive var name is NOT redacted.
  expect(out).toContain('plainvalue');
});

test('sanitizeKimiDiagnostic leaves short (<6 char) sensitive values alone', () => {
  const env = { API_KEY: 'short' };
  const message = 'value short here';
  const out = sanitizeKimiDiagnostic(message, env);
  // 5-char value below the min length is not redacted.
  expect(out).toContain('short');
});

test('sanitizeKimiDiagnostic redacts longest-first to avoid partial survivors', () => {
  // One secret is a substring of another; longest-first redaction prevents
  // leaking the suffix of the longer value.
  const env = {
    SHORT_TOKEN: 'abcdef',
    LONG_TOKEN: 'abcdefghij',
  };
  const message = 'saw abcdefghij in the response';
  const out = sanitizeKimiDiagnostic(message, env);
  expect(out).not.toContain('abcdefghij');
  expect(out).not.toContain('abcdef');
  expect(out).toBe('saw <redacted> in the response');
});

test('sanitizeKimiDiagnostic stringifies non-string messages', () => {
  const env = { API_KEY: 'sensitive-value' };
  const err = new Error('boom sensitive-value');
  const out = sanitizeKimiDiagnostic(err, env);
  expect(out).not.toContain('sensitive-value');
  expect(out).toContain('boom');
});

// ---------------------------------------------------------------------------
// writeKimiRuntimeEnvFile artifact-root-escape guard + run-scoped naming
// ---------------------------------------------------------------------------

test('writeKimiRuntimeEnvFile writes a run-scoped 0600 file outside the artifact root', () => {
  const { home, cleanup } = makeTempHome();
  try {
    // runDir is the per-run artifact dir (parent of configDir); artifact root is
    // its parent. The OS tmpdir is outside both, so the guard accepts it.
    const runDir = join(home.configDir, '..');
    const path = writeKimiRuntimeEnvFile(
      { KIMI_MODEL_API_KEY: API_KEY, KIMI_DISABLE_TELEMETRY: '1' },
      { runDir },
    );
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Run-scoped naming: the secret dir prefix embeds the run dir's basename.
    expect(path).toContain('quorum-kimi-env-');
    // The secret file is NOT placed inside the artifact root.
    const artifactRoot = realpathSync(join(home.configDir, '..', '..'));
    expect(path.startsWith(`${artifactRoot}/`)).toBe(false);
    const body = readFileSync(path, 'utf8');
    expect(body).toContain(`KIMI_MODEL_API_KEY='${API_KEY}'`);
    expect(body).toContain("KIMI_DISABLE_TELEMETRY='1'");
  } finally {
    cleanup();
  }
});

test('writeKimiRuntimeEnvFile walks the temp parent out when tmpdir is inside the artifact root', () => {
  const { home, cleanup } = makeTempHome();
  try {
    const runDir = join(home.configDir, '..');
    // Force the temp parent override to sit INSIDE the artifact root; the guard
    // must walk it out so the resulting file lands outside the artifact root.
    const artifactRoot = join(runDir, '..');
    const insideTmp = join(artifactRoot, 'tmp-inside');
    mkdirSync(insideTmp, { recursive: true });
    const path = writeKimiRuntimeEnvFile(
      { KIMI_MODEL_API_KEY: API_KEY },
      { runDir, tmpDirOverride: insideTmp },
    );
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(`${realpathSync(insideTmp)}/`)).toBe(false);
    // The escaped file is not under the artifact root either.
    expect(path.startsWith(`${realpathSync(artifactRoot)}/`)).toBe(false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Live preflight session_index / workDir / sessionDir / wire.jsonl attribution
// ---------------------------------------------------------------------------

// Drive provision() with a responder that emits an OK reply but controls the
// on-disk session attribution the preflight verifies.
function provisionWithAttribution(
  attribution: (options: CommandOptions | undefined) => void,
): () => Record<string, string> {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner((command, _args, options) => {
    if (command === RESOLVED_BINARY) {
      attribution(options);
      const reply = { role: 'assistant', content: 'OK' };
      return { status: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  return () => {
    let result: Record<string, string> = {};
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
          result = agent.provision(home, runner);
        },
      );
    } finally {
      cleanup();
    }
    return result;
  };
}

test('preflight passes when session_index attributes the cwd to a sessionDir with wire.jsonl', () => {
  const run = provisionWithAttribution((options) => {
    writeKimiPreflightSession(options);
  });
  expect(() => run()).not.toThrow();
});

test('preflight throws when the live kimi process wrote no session_index.jsonl', () => {
  const run = provisionWithAttribution((options) => {
    writeKimiPreflightSession(options, { omitIndex: true });
  });
  expect(() => run()).toThrow(ProvisionError);
});

test('preflight throws when no session_index row workDir matches the preflight cwd', () => {
  const run = provisionWithAttribution((options) => {
    writeKimiPreflightSession(options, { workDir: '/some/other/dir' });
  });
  expect(() => run()).toThrow(ProvisionError);
});

test('preflight throws when the matching sessionDir resolves outside the kimi home/sessions', () => {
  const run = provisionWithAttribution((options) => {
    const escaped = mkdtempSync(join(tmpdir(), 'quorum-kimi-escaped-'));
    writeKimiPreflightSession(options, { sessionDir: escaped });
  });
  expect(() => run()).toThrow(ProvisionError);
});

test('preflight throws when the matching sessionDir contains no wire.jsonl', () => {
  const run = provisionWithAttribution((options) => {
    writeKimiPreflightSession(options, { omitWire: true });
  });
  expect(() => run()).toThrow(ProvisionError);
});

// ---------------------------------------------------------------------------
// H3: kimi binary resolution via Bun.which (in-process PATH walk, like
// shutil.which), not a `command -v` subprocess probe that ENOENTs on Linux.
// ---------------------------------------------------------------------------

// A real binary guaranteed on PATH, with its true resolved path. The adapter
// must resolve via Bun.which, returning this path — never a faked probe value.
const REAL_BINARY_NAME = 'sh';
const REAL_BINARY_PATH = Bun.which(REAL_BINARY_NAME) ?? '';

const REAL_BINARY_CONFIG: AgentConfig = {
  ...KIMI_CONFIG,
  binary: REAL_BINARY_NAME,
};

// Happy responder for a real-binary config: the preflight subprocess is keyed on
// the Bun.which-resolved path, and NO `command -v` probe is involved.
function realBinaryResponder(
  command: string,
  _args: readonly string[],
  options: CommandOptions | undefined,
): CommandResult {
  if (command === REAL_BINARY_PATH) {
    writeKimiPreflightSession(options);
    const reply = { role: 'assistant', content: 'OK' };
    return { status: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: '' };
  }
  return { status: 0, stdout: '', stderr: '' };
}

test('provision resolves the kimi binary via Bun.which (no command -v subprocess)', () => {
  expect(REAL_BINARY_PATH).not.toBe('');
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(realBinaryResponder);

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(REAL_BINARY_CONFIG);
        const env = agent.provision(home, runner);
        // The resolved binary is the real PATH resolution, not a faked value.
        expect(env['KIMI_BINARY']).toBe(REAL_BINARY_PATH);
        // Only the preflight ran; there is NO `command -v` probe subprocess.
        expect(runner.calls.length).toBe(1);
        expect(runner.calls[0]?.command).toBe(REAL_BINARY_PATH);
        for (const call of runner.calls) {
          expect(call.command).not.toBe('command');
        }
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the binary is absent from PATH (no faked probe)', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  // The responder NEVER answers a probe; resolution is in-process via Bun.which.
  // No binary by this name exists on PATH, so resolution must fail on its own.
  const runner = new FakeCommandRunner(() => ({
    status: 0,
    stdout: '',
    stderr: '',
  }));
  const absentConfig: AgentConfig = {
    ...KIMI_CONFIG,
    binary: 'definitely-not-a-real-binary-xyzzy-kimi',
  };

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: spRoot,
        KIMI_MODEL_API_KEY: API_KEY,
        KIMI_MODEL_NAME: undefined,
        QUORUM_KIMI_PREFLIGHT_SENTINEL: undefined,
      },
      () => {
        const agent = new KimiAgent(absentConfig);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
        // Resolution failed in-process: NO subprocess was attempted.
        expect(runner.calls.length).toBe(0);
      },
    );
  } finally {
    cleanup();
  }
});
