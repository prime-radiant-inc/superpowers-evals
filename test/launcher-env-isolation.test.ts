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
function installLauncher(agent: 'claude' | 'codex'): {
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
  writeFileSync(
    envFile,
    agent === 'claude'
      ? "ANTHROPIC_API_KEY='sk-test-launcher'\n"
      : "CODEX_PROVIDER_API_KEY='sk-codex-test'\n",
  );

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
