import { expect, test } from 'bun:test';
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
import { join } from 'node:path';
import {
  CopilotAgent,
  copilotGauntletEnv,
  scanCopilotSecretLeaks,
} from '../src/agents/copilot.ts';
import { ProvisionError } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// The copilot.yaml config surface this adapter consumes. Mirrors
// coding-agents/copilot.yaml (only fields provision() reads matter here).
const CONFIG: AgentConfig = {
  name: 'copilot',
  binary: 'copilot',
  agent_config_env: 'COPILOT_HOME',
  session_log_dir: '${COPILOT_HOME}/session-state',
  session_log_glob: '**/events.jsonl',
  normalizer: 'copilot',
  required_env: ['SUPERPOWERS_ROOT'],
  max_time: '10m',
  max_concurrency: 1,
};

const PLUGIN_FILES: readonly string[] = [
  '.claude-plugin/plugin.json',
  'hooks/hooks.json',
  'hooks/run-hook.cmd',
  'hooks/session-start',
  'skills/using-superpowers/SKILL.md',
  'skills/brainstorming/SKILL.md',
  'skills/using-superpowers/references/copilot-tools.md',
];

// Build a fake SUPERPOWERS_ROOT carrying every required plugin file, plus the
// plugin.json content we later assert was copied verbatim into the home.
function makeSuperpowersRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'copilot-sproot-'));
  for (const rel of PLUGIN_FILES) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    const body =
      rel === '.claude-plugin/plugin.json'
        ? JSON.stringify({ name: 'superpowers', version: '0.0.0' })
        : `marker:${rel}\n`;
    writeFileSync(path, body);
  }
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Read-Bun.env is the sanctioned env handle (env.ts reads process.env, which
// Bun.env writes through). Biome's noProcessEnv allows Bun.env. We set the
// keys a test needs, run the body, then restore exactly (mirrors runner-e2e).
function withEnv(
  overrides: Readonly<Record<string, string | undefined>>,
  body: () => void,
): void {
  const keys = Object.keys(overrides);
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, Bun.env[key]);
    const next = overrides[key];
    if (next === undefined) {
      delete Bun.env[key];
    } else {
      Bun.env[key] = next;
    }
  }
  try {
    body();
  } finally {
    for (const key of keys) {
      const prev = previous.get(key);
      if (prev === undefined) {
        delete Bun.env[key];
      } else {
        Bun.env[key] = prev;
      }
    }
  }
}

// Auth-relevant env that must be cleared so a test's overrides are the only
// inputs to _resolve_copilot_auth_env (the host may legitimately carry tokens).
const AUTH_ENV_KEYS: readonly string[] = [
  'SUPERPOWERS_ROOT',
  'COPILOT_OFFLINE',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN',
  'COPILOT_MODEL',
];

function clearedAuthEnv(): Record<string, string | undefined> {
  const cleared: Record<string, string | undefined> = {};
  for (const key of AUTH_ENV_KEYS) {
    cleared[key] = undefined;
  }
  return cleared;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test('provision stages COPILOT_HOME, writes secret env file, and stages the plugin', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    const runner = copilotPresentRunner();
    let returned: Record<string, string> = {};
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        returned = new CopilotAgent(CONFIG).provision(home, runner);
      },
    );

    // configDir and the oracle's subdirs exist.
    expect(existsSync(home.configDir)).toBe(true);
    for (const subdir of [
      '.quorum',
      '.cache',
      'logs',
      'plugins',
      'session-state',
    ]) {
      expect(statSync(join(home.configDir, subdir)).isDirectory()).toBe(true);
    }

    // The secret env file exists, has the exact shell-quoted content, mode 0600.
    const envFile = join(home.configDir, '.copilot-env');
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toBe(
      "COPILOT_GITHUB_TOKEN='ghp_test_token'\n",
    );
    expect(mode(envFile)).toBe(0o600);

    // The plugin tree is staged with required files; plugin.json copied verbatim.
    const pluginRoot = join(home.configDir, 'plugins', 'superpowers');
    for (const rel of PLUGIN_FILES) {
      expect(statSync(join(pluginRoot, rel)).isFile()).toBe(true);
    }
    const stagedPluginJson: unknown = JSON.parse(
      readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(stagedPluginJson).toEqual({ name: 'superpowers', version: '0.0.0' });

    // Returned env points the agent_config_env at the isolated home; no auth in it.
    expect(returned).toEqual({ COPILOT_HOME: home.configDir });
    expect(Object.keys(returned)).toEqual(['COPILOT_HOME']);

    // provision()'s only subprocess is the `command -v copilot` PATH probe.
    expect(runner.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['command', '-v', 'copilot'],
    ]);
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision honors the GH_TOKEN fallback chain and quotes embedded quotes', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        GH_TOKEN: "tok'with'quotes",
      },
      () => {
        new CopilotAgent(CONFIG).provision(home, copilotPresentRunner());
      },
    );
    const envFile = join(home.configDir, '.copilot-env');
    // _shell_single_quote turns ' into '\'' .
    expect(readFileSync(envFile, 'utf8')).toBe(
      "COPILOT_GITHUB_TOKEN='tok'\\''with'\\''quotes'\n",
    );
    expect(mode(envFile)).toBe(0o600);
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision re-enforces 0600 on a pre-existing loose-perm .copilot-env', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    // A pre-existing env file with world-readable perms. writeFileSync's `mode`
    // option is ignored when the file already exists, so without a follow-up
    // chmod the loose mode would survive (oracle _write_copilot_env_file
    // fchmods 0600 both before and after writing).
    mkdirSync(home.configDir, { recursive: true });
    const envFile = join(home.configDir, '.copilot-env');
    writeFileSync(envFile, 'STALE=1\n', { mode: 0o644 });
    chmodSync(envFile, 0o644);
    expect(mode(envFile)).toBe(0o644);

    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        new CopilotAgent(CONFIG).provision(home, copilotPresentRunner());
      },
    );
    expect(mode(envFile)).toBe(0o600);
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision writes sorted provider env when COPILOT_PROVIDER_BASE_URL is set', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_PROVIDER_BASE_URL: 'https://provider.example/v1',
        COPILOT_PROVIDER_API_KEY: 'sk-provider',
        COPILOT_PROVIDER_TYPE: 'openai',
      },
      () => {
        new CopilotAgent(CONFIG).provision(home, copilotPresentRunner());
      },
    );
    const envFile = join(home.configDir, '.copilot-env');
    // Keys are sorted; all three provider values written shell-quoted.
    expect(readFileSync(envFile, 'utf8')).toBe(
      "COPILOT_PROVIDER_API_KEY='sk-provider'\n" +
        "COPILOT_PROVIDER_BASE_URL='https://provider.example/v1'\n" +
        "COPILOT_PROVIDER_TYPE='openai'\n",
    );
    expect(mode(envFile)).toBe(0o600);
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision falls back to `gh auth token` when no token env var is set', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    // No COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN and no provider base url:
    // the oracle's final fallback shells `gh auth token` (here via the runner
    // seam). The resolved token is written into the secret env file.
    const runner = new FakeCommandRunner((command, args) => {
      if (command === 'command' && args[0] === '-v') {
        return { status: 0, stdout: `/usr/bin/${args[1]}\n`, stderr: '' };
      }
      if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') {
        return { status: 0, stdout: 'gho_from_gh_cli\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    withEnv({ ...clearedAuthEnv(), SUPERPOWERS_ROOT: sp.root }, () => {
      new CopilotAgent(CONFIG).provision(home, runner);
    });
    const envFile = join(home.configDir, '.copilot-env');
    expect(readFileSync(envFile, 'utf8')).toBe(
      "COPILOT_GITHUB_TOKEN='gho_from_gh_cli'\n",
    );
    // The runner was asked for `gh auth token`.
    expect(
      runner.calls.some(
        (c) => c.command === 'gh' && c.args.join(' ') === 'auth token',
      ),
    ).toBe(true);
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision tolerates a non-zero `gh auth token` and reports no auth found', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    // gh is present but not authenticated: `gh auth token` exits non-zero. The
    // oracle treats that as "no token" and raises the no-auth setup error.
    const runner = new FakeCommandRunner((command, args) => {
      if (command === 'command' && args[0] === '-v') {
        return { status: 0, stdout: `/usr/bin/${args[1]}\n`, stderr: '' };
      }
      if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') {
        return { status: 1, stdout: '', stderr: 'not logged in' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    withEnv({ ...clearedAuthEnv(), SUPERPOWERS_ROOT: sp.root }, () => {
      expect(() => new CopilotAgent(CONFIG).provision(home, runner)).toThrow(
        /no Copilot auth found/,
      );
    });
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision throws ProvisionError when no auth is present', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    withEnv({ ...clearedAuthEnv(), SUPERPOWERS_ROOT: sp.root }, () => {
      // Binary present so the no-auth branch (not the PATH check) is what throws.
      expect(() =>
        new CopilotAgent(CONFIG).provision(home, copilotPresentRunner()),
      ).toThrow(/no Copilot auth found/);
    });
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision throws ProvisionError when SUPERPOWERS_ROOT is unset', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      { ...clearedAuthEnv(), COPILOT_GITHUB_TOKEN: 'ghp_test_token' },
      () => {
        // The root check precedes the PATH check, so a bare runner is fine.
        expect(() =>
          new CopilotAgent(CONFIG).provision(home, new FakeCommandRunner()),
        ).toThrow(/SUPERPOWERS_ROOT not set/);
      },
    );
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when a required plugin file is missing', () => {
  const sp = makeSuperpowersRoot();
  // Remove one required file so staging-source verification fails.
  rmSync(join(sp.root, 'skills', 'brainstorming', 'SKILL.md'));
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        // Staging-source verification precedes the PATH check.
        expect(() =>
          new CopilotAgent(CONFIG).provision(home, new FakeCommandRunner()),
        ).toThrow(/missing required Copilot Superpowers files/);
      },
    );
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provision throws ProvisionError when offline lacks a provider base url', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_OFFLINE: 'true',
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        expect(() =>
          new CopilotAgent(CONFIG).provision(home, copilotPresentRunner()),
        ).toThrow(/COPILOT_OFFLINE=true requires COPILOT_PROVIDER_BASE_URL/);
      },
    );
  } finally {
    cleanup();
    sp.cleanup();
  }
});

// A copilot-binary responder: replies success to `command -v copilot` (and
// `command -v gh` so the gh fallback probe behaves) and OK to everything else.
function copilotPresentRunner(): FakeCommandRunner {
  return new FakeCommandRunner((command, args) => {
    if (command === 'command' && args[0] === '-v') {
      return { status: 0, stdout: `/usr/bin/${args[1]}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
}

test('provision fails fast when the copilot binary is not on PATH', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    // `command -v copilot` exits non-zero: the oracle raises a clear setup error
    // (shutil.which("copilot") is None) before any provisioning subprocess.
    const runner = new FakeCommandRunner((command, args) => {
      if (command === 'command' && args[0] === '-v' && args[1] === 'copilot') {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        expect(() => new CopilotAgent(CONFIG).provision(home, runner)).toThrow(
          /copilot not found on PATH/,
        );
      },
    );
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provisionCopilot guards a pre-existing session-state events.jsonl', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    const sessionId = 'sess-abc-123';
    // Stale capturable session-state from a prior run would corrupt the diff;
    // the oracle raises a setup error if it exists before the snapshot.
    const stale = join(
      home.configDir,
      'session-state',
      sessionId,
      'events.jsonl',
    );
    mkdirSync(join(stale, '..'), { recursive: true });
    writeFileSync(stale, '{"stale":true}\n');

    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        const provisionStale = () =>
          new CopilotAgent(CONFIG).provisionCopilot(
            home,
            copilotPresentRunner(),
            sessionId,
          );
        expect(provisionStale).toThrow(ProvisionError);
        expect(provisionStale).toThrow(/pre-existing Copilot session-state/);
      },
    );
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('provisionCopilot returns the secret values, env file, and session-state path', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    const sessionId = 'sess-xyz-999';
    let result: ReturnType<CopilotAgent['provisionCopilot']> | undefined;
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_GITHUB_TOKEN: 'ghp_secret_value',
      },
      () => {
        result = new CopilotAgent(CONFIG).provisionCopilot(
          home,
          copilotPresentRunner(),
          sessionId,
        );
      },
    );
    expect(result).toBeDefined();
    const provisioning = result as NonNullable<typeof result>;
    expect(provisioning.sessionId).toBe(sessionId);
    expect(provisioning.envFile).toBe(join(home.configDir, '.copilot-env'));
    expect(provisioning.secretNames).toEqual(['COPILOT_GITHUB_TOKEN']);
    expect(provisioning.secretValues).toEqual(['ghp_secret_value']);
    expect(provisioning.expectedEventsLog).toBe(
      join(home.configDir, 'session-state', sessionId, 'events.jsonl'),
    );
    expect(provisioning.env).toEqual({ COPILOT_HOME: home.configDir });
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('scanCopilotSecretLeaks finds the secret in a run artifact and excludes the env file', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'copilot-leak-'));
  try {
    const secret = 'ghp_leaky_secret';
    // The env file legitimately contains the secret and is excluded.
    const envFile = join(runDir, '.copilot-env');
    writeFileSync(envFile, `COPILOT_GITHUB_TOKEN='${secret}'\n`);
    // A leaked copy in a non-secret artifact must be reported.
    const leaked = join(runDir, 'logs', 'transcript.txt');
    mkdirSync(join(leaked, '..'), { recursive: true });
    writeFileSync(leaked, `prompt used token ${secret} oops\n`);
    // A clean artifact must not be reported.
    const clean = join(runDir, 'logs', 'clean.txt');
    writeFileSync(clean, 'nothing to see here\n');

    const leaks = scanCopilotSecretLeaks(runDir, [secret], [envFile]);
    expect(leaks).toEqual([leaked]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('scanCopilotSecretLeaks returns nothing when there are no secret values', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'copilot-leak-'));
  try {
    writeFileSync(join(runDir, 'a.txt'), 'anything\n');
    expect(scanCopilotSecretLeaks(runDir, [], [])).toEqual([]);
    expect(scanCopilotSecretLeaks(runDir, [''], [])).toEqual([]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// A separate test where the runner is wired with a failing responder confirms
// provision() never touches the runner for provisioning subprocesses beyond the
// binary/gh probes: provisioning shells out to nothing else.
test('provision runs no provisioning subprocess beyond the binary/auth probes', () => {
  const sp = makeSuperpowersRoot();
  const { home, cleanup } = makeTempHome();
  try {
    const runner = copilotPresentRunner();
    withEnv(
      {
        ...clearedAuthEnv(),
        SUPERPOWERS_ROOT: sp.root,
        COPILOT_GITHUB_TOKEN: 'ghp_test_token',
      },
      () => {
        const returned = new CopilotAgent(CONFIG).provision(home, runner);
        expect(returned).toEqual({ COPILOT_HOME: home.configDir });
      },
    );
    // Only the `command -v copilot` PATH probe ran; auth came from the env var
    // so the gh fallback was never invoked.
    expect(runner.calls).toEqual([
      {
        command: 'command',
        args: ['-v', 'copilot'],
        options: { env: expect.anything() },
      },
    ]);
  } finally {
    cleanup();
    sp.cleanup();
  }
});

test('copilotGauntletEnv projects host env onto the allowlist and drops the rest', () => {
  const env = copilotGauntletEnv({
    PATH: '/usr/bin',
    TERM: 'xterm',
    ANTHROPIC_API_KEY: 'sk-allowed',
    // Not on the allowlist: must be dropped.
    COPILOT_GITHUB_TOKEN: 'ghp_secret',
    SOME_RANDOM_VAR: 'nope',
    // Undefined values are skipped, not written as the string "undefined".
    LANG: undefined,
  });
  expect(env).toEqual({
    PATH: '/usr/bin',
    TERM: 'xterm',
    ANTHROPIC_API_KEY: 'sk-allowed',
  });
});

test('copilotGauntletEnv passes a clean proxy URL and rejects a credentialed one', () => {
  // A bare host:port proxy is fine.
  expect(
    copilotGauntletEnv({ HTTPS_PROXY: 'http://proxy.example:8080' }),
  ).toEqual({ HTTPS_PROXY: 'http://proxy.example:8080' });
  // user:pass@ in the authority must be rejected so the proxy password never
  // reaches the agent process (oracle _proxy_url_has_userinfo).
  expect(() =>
    copilotGauntletEnv({ HTTPS_PROXY: 'http://user:pass@proxy.example:8080' }),
  ).toThrow(/credentialed proxy URL/);
});
