import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');
// The REAL coding-agents/ dir: the runner now requires claude-context/ +
// claude.project-prompt.md for a claude run, and both live here (a synthetic
// fixture would lack them). Its session_log_dir is the same
// ${CLAUDE_CONFIG_DIR}/projects the mock-gauntlet seeds.
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

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

function runCli(
  fixture: string,
  extraArgs: string[] = [],
): { status: number | null; stdout: string } {
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run',
      scenario(),
      '--coding-agent',
      'claude',
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      mkdtempSync(join(tmpdir(), 'out-')),
      ...extraArgs,
    ],
    {
      env: {
        ...process.env,
        PATH: `${MOCK}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        // The real claude.yaml lists SUPERPOWERS_ROOT in required_env and the
        // $SUPERPOWERS_ROOT context substitution reads it.
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
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

test('quorum run embeds linux in run-id by default (no --os flag)', () => {
  const { status, stdout } = runCli('pass');
  expect(stdout).toContain('run-id:');
  // The run-id format is <scenario>-<agent>-<os>-<stamp>-<nonce>; the OS
  // segment must be 'linux' when --os is not supplied.
  const runIdLine = stdout.split('\n').find((l) => l.startsWith('run-id:'));
  expect(runIdLine).toMatch(/-linux-/);
  expect(status).toBe(0);
});

test('quorum run embeds linux in run-id when --os linux is explicit', () => {
  const { status, stdout } = runCli('pass', ['--os', 'linux']);
  expect(stdout).toContain('run-id:');
  const runIdLine = stdout.split('\n').find((l) => l.startsWith('run-id:'));
  expect(runIdLine).toMatch(/-linux-/);
  expect(status).toBe(0);
});
