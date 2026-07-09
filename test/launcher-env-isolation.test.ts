import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { populateContextDir } from '../src/runner/context.ts';
import { homeEnvSubstitutions } from '../src/runner/index.ts';

const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

// Substitute a real launcher template into a temp "run dir" and return the
// installed launcher path plus its env-file/home fixture paths.
function installLauncher(
  agent: 'claude' | 'codex',
  opts: { omitEnvFile?: boolean; envFileContent?: string } = {},
): {
  launcher: string;
  binDir: string;
  envDump: string;
} {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const home = join(runDir, 'home');
  mkdirSync(home, { recursive: true });
  const cwd = join(runDir, 'workdir');
  mkdirSync(cwd);

  // A fake agent binary that dumps its environment and exits.
  const binDir = mkdtempSync(join(tmpdir(), 'bin-'));
  const envDump = join(runDir, 'env-dump.txt');
  const fake = join(binDir, agent === 'claude' ? 'claude' : 'codex');
  writeFileSync(fake, `#!/bin/sh\nenv > '${envDump}'\n`);
  chmodSync(fake, 0o755);

  // The env file each launcher sources.
  const envFile = join(runDir, `${agent}.env`);
  if (!opts.omitEnvFile) {
    const dflt =
      agent === 'claude'
        ? "ANTHROPIC_API_KEY='sk-test-launcher'\n"
        : "CODEX_PROVIDER_API_KEY='sk-codex-test'\n";
    writeFileSync(envFile, opts.envFileContent ?? dflt);
  }

  const substitutions: Record<string, string> = {
    $QUORUM_AGENT_CWD: cwd,
    $SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sp-')),
    ...homeEnvSubstitutions(home),
    ...(agent === 'claude'
      ? { $CLAUDE_ENV_FILE: envFile, $CLAUDE_MODEL: 'test-model' }
      : { $CODEX_ENV_FILE: envFile }),
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

// Hostile host env every launcher must scrub (PRI-2494).
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
  SOME_RANDOM_HOST_VAR: 'leaked',
};

function launchAndDump(agent: 'claude' | 'codex'): Record<string, string> {
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
  for (const key of Object.keys(HOSTILE)) {
    expect({ key, value: env[key] }).toEqual({ key, value: undefined });
  }
  // The deliberate vars DO reach it.
  expect(env['ANTHROPIC_API_KEY']).toBe('sk-test-launcher');
  expect(env['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE']).toBe('1');
  expect(env['HOME']).not.toBe('/host/home');
  expect(env['HOME']).toContain('home');
});

test('codex launcher: hostile host env never reaches the agent', () => {
  const env = launchAndDump('codex');
  for (const key of Object.keys(HOSTILE)) {
    expect({ key, value: env[key] }).toEqual({ key, value: undefined });
  }
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
