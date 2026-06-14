import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureToolCalls,
  captureToolCallsWithRetry,
  newFilesSince,
  snapshotDir,
} from '../src/capture/index.ts';

// A valid single-tool-call claude session log line.
const CLAUDE_LOG_LINE = JSON.stringify({
  type: 'tool_use',
  name: 'Bash',
  input: { command: 'ls' },
});

test('snapshot then diff finds only new files', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  writeFileSync(join(logDir, 'old.jsonl'), '');
  const snap = snapshotDir(logDir, '**/*.jsonl');
  writeFileSync(join(logDir, 'new.jsonl'), '');
  const fresh = newFilesSince(logDir, '**/*.jsonl', snap);
  expect(fresh.map((p) => p.split('/').pop())).toEqual(['new.jsonl']);
});

test('captureToolCalls writes coding-agent-tool-calls.jsonl from claude logs', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');
  writeFileSync(
    join(logDir, 's.jsonl'),
    JSON.stringify({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'ls' },
    }),
  );
  const res = captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot: snap,
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });
  expect(res.rowCount).toBe(1);
  const written = readFileSync(
    join(runDir, 'coding-agent-tool-calls.jsonl'),
    'utf8',
  ).trim();
  expect(JSON.parse(written)).toEqual({
    tool: 'Bash',
    args: { command: 'ls' },
    source: 'shell',
  });
});

test('captureToolCalls writes an empty file when there are no new logs', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const res = captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot: new Set(),
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });
  expect(res.rowCount).toBe(0);
  expect(
    readFileSync(join(runDir, 'coding-agent-tool-calls.jsonl'), 'utf8'),
  ).toBe('');
});

test('captureToolCalls records attempts === 1', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');
  writeFileSync(join(logDir, 's.jsonl'), CLAUDE_LOG_LINE);
  const res = captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot: snap,
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });
  expect(res.attempts).toBe(1);
});

test('captureToolCallsWithRetry: empty first pass, filled on retry via sleep spy', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');
  let sleeps = 0;
  // The flush race: the session log lands only after the first (empty) diff,
  // simulated by writing it from the injected sleep before the re-diff.
  const sleep = (_ms: number): void => {
    sleeps += 1;
    writeFileSync(join(logDir, 's.jsonl'), CLAUDE_LOG_LINE);
  };
  const res = captureToolCallsWithRetry(
    {
      logDir,
      logGlob: '**/*.jsonl',
      snapshot: snap,
      normalizer: 'claude',
      runDir,
      launchCwd: runDir,
    },
    { sleep },
  );
  expect(res.rowCount).toBe(1);
  expect(res.attempts).toBe(2);
  expect(sleeps).toBe(1);
});

test('captureToolCallsWithRetry: genuinely empty exhausts attempts', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  let sleeps = 0;
  const sleep = (_ms: number): void => {
    sleeps += 1;
  };
  const res = captureToolCallsWithRetry(
    {
      logDir,
      logGlob: '**/*.jsonl',
      snapshot: new Set(),
      normalizer: 'claude',
      runDir,
      launchCwd: runDir,
    },
    { sleep },
  );
  expect(res.rowCount).toBe(0);
  expect(res.attempts).toBe(3);
  expect(sleeps).toBe(2);
});

test('captureToolCallsWithRetry: non-empty first pass does not retry', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');
  writeFileSync(join(logDir, 's.jsonl'), CLAUDE_LOG_LINE);
  let sleeps = 0;
  const sleep = (_ms: number): void => {
    sleeps += 1;
  };
  const res = captureToolCallsWithRetry(
    {
      logDir,
      logGlob: '**/*.jsonl',
      snapshot: snap,
      normalizer: 'claude',
      runDir,
      launchCwd: runDir,
    },
    { sleep },
  );
  expect(res.rowCount).toBe(1);
  expect(res.attempts).toBe(1);
  expect(sleeps).toBe(0);
});
