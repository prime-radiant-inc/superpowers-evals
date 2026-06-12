import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');

function scenario(): string {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(
    join(scn, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.',
  );
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scn;
}

function agentsDir(): string {
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
    ].join('\n'),
  );
  return dir;
}

function runCli(fixture: string): { status: number | null; stdout: string } {
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run',
      scenario(),
      '--coding-agent',
      'claude',
      '--coding-agents-dir',
      agentsDir(),
      '--out-root',
      mkdtempSync(join(tmpdir(), 'out-')),
    ],
    {
      env: {
        ...process.env,
        PATH: `${MOCK}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        MOCK_GAUNTLET_FIXTURE: fixture,
      },
      encoding: 'utf8',
    },
  );
  return { status: proc.status, stdout: proc.stdout };
}

test('quorum run exits 1 on a fail verdict and prints run-id', () => {
  const { status, stdout } = runCli('fail-no-usage');
  expect(stdout).toContain('run-id:');
  expect(status).toBe(1);
});

test('quorum run exits 0 on a pass verdict', () => {
  const { status, stdout } = runCli('pass');
  expect(stdout).toContain('run-id:');
  expect(status).toBe(0);
});
