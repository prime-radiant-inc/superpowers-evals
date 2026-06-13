import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureToolCalls,
  newFilesSince,
  snapshotDir,
} from '../src/capture/index.ts';

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
