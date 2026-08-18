import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { shellSingleQuote } from '../src/agents/index.ts';
import { populateContextDir } from '../src/runner/context.ts';
import { homeEnvSubstitutions } from '../src/runner/index.ts';

const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

type LauncherAgent =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'kimi'
  | 'pi'
  | 'hermes'
  | 'antigravity';

// Context handed to per-agent fixture builders.
interface FixtureCtx {
  // The per-run temp dir the launcher template is installed under.
  readonly runDir: string;
  // Absolute path of the fake env-dumping agent binary.
  readonly fakeBinary: string;
}

// Everything installLauncher needs to run one agent's REAL launcher template
// against fakes: the env-dumping binary name, the env-file fixture (for
// launchers that source a per-run env file) plus the substitution key(s) the
// template reads the path through, agent-specific template substitutions, and
// extra fake commands the launcher invokes before exec'ing the agent.
interface LauncherFixture {
  readonly binary: string;
  readonly envFile?: {
    readonly defaultContent: string;
    readonly substitutions: (envFile: string) => Record<string, string>;
  };
  readonly substitutions?: (ctx: FixtureCtx) => Record<string, string>;
  readonly extraBinaries?: (ctx: FixtureCtx) => Record<string, string>;
}

// Every Linux-local launcher has an entry (claude-windows delegates its env to
// the Windows guest's launch.cmd, so there is no local launcher to test);
// installLauncher throws on a missing entry so an uncovered agent fails loudly.
const FIXTURES: Partial<Record<LauncherAgent, LauncherFixture>> = {
  claude: {
    binary: 'claude',
    envFile: {
      defaultContent: "ANTHROPIC_API_KEY='sk-test-launcher'\n",
      substitutions: (envFile) => ({ $CLAUDE_ENV_FILE: envFile }),
    },
    substitutions: () => ({ $CLAUDE_MODEL: 'test-model' }),
  },
  codex: {
    binary: 'codex',
    envFile: {
      defaultContent: "CODEX_PROVIDER_API_KEY='sk-codex-test'\n",
      substitutions: (envFile) => ({ $CODEX_ENV_FILE: envFile }),
    },
  },
  gemini: {
    binary: 'gemini',
    // Api-key mode: .gemini-env sets GEMINI_API_KEY (gemini.ts writes an empty
    // file in OAuth mode). The template reads pre-quoted _SH substitutions.
    envFile: {
      defaultContent: "GEMINI_API_KEY='sk-gemini-test'\n",
      substitutions: (envFile) => ({
        $GEMINI_ENV_FILE_SH: shellSingleQuote(envFile),
      }),
    },
    substitutions: () => ({
      $GEMINI_AUTH_TYPE_SH: shellSingleQuote('gemini-api-key'),
    }),
  },
  kimi: {
    binary: 'kimi',
    // Sorted KEY='value' lines, the writeKimiRuntimeEnvFile format. The
    // launcher deletes this file after sourcing — a disposable tmpdir file.
    envFile: {
      defaultContent:
        "KIMI_DISABLE_TELEMETRY='1'\n" +
        "KIMI_MODEL_API_KEY='sk-kimi-test'\n" +
        "KIMI_MODEL_NAME='kimi-test-model'\n",
      substitutions: (envFile) => ({ $KIMI_ENV_FILE: envFile }),
    },
    // Production substitutes $KIMI_BINARY with a single-quoted resolved path.
    substitutions: ({ fakeBinary }) => ({
      $KIMI_BINARY: shellSingleQuote(fakeBinary),
    }),
  },
  pi: {
    binary: 'pi',
    // The writePiEnvFile format: export lines for PI_PROVIDER/PI_MODEL and an
    // optional PI_API_KEY (both call sites pass empty extraEnv).
    envFile: {
      defaultContent:
        "export PI_PROVIDER='quorum'\n" +
        "export PI_MODEL='pi-test-model'\n" +
        "export PI_API_KEY='sk-pi-test'\n",
      substitutions: (envFile) => ({ $PI_ENV_FILE: envFile }),
    },
    // The launcher resolves "$(npm root -g)/pi-subagents" and exits if the
    // dir is absent, so the fake npm prints a root that contains it.
    extraBinaries: ({ runDir }) => {
      const npmRoot = join(runDir, 'npm-root');
      mkdirSync(join(npmRoot, 'pi-subagents'), { recursive: true });
      return { npm: `#!/bin/sh\necho '${npmRoot}'\n` };
    },
  },
  // No env file: the provider key is a file at ~/.hermes/.env inside the
  // throwaway home (seeded by provisioning), so nothing secret rides the env.
  hermes: {
    binary: 'hermes',
  },
  // No env file: OAuth creds are files in the throwaway home's .gemini. The
  // template's $QUORUM_AGENT_HOME arrives via homeEnvSubstitutions.
  antigravity: {
    binary: 'agy',
  },
};

// Substitute a real launcher template into a temp "run dir" and return the
// installed launcher path plus its env-file/home fixture paths.
function installLauncher(
  agent: LauncherAgent,
  opts: {
    omitEnvFile?: boolean;
    envFileContent?: string;
    // Per-test overrides applied after the fixture's substitutions (e.g. the
    // gemini OAuth test pins $GEMINI_AUTH_TYPE_SH to 'oauth-personal').
    substitutions?: Record<string, string>;
  } = {},
): {
  launcher: string;
  binDir: string;
  envDump: string;
  envFile: string;
} {
  const fixture = FIXTURES[agent];
  if (fixture === undefined) {
    throw new Error(`no launcher fixture for agent '${agent}'`);
  }
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const home = join(runDir, 'home');
  mkdirSync(home, { recursive: true });
  const cwd = join(runDir, 'workdir');
  mkdirSync(cwd);

  // A fake agent binary that dumps its environment and exits.
  const binDir = mkdtempSync(join(tmpdir(), 'bin-'));
  const envDump = join(runDir, 'env-dump.txt');
  const fake = join(binDir, fixture.binary);
  writeFileSync(fake, `#!/bin/sh\nenv > '${envDump}'\n`);
  chmodSync(fake, 0o755);
  const ctx: FixtureCtx = { runDir, fakeBinary: fake };
  for (const [name, body] of Object.entries(
    fixture.extraBinaries?.(ctx) ?? {},
  )) {
    const path = join(binDir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  // The env file the launcher sources (agents that have one).
  const envFile = join(runDir, `${agent}.env`);
  let envFileSubs: Record<string, string> = {};
  if (fixture.envFile !== undefined) {
    if (!opts.omitEnvFile) {
      writeFileSync(
        envFile,
        opts.envFileContent ?? fixture.envFile.defaultContent,
      );
    }
    envFileSubs = fixture.envFile.substitutions(envFile);
  }

  const substitutions: Record<string, string> = {
    $QUORUM_AGENT_CWD: cwd,
    $QUORUM_AGENT_CWD_SH: shellSingleQuote(cwd),
    $SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sp-')),
    ...homeEnvSubstitutions(home),
    ...envFileSubs,
    ...(fixture.substitutions?.(ctx) ?? {}),
    ...(opts.substitutions ?? {}),
  };
  populateContextDir({
    codingAgentsDir: REAL_CODING_AGENTS,
    codingAgent: agent,
    runDir,
    substitutions,
    required: true,
  });
  return {
    launcher: join(runDir, 'gauntlet-agent', 'context', 'launch-agent'),
    binDir,
    envDump,
    envFile,
  };
}

// Parse an `env` dump into a map.
function parseEnvDump(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

// Hostile host env every launcher must scrub (PRI-2494; per-agent provider
// keys added by F13).
const HOSTILE = {
  ANTHROPIC_BASE_URL: 'http://evil.example',
  ANTHROPIC_AUTH_TOKEN: 'evil-token',
  ANTHROPIC_MODEL: 'evil-model',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_MANTLE: '1',
  AWS_ACCESS_KEY_ID: 'AKIA-host',
  AWS_SECRET_ACCESS_KEY: 'host-secret',
  AWS_SESSION_TOKEN: 'host-session-token',
  AWS_PROFILE: 'host-profile',
  AWS_REGION: 'eu-evil-1',
  AWS_DEFAULT_REGION: 'eu-evil-1',
  AWS_BEARER_TOKEN_BEDROCK: 'host-bearer-EVIL',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'host-session',
  OPENAI_API_KEY: 'sk-host-openai',
  OPENAI_BASE_URL: 'http://evil-openai.example',
  OPENAI_ORG_ID: 'evil-org',
  GEMINI_API_KEY: 'sk-host-gemini',
  GOOGLE_API_KEY: 'sk-host-google',
  KIMI_MODEL_API_KEY: 'sk-host-kimi',
  PI_API_KEY: 'sk-host-pi',
  OPENROUTER_API_KEY: 'sk-host-openrouter',
  SOME_RANDOM_HOST_VAR: 'leaked',
};

// Assert every hostile key is absent from the dump — or, where the launcher's
// own env file deliberately sets the same name, carries exactly the FILE's
// value (never the hostile host value).
function expectHostileScrubbed(
  env: Record<string, string>,
  overrides: Record<string, string> = {},
): void {
  for (const key of Object.keys(HOSTILE)) {
    expect({ key, value: env[key] }).toEqual({ key, value: overrides[key] });
  }
}

function launchAndDump(agent: LauncherAgent): Record<string, string> {
  const { launcher, binDir, envDump } = installLauncher(agent);
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: {
      ...HOSTILE,
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: '/host/home',
    },
  });
  expect(proc.status).toBe(0);
  return parseEnvDump(envDump);
}

test('claude launcher: hostile host env never reaches the agent', () => {
  const env = launchAndDump('claude');
  expectHostileScrubbed(env);
  // The deliberate vars DO reach it.
  expect(env['ANTHROPIC_API_KEY']).toBe('sk-test-launcher');
  expect(env['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE']).toBe('1');
  expect(env['HOME']).not.toBe('/host/home');
  expect(env['HOME']).toContain('home');
});

test('codex launcher: hostile host env never reaches the agent', () => {
  const env = launchAndDump('codex');
  expectHostileScrubbed(env);
  // The api-key path's provider key DOES reach it (sourced from CODEX_ENV_FILE).
  expect(env['CODEX_PROVIDER_API_KEY']).toBe('sk-codex-test');
  expect(env['HOME']).not.toBe('/host/home');
});

test('claude launcher: Mantle .claude-env forwards seeded vars, drops the key, scrubs host AWS', () => {
  const { launcher, binDir, envDump } = installLauncher('claude', {
    envFileContent:
      "CLAUDE_CODE_USE_MANTLE=1\nAWS_REGION='us-east-1'\nAWS_BEARER_TOKEN_BEDROCK='seeded-bearer-OK'\n",
  });
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: {
      ...HOSTILE,
      // A host-exported direct-API key must not leak onto the Mantle path
      // (the regression Task 6 fixed) — HOSTILE itself omits this key so the
      // all-undefined loop above stays valid; set it only here.
      ANTHROPIC_API_KEY: 'sk-host-EVIL',
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: '/host/home',
    },
  });
  expect(proc.status).toBe(0);
  const env = parseEnvDump(envDump);
  // Seeded values reach the agent — NOT the hostile host values.
  expect(env['CLAUDE_CODE_USE_MANTLE']).toBe('1');
  expect(env['AWS_REGION']).toBe('us-east-1');
  expect(env['AWS_BEARER_TOKEN_BEDROCK']).toBe('seeded-bearer-OK');
  // The direct key is absent on the Mantle path, even though the host set one.
  expect(env['ANTHROPIC_API_KEY']).toBe(undefined);
  // Host AWS creds the .claude-env did NOT set are still scrubbed.
  expect(env['AWS_ACCESS_KEY_ID']).toBe(undefined);
  expect(env['AWS_SESSION_TOKEN']).toBe(undefined);
  expect(env['AWS_PROFILE']).toBe(undefined);
});

test('codex launcher: subscription path (no env file) forwards no provider key', () => {
  const { launcher, binDir, envDump } = installLauncher('codex', {
    omitEnvFile: true,
  });
  // Simulate the subscription path: the substituted CODEX_ENV_FILE does not
  // exist. installLauncher wrote it; point the launcher at a missing one by
  // re-substituting is overkill — instead delete the file it sources.
  // The launcher's `[ -f "$CODEX_ENV_FILE" ] && .` guard makes this the
  // subscription path exactly.
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: { ...HOSTILE, PATH: `${binDir}:/usr/bin:/bin`, HOME: '/host/home' },
  });
  expect(proc.status).toBe(0);
  const env = parseEnvDump(envDump);
  expect(env['CODEX_PROVIDER_API_KEY']).toBe(undefined);
  expect(env['HOME']).not.toBe('/host/home');
});

test('gemini launcher: hostile host env never reaches the agent; .gemini-env key wins', () => {
  const env = launchAndDump('gemini');
  // The env file's GEMINI_API_KEY overrides the hostile host value.
  expectHostileScrubbed(env, { GEMINI_API_KEY: 'sk-gemini-test' });
  // The deliberate vars DO reach it.
  expect(env['GEMINI_DEFAULT_AUTH_TYPE']).toBe('gemini-api-key');
  expect(env['GEMINI_CLI_TRUST_WORKSPACE']).toBe('true');
  expect(env['HOME']).not.toBe('/host/home');
  expect(env['HOME']).toContain('home');
  expect(env['PATH']).toBeTruthy();
});

test('kimi launcher: hostile host env never reaches the agent; runtime env file forwards', () => {
  const { launcher, binDir, envDump, envFile } = installLauncher('kimi');
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: { ...HOSTILE, PATH: `${binDir}:/usr/bin:/bin`, HOME: '/host/home' },
  });
  expect(proc.status).toBe(0);
  const env = parseEnvDump(envDump);
  // The runtime env file's key overrides the hostile host value.
  expectHostileScrubbed(env, { KIMI_MODEL_API_KEY: 'sk-kimi-test' });
  // Model env + runtime flags from the file DO reach it.
  expect(env['KIMI_MODEL_NAME']).toBe('kimi-test-model');
  expect(env['KIMI_DISABLE_TELEMETRY']).toBe('1');
  expect(env['HOME']).not.toBe('/host/home');
  expect(env['PATH']).toBeTruthy();
  // Existing contract preserved: the secret env file is deleted after sourcing.
  expect(existsSync(envFile)).toBe(false);
});

test('pi launcher: hostile host env never reaches the agent; pi.env key wins', () => {
  const env = launchAndDump('pi');
  // The pi.env PI_API_KEY overrides the hostile host value.
  expectHostileScrubbed(env, { PI_API_KEY: 'sk-pi-test' });
  // pi.env values + the launcher's telemetry opt-outs DO reach it.
  expect(env['PI_PROVIDER']).toBe('quorum');
  expect(env['PI_MODEL']).toBe('pi-test-model');
  expect(env['PI_OFFLINE']).toBe('1');
  expect(env['PI_TELEMETRY']).toBe('0');
  expect(env['HOME']).not.toBe('/host/home');
  expect(env['PATH']).toBeTruthy();
});

test('gemini launcher: OAuth mode (empty .gemini-env) drops a hostile host GEMINI_API_KEY', () => {
  const { launcher, binDir, envDump } = installLauncher('gemini', {
    // OAuth mode: provisioning writes an EMPTY .gemini-env (creds are files in
    // the throwaway home) and substitutes the oauth auth type.
    envFileContent: '',
    substitutions: { $GEMINI_AUTH_TYPE_SH: shellSingleQuote('oauth-personal') },
  });
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: { ...HOSTILE, PATH: `${binDir}:/usr/bin:/bin`, HOME: '/host/home' },
  });
  expect(proc.status).toBe(0);
  const env = parseEnvDump(envDump);
  // No override: the file OWNS GEMINI_API_KEY and omitted it, so omission
  // stays omission even though the hostile host exported the same name.
  expectHostileScrubbed(env);
  expect(env['GEMINI_DEFAULT_AUTH_TYPE']).toBe('oauth-personal');
  expect(env['HOME']).not.toBe('/host/home');
});

test('kimi launcher: OAuth-mode env file (no model key) drops hostile host KIMI_MODEL_API_KEY and file-omitted proxies', () => {
  const { launcher, binDir, envDump, envFile } = installLauncher('kimi', {
    // OAuth mode: buildKimiSubprocessEnv gets kimiModelEnv {} — the file holds
    // only base passthrough names, no KIMI_MODEL_*.
    envFileContent: "SHELL='/bin/zsh'\n",
  });
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: {
      ...HOSTILE,
      HTTPS_PROXY: 'http://evil-proxy.example:3128',
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: '/host/home',
    },
  });
  expect(proc.status).toBe(0);
  const env = parseEnvDump(envDump);
  expectHostileScrubbed(env);
  // The file's own value repopulates after the pre-source unset…
  expect(env['SHELL']).toBe('/bin/zsh');
  // …but a file-omitted forwardable name stays absent even when the host
  // exported it.
  expect(env['HTTPS_PROXY']).toBe(undefined);
  expect(existsSync(envFile)).toBe(false);
});

test('pi launcher: OAuth-mode pi.env (no PI_API_KEY) drops a hostile host PI_API_KEY', () => {
  const { launcher, binDir, envDump } = installLauncher('pi', {
    envFileContent:
      "export PI_PROVIDER='openai-codex'\nexport PI_MODEL='gpt-5.5-codex'\n",
  });
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: { ...HOSTILE, PATH: `${binDir}:/usr/bin:/bin`, HOME: '/host/home' },
  });
  expect(proc.status).toBe(0);
  const env = parseEnvDump(envDump);
  // PI_API_KEY is in HOSTILE with no override: omission stays omission.
  expectHostileScrubbed(env);
  expect(env['PI_PROVIDER']).toBe('openai-codex');
  expect(env['PI_MODEL']).toBe('gpt-5.5-codex');
});

test('pi launcher: file-omitted PI_MODEL is not backfilled by a hostile host value', () => {
  const { launcher, binDir, envDump } = installLauncher('pi', {
    envFileContent: "export PI_PROVIDER='openai-codex'\n",
  });
  // The host exports the name pi.env omitted: the launcher must fail loudly
  // under set -u, never launch with the hostile model.
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: {
      ...HOSTILE,
      PI_MODEL: 'evil-model',
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: '/host/home',
    },
  });
  expect(proc.status).not.toBe(0);
  expect(existsSync(envDump)).toBe(false);
});

test('pi launcher: missing pi.env fails loudly, never launches', () => {
  const { launcher, binDir, envDump } = installLauncher('pi', {
    omitEnvFile: true,
  });
  // Unlike codex's guarded subscription path, pi REQUIRES pi.env: sourcing a
  // missing file under `set -e` aborts before exec, so a provisioning gap is
  // loud, not a silently credential-less launch.
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: { ...HOSTILE, PATH: `${binDir}:/usr/bin:/bin`, HOME: '/host/home' },
  });
  expect(proc.status).not.toBe(0);
  expect(existsSync(envDump)).toBe(false);
});

test('hermes launcher: hostile host env never reaches the agent', () => {
  const env = launchAndDump('hermes');
  // hermes has no env file — its provider key is a file inside the throwaway
  // home — so nothing beyond the base trio + home pins may survive the wall.
  expectHostileScrubbed(env);
  expect(env['HOME']).not.toBe('/host/home');
  expect(env['HOME']).toContain('home');
  expect(env['PATH']).toBeTruthy();
});

test('antigravity launcher: hostile host env never reaches the agent', () => {
  const env = launchAndDump('antigravity');
  // antigravity has no env file — OAuth creds are files in the throwaway
  // home's .gemini — so only the launcher-pinned vars may ride the wall.
  expectHostileScrubbed(env);
  expect(env['AGY_CLI_DISABLE_AUTO_UPDATE']).toBe('true');
  // The config dir IS the throwaway home (antigravity.yaml home_config_subdir
  // "."), so the pinned value must equal the launcher's HOME pin.
  expect(env['ANTIGRAVITY_CONFIG_DIR']).toBe(env['HOME']);
  expect(env['HOME']).not.toBe('/host/home');
  expect(env['HOME']).toContain('home');
  expect(env['PATH']).toBeTruthy();
});
