import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  BatchHeaderSchema,
  ResultRecordSchema,
} from '../src/contracts/batch.ts';
import {
  allocateBatchDir,
  appendResultRecord,
  makeBatchId,
  writeBatchFooter,
  writeBatchHeader,
} from '../src/run-all/batch-index.ts';

function tmpOutRoot(): string {
  return mkdtempSync(join(tmpdir(), 'runall-index-'));
}

test('makeBatchId composes the stamp and nonce', () => {
  expect(makeBatchId('20260612T015301Z', 'ab12')).toBe(
    'batch-20260612T015301Z-ab12',
  );
});

test('allocateBatchDir creates results/batches/<batch-...>', () => {
  const outRoot = tmpOutRoot();
  const batchDir = allocateBatchDir({ outRoot });
  expect(existsSync(batchDir)).toBe(true);
  expect(basename(batchDir)).toMatch(/^batch-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  expect(batchDir.startsWith(join(outRoot, 'batches'))).toBe(true);
});

test('writeBatchHeader writes batch.json with finished_at null + indent 2', () => {
  const outRoot = tmpOutRoot();
  const batchDir = allocateBatchDir({ outRoot });
  writeBatchHeader({
    batchDir,
    codingAgents: ['claude', 'codex'],
    jobs: 2,
    startedAt: '2026-06-12T01:53:01.000Z',
  });
  const raw = readFileSync(join(batchDir, 'batch.json'), 'utf8');
  // Indent-2, no trailing newline (byte parity with the Python writer).
  expect(raw.endsWith('\n')).toBe(false);
  expect(raw).toContain('  "schema_version": 1');
  const header = BatchHeaderSchema.parse(JSON.parse(raw));
  expect(header.id).toBe(basename(batchDir));
  expect(header.finished_at).toBeNull();
  expect(header.coding_agents).toEqual(['claude', 'codex']);
  expect(header.jobs).toBe(2);
});

test('appendResultRecord writes one compact line per record, skipped omitted when null', () => {
  const outRoot = tmpOutRoot();
  const batchDir = allocateBatchDir({ outRoot });
  appendResultRecord({
    batchDir,
    scenario: 'alpha',
    codingAgent: 'claude',
    runId: 'alpha-claude-20260612T015301Z-ab12',
    skipped: null,
  });
  appendResultRecord({
    batchDir,
    scenario: 'beta',
    codingAgent: 'codex',
    runId: null,
    skipped: 'directive',
  });
  const lines = readFileSync(join(batchDir, 'results.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);
  expect(lines).toHaveLength(2);
  // Python json.dumps default separators: ", " and ": ".
  expect(lines[0]).toBe(
    '{"scenario": "alpha", "coding_agent": "claude", "run_id": "alpha-claude-20260612T015301Z-ab12"}',
  );
  expect(lines[1]).toBe(
    '{"scenario": "beta", "coding_agent": "codex", "run_id": null, "skipped": "directive"}',
  );
  // The runnable record carries no `skipped` key (parsed view).
  const r0 = ResultRecordSchema.parse(JSON.parse(lines[0] ?? ''));
  expect(r0.skipped).toBeUndefined();
  const r1 = ResultRecordSchema.parse(JSON.parse(lines[1] ?? ''));
  expect(r1.skipped).toBe('directive');
});

test('writeBatchFooter sets finished_at, preserving the rest', () => {
  const outRoot = tmpOutRoot();
  const batchDir = allocateBatchDir({ outRoot });
  writeBatchHeader({
    batchDir,
    codingAgents: ['claude'],
    jobs: 1,
    startedAt: '2026-06-12T01:53:01.000Z',
  });
  writeBatchFooter({ batchDir, finishedAt: '2026-06-12T02:00:00.000Z' });
  const header = BatchHeaderSchema.parse(
    JSON.parse(readFileSync(join(batchDir, 'batch.json'), 'utf8')),
  );
  expect(header.finished_at).toBe('2026-06-12T02:00:00.000Z');
  expect(header.started_at).toBe('2026-06-12T01:53:01.000Z');
  expect(header.coding_agents).toEqual(['claude']);
});
