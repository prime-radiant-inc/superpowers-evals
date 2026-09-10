import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AtifTrajectory } from '../src/atif/types.ts';
import {
  ATIF_NORMALIZERS,
  captureTokenUsage,
  captureToolCalls,
  snapshotDir,
} from '../src/capture/index.ts';
import type { SourceIndex } from '../src/capture/source-index.ts';

function piSession(
  id: string,
  cwd: string,
  timestamp: string,
  content: unknown[],
  cost: number,
): string {
  return [
    JSON.stringify({ type: 'session', id, cwd }),
    JSON.stringify({
      type: 'message',
      timestamp,
      message: {
        role: 'assistant',
        model: 'gpt-5.6-sol',
        provider: 'openai-codex',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cost: { total: cost },
        },
        content,
      },
    }),
  ].join('\n');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

test('capture retains root and tool-less child ATIF with source-step mapping and prices each once', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'atif-source-logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'atif-source-run-'));
  writeFileSync(
    join(logDir, 'seed.jsonl'),
    piSession('seed', runDir, '2026-09-01T00:00:00Z', [], 9),
  );
  const snapshot = snapshotDir(logDir, '**/*.jsonl');
  writeFileSync(
    join(logDir, 'root.jsonl'),
    piSession(
      'root',
      runDir,
      '2026-09-01T00:00:02Z',
      [{ type: 'toolCall', id: 'root-call', name: 'read', arguments: {} }],
      1,
    ),
  );
  const childDir = join(logDir, 'root', 'child', 'run-0');
  mkdirSync(childDir, { recursive: true });
  writeFileSync(
    join(childDir, 'session.jsonl'),
    piSession(
      'child',
      runDir,
      '2026-09-01T00:00:01Z',
      [{ type: 'text', text: 'child finished' }],
      2,
    ),
  );

  const args = {
    logDir,
    logGlob: '**/*.jsonl',
    snapshot,
    normalizer: 'pi',
    runDir,
    launchCwd: runDir,
  } as const;
  const capture = captureToolCalls(args);
  expect(capture.rowCount).toBe(1);
  expect(capture.sourceLogs.map((path) => path.endsWith('seed.jsonl'))).toEqual(
    [false, false],
  );

  const index = readJson<SourceIndex>(join(runDir, 'atif-sources.json'));
  expect(index.schemaVersion).toBe(1);
  expect(index.sources.map((source) => source.trajectoryPath)).toEqual([
    'atif-sources/000001.json',
    'atif-sources/000002.json',
  ]);
  expect(index.sources.every((source) => source.sha256.length === 64)).toBe(
    true,
  );
  expect(index.sources.every((source) => source.error === null)).toBe(true);
  expect(index.mergedSteps).toEqual([
    { mergedStepId: 1, sourceId: index.sources[1]!.id, sourceStepId: 1 },
    { mergedStepId: 2, sourceId: index.sources[0]!.id, sourceStepId: 1 },
  ]);
  const perSource = index.sources.map((source) =>
    readJson<AtifTrajectory>(join(runDir, source.trajectoryPath!)),
  );
  expect(perSource.map((trajectory) => trajectory.session_id)).toEqual([
    'root',
    'child',
  ]);

  const usagePath = await captureTokenUsage(args);
  expect(usagePath).not.toBeNull();
  const usage = readJson<Record<string, unknown>>(usagePath!);
  expect(usage['total_tokens']).toBe(30);
  expect(usage['est_cost_usd']).toBe(3);
});

test('capture records normalization errors and rebuilds source artifacts on retry', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'atif-source-errors-'));
  const runDir = mkdtempSync(join(tmpdir(), 'atif-source-errors-run-'));
  const snapshot = snapshotDir(logDir, '**/*.jsonl');
  writeFileSync(join(logDir, 'bad.jsonl'), 'native bytes');
  ATIF_NORMALIZERS['unit-throw'] = () => {
    throw new Error('synthetic normalizer failure');
  };
  try {
    captureToolCalls({
      logDir,
      logGlob: '**/*.jsonl',
      snapshot,
      normalizer: 'unit-throw',
      runDir,
      launchCwd: runDir,
    });
  } finally {
    delete ATIF_NORMALIZERS['unit-throw'];
  }
  const failed = readJson<SourceIndex>(join(runDir, 'atif-sources.json'));
  expect(failed.sources).toMatchObject([
    {
      trajectoryPath: null,
      error: 'synthetic normalizer failure',
    },
  ]);
  expect(failed.sources[0]!.sha256).toHaveLength(64);
  expect(failed.mergedSteps).toEqual([]);
  expect(readdirSync(join(runDir, 'atif-sources'))).toEqual([]);

  writeFileSync(
    join(logDir, 'bad.jsonl'),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'fixed-call', name: 'Read', input: {} },
        ],
      },
    }),
  );
  writeFileSync(
    join(logDir, 'second.jsonl'),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'second-call', name: 'Bash', input: {} },
        ],
      },
    }),
  );
  captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot,
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });
  const retried = readJson<SourceIndex>(join(runDir, 'atif-sources.json'));
  expect(retried.sources).toHaveLength(2);
  expect(retried.sources.every((source) => source.error === null)).toBe(true);
  expect(readdirSync(join(runDir, 'atif-sources')).sort()).toEqual([
    '000001.json',
    '000002.json',
  ]);
});

test('zero-source capture removes stale merged and per-source artifacts', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'atif-source-empty-'));
  const runDir = mkdtempSync(join(tmpdir(), 'atif-source-empty-run-'));
  writeFileSync(join(logDir, 'seed.jsonl'), '{}');
  const snapshot = snapshotDir(logDir, '**/*.jsonl');
  mkdirSync(join(runDir, 'atif-sources'), { recursive: true });
  writeFileSync(join(runDir, 'atif-sources', '000001.json'), '{}');
  writeFileSync(join(runDir, 'atif-sources.json'), '{}');
  writeFileSync(join(runDir, 'trajectory.json'), '{}');

  const capture = captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot,
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });
  expect(capture.rowCount).toBe(0);
  expect(existsSync(join(runDir, 'trajectory.json'))).toBe(false);
  expect(existsSync(join(runDir, 'atif-sources.json'))).toBe(false);
  expect(existsSync(join(runDir, 'atif-sources'))).toBe(false);
});
