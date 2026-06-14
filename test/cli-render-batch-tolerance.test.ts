import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderBatch } from '../src/cli/render-batch.ts';

// Parity with show.py:render_batch, which uses `if r.get("skipped")` (pure
// truthiness, no type check). A non-string `skipped` value must NOT abort the
// whole matrix render with a schema error — the canonical writer emits a string,
// but a degraded/foreign record must degrade one cell, not the table.

function makeBatch(skippedValue: unknown): {
  batchDir: string;
  resultsRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'batch-'));
  const batchDir = join(root, 'batch');
  const resultsRoot = join(root, 'results');
  mkdirSync(batchDir, { recursive: true });
  mkdirSync(resultsRoot, { recursive: true });
  writeFileSync(
    join(batchDir, 'batch.json'),
    JSON.stringify({
      id: 'b-tol',
      started_at: '2026-06-14T00:00:00Z',
      coding_agents: ['claude'],
    }),
  );
  // A record whose `skipped` is a boolean rather than a string.
  const record = {
    scenario: 'alpha',
    coding_agent: 'claude',
    run_id: null,
    skipped: skippedValue,
  };
  writeFileSync(join(batchDir, 'results.jsonl'), `${JSON.stringify(record)}\n`);
  return { batchDir, resultsRoot };
}

test('renderBatch treats a boolean-true `skipped` as skipped (no throw)', () => {
  const { batchDir, resultsRoot } = makeBatch(true);
  const out = renderBatch({ batchDir, resultsRoot, color: false });
  const alphaRow = out.split('\n').find((l) => l.startsWith('| alpha'));
  expect(alphaRow).toBeDefined();
  // Truthy skipped -> the skip glyph/label, not "? ?".
  expect(alphaRow).toContain('— skip');
});

test('renderBatch treats a falsy `skipped` (false) as not-skipped', () => {
  const { batchDir, resultsRoot } = makeBatch(false);
  const out = renderBatch({ batchDir, resultsRoot, color: false });
  const alphaRow = out.split('\n').find((l) => l.startsWith('| alpha'));
  expect(alphaRow).toBeDefined();
  // Falsy skipped + null run_id -> unknown cell, not skipped.
  expect(alphaRow).toContain('? ?');
  expect(alphaRow).not.toContain('— skip');
});
