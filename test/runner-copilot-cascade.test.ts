import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GauntletLayer } from '../src/contracts/verdict.ts';
import { copilotCascadeVerdict } from '../src/runner/index.ts';

// B1-copilot-secret-leak-scan + copilot session-state log checks (parity with
// the Python copilot capture-stage branch). copilotCascadeVerdict runs the
// secret-leak scan FIRST, then the expected/unexpected session-state log checks,
// returning an indeterminate verdict or null to proceed.

const GAUNTLET: GauntletLayer = {
  status: 'pass',
  summary: 's',
  reasoning: 'r',
  run_id: 'r1',
};

function freshRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'run-'));
}

test('secret-leak scan: a secret in a non-secret artifact -> capture indeterminate', () => {
  const runDir = freshRunDir();
  const logDir = join(runDir, 'session-state', 'sess-1');
  mkdirSync(logDir, { recursive: true });
  const expectedLog = join(logDir, 'events.jsonl');
  writeFileSync(expectedLog, '{}');
  // The secret leaked into a NON-secret run artifact (not the env file).
  writeFileSync(join(runDir, 'transcript.txt'), 'token=ghp_SECRETVALUE123');

  const v = copilotCascadeVerdict({
    runDir,
    sessionLogDir: join(runDir, 'session-state'),
    expectedEventsLog: expectedLog,
    envFile: join(runDir, '.copilot-env'),
    secretValues: ['ghp_SECRETVALUE123'],
    sourceLogs: [expectedLog],
    gauntlet: GAUNTLET,
    preRecords: [],
  });
  expect(v?.final).toBe('indeterminate');
  expect(v?.final_reason).toContain('secret value appeared');
  expect(v?.error?.stage).toBe('capture');
});

test('expected session-state log missing from source logs -> capture indeterminate', () => {
  const runDir = freshRunDir();
  const logDir = join(runDir, 'session-state', 'sess-1');
  mkdirSync(logDir, { recursive: true });
  const expectedLog = join(logDir, 'events.jsonl');
  const otherLog = join(runDir, 'session-state', 'other', 'events.jsonl');
  mkdirSync(join(runDir, 'session-state', 'other'), { recursive: true });
  writeFileSync(otherLog, '{}');

  const v = copilotCascadeVerdict({
    runDir,
    sessionLogDir: join(runDir, 'session-state'),
    expectedEventsLog: expectedLog,
    envFile: join(runDir, '.copilot-env'),
    secretValues: [],
    // capture saw a log, but NOT the expected one
    sourceLogs: [otherLog],
    gauntlet: GAUNTLET,
    preRecords: [],
  });
  expect(v?.final_reason).toContain('expected Copilot session-state log');
  expect(v?.error?.stage).toBe('capture');
});

test('clean run (expected log is the only source log, no leak) -> null', () => {
  const runDir = freshRunDir();
  const logDir = join(runDir, 'session-state', 'sess-1');
  mkdirSync(logDir, { recursive: true });
  const expectedLog = join(logDir, 'events.jsonl');
  writeFileSync(expectedLog, '{}');

  const v = copilotCascadeVerdict({
    runDir,
    sessionLogDir: join(runDir, 'session-state'),
    expectedEventsLog: expectedLog,
    envFile: join(runDir, '.copilot-env'),
    secretValues: ['ghp_SECRET'],
    sourceLogs: [expectedLog],
    gauntlet: GAUNTLET,
    preRecords: [],
  });
  expect(v).toBe(null);
});

test('the env file holding the secret is excluded from the leak scan', () => {
  const runDir = freshRunDir();
  const logDir = join(runDir, 'session-state', 'sess-1');
  mkdirSync(logDir, { recursive: true });
  const expectedLog = join(logDir, 'events.jsonl');
  writeFileSync(expectedLog, '{}');
  const envFile = join(runDir, '.copilot-env');
  // The env file legitimately holds the secret — it must NOT be flagged.
  writeFileSync(envFile, "GH_TOKEN='ghp_SECRET'\n");

  const v = copilotCascadeVerdict({
    runDir,
    sessionLogDir: join(runDir, 'session-state'),
    expectedEventsLog: expectedLog,
    envFile,
    secretValues: ['ghp_SECRET'],
    sourceLogs: [expectedLog],
    gauntlet: GAUNTLET,
    preRecords: [],
  });
  expect(v).toBe(null);
});
