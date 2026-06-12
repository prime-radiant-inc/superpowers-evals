import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAgentConfig,
  substituteEnv,
} from '../src/contracts/agent-config.ts';

test('loads claude.yaml into a typed AgentConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeFileSync(
    join(dir, 'claude.yaml'),
    [
      'name: claude',
      'runtime_family: claude',
      'binary: claude',
      'agent_config_env: CLAUDE_CONFIG_DIR',
      'session_log_dir: "${CLAUDE_CONFIG_DIR}/projects"',
      'session_log_glob: "**/*.jsonl"',
      'normalizer: claude',
      'required_env:',
      '  - ANTHROPIC_API_KEY',
      'max_time: 10m',
      'model: opus',
    ].join('\n'),
  );
  const cfg = loadAgentConfig(dir, 'claude');
  expect(cfg.name).toBe('claude');
  expect(cfg.required_env).toEqual(['ANTHROPIC_API_KEY']);
  expect(cfg.session_log_glob).toBe('**/*.jsonl');
  expect(cfg.max_concurrency).toBeUndefined();
});

test('substituteEnv replaces ${VAR} from a provided map', () => {
  expect(
    substituteEnv('${CLAUDE_CONFIG_DIR}/projects', {
      CLAUDE_CONFIG_DIR: '/tmp/cfg',
    }),
  ).toBe('/tmp/cfg/projects');
});

test('substituteEnv leaves unknown vars intact', () => {
  expect(substituteEnv('${UNKNOWN}/x', { OTHER: 'y' })).toBe('${UNKNOWN}/x');
});
