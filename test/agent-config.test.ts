import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  CodingAgentConfigError,
  loadAgentConfig,
  substituteEnv,
} from '../src/contracts/agent-config.ts';

// A claude.yaml whose only variable is the project_prompt reference.
function writeClaudeYaml(dir: string, projectPrompt: string | undefined): void {
  const lines = [
    'name: claude',
    'runtime_family: claude',
    'binary: claude',
    'agent_config_env: CLAUDE_CONFIG_DIR',
    'session_log_dir: "${CLAUDE_CONFIG_DIR}/projects"',
    'session_log_glob: "**/*.jsonl"',
    'normalizer: claude',
    'required_env:',
    '  - ANTHROPIC_API_KEY',
  ];
  if (projectPrompt !== undefined) {
    lines.push(`project_prompt: ${projectPrompt}`);
  }
  writeFileSync(join(dir, 'claude.yaml'), `${lines.join('\n')}\n`);
}

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

test('loadAgentConfig resolves project_prompt to an absolute existing path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeFileSync(join(dir, 'claude.project-prompt.md'), '# prompt\n');
  writeClaudeYaml(dir, 'claude.project-prompt.md');
  const cfg = loadAgentConfig(dir, 'claude');
  expect(cfg.project_prompt).toBeDefined();
  // Resolved relative to the yaml dir, to an absolute path.
  expect(isAbsolute(cfg.project_prompt ?? '')).toBe(true);
  expect(cfg.project_prompt).toBe(join(dir, 'claude.project-prompt.md'));
});

test('loadAgentConfig errors when project_prompt does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  // No project-prompt file written.
  writeClaudeYaml(dir, 'claude.project-prompt.md');
  expect(() => loadAgentConfig(dir, 'claude')).toThrow(CodingAgentConfigError);
});

test('loadAgentConfig leaves project_prompt undefined when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeClaudeYaml(dir, undefined);
  const cfg = loadAgentConfig(dir, 'claude');
  expect(cfg.project_prompt).toBeUndefined();
});
