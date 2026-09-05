import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEnv } from '../src/env.ts';
import { writeSubprocessTrace } from './fixtures/subprocess-trace.ts';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

function invoke(shim: string, argv: string[]) {
  const agentHome = mkdtempSync(join(tmpdir(), 'mock-home-'));
  return spawnSync(join(shim, 'gauntlet'), argv, {
    encoding: 'utf8',
    env: { PATH: getEnv('PATH'), QUORUM_AGENT_HOME: agentHome },
  });
}

test('mock trace records actual run execution and never provenance probes', () => {
  const traceDir = mkdtempSync(join(tmpdir(), 'mock-trace-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'mock-project-'));
  const shim = mockGauntletDir('pass', { traceDir });
  expect(invoke(shim, ['--version']).status).toBe(2);
  expect(readdirSync(traceDir)).toEqual([]);
  const result = invoke(shim, ['run', '--project-dir', projectDir]);
  expect(result.status, result.stderr).toBe(0);
  expect(
    existsSync(
      join(projectDir, 'gauntlet-agent/results/mock_pass_0000/result.json'),
    ),
  ).toBe(true);
  expect(statSync(join(traceDir, 'shell-entry')).mtimeMs).toBeGreaterThan(0);
  const entry = JSON.parse(
    readFileSync(join(traceDir, 'bun-entry.json'), 'utf8'),
  );
  const complete = JSON.parse(
    readFileSync(join(traceDir, 'fixture-complete.json'), 'utf8'),
  );
  expect(entry.marker).toBe('bun-entry');
  expect(complete.marker).toBe('fixture-complete');
  expect(complete.pid).toBe(entry.pid);
  expect(complete.at_ms).toBeGreaterThanOrEqual(entry.at_ms);
});

test('unwritable trace storage preserves mock success and original failure', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'mock-project-'));
  const traceDir = join(projectDir, 'absent', 'trace');
  expect(() => writeSubprocessTrace(traceDir, { event: 'test' })).not.toThrow();
  const success = invoke(mockGauntletDir('pass', { traceDir }), [
    'run',
    '--project-dir',
    projectDir,
  ]);
  expect(success.status, success.stderr).toBe(0);
  const failure = invoke(mockGauntletDir('startup-error', { traceDir }), [
    'run',
    '--project-dir',
    projectDir,
  ]);
  expect(failure.status).toBe(1);
  expect(failure.stderr).toContain('unknown_model');
});
