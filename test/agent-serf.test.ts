import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProvisionError } from '../src/agents/index.ts';
import { SerfAgent } from '../src/agents/serf.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { makeTempHome } from './provision-helpers.ts';

// A serf.yaml-shaped config. binary defaults to `sh` (always on PATH) so the
// non-binary validations are reachable; tests override binary to probe the
// PATH check.
function serfConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    name: 'serf',
    runtime_family: 'serf',
    binary: 'sh',
    home_config_subdir: '.serf',
    session_log_dir: '${QUORUM_AGENT_HOME}/.serf/exports',
    session_log_glob: '*.json',
    normalizer: 'serf',
    required_env: ['ANTHROPIC_API_KEY', 'SUPERPOWERS_ROOT'],
    os_support: ['linux'],
    max_time: '10m',
    model: 'anthropic/claude-sonnet-4-6',
    ...overrides,
  };
}

// Files SerfAgent.provision requires under SUPERPOWERS_ROOT (the --plugin-dir
// target, used un-staged like the claude adapter).
function stageSuperpowers(root: string): void {
  for (const rel of [
    '.claude-plugin/plugin.json',
    'hooks/hooks.json',
    'hooks/run-hook.cmd',
    'hooks/session-start',
    'skills/using-superpowers/SKILL.md',
    'skills/brainstorming/SKILL.md',
  ]) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '#\n');
  }
}

function withEnv(superpowersRoot: string | undefined, body: () => void): void {
  const prev = process.env['SUPERPOWERS_ROOT'];
  if (superpowersRoot === undefined) {
    delete process.env['SUPERPOWERS_ROOT'];
  } else {
    process.env['SUPERPOWERS_ROOT'] = superpowersRoot;
  }
  try {
    body();
  } finally {
    if (prev === undefined) {
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      process.env['SUPERPOWERS_ROOT'] = prev;
    }
  }
}

test('provision creates the isolated config + exports dirs on success', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      const env = new SerfAgent(serfConfig()).provision(home);
      expect(env).toEqual({});
      expect(existsSync(home.configDir)).toBe(true);
      expect(existsSync(join(home.configDir, 'exports'))).toBe(true);
    });
  } finally {
    cleanup();
  }
});

test('provision throws when the serf binary is not on PATH', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers');
  stageSuperpowers(spRoot);
  try {
    withEnv(spRoot, () => {
      const cfg = serfConfig({ binary: 'serf-not-a-real-binary-zzz' });
      expect(() => new SerfAgent(cfg).provision(home)).toThrow(ProvisionError);
    });
  } finally {
    cleanup();
  }
});

test('provision throws when SUPERPOWERS_ROOT is unset', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv(undefined, () => {
      expect(() => new SerfAgent(serfConfig()).provision(home)).toThrow(
        /SUPERPOWERS_ROOT not set/,
      );
    });
  } finally {
    cleanup();
  }
});

test('provision throws when SUPERPOWERS_ROOT is missing plugin files', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, 'superpowers-empty');
  mkdirSync(spRoot, { recursive: true });
  try {
    withEnv(spRoot, () => {
      expect(() => new SerfAgent(serfConfig()).provision(home)).toThrow(
        /missing required Superpowers plugin files/,
      );
    });
  } finally {
    cleanup();
  }
});
