import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeGridManifest } from '../src/run-all/write-grid-manifest.ts';

test('writeGridManifest emits parseable JSON with cells', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'gm-')), 'grid-manifest.json');
  writeGridManifest({
    scenariosRoot: 'test/fixtures/grid/scenarios',
    codingAgentsDir: 'test/fixtures/grid/coding-agents',
    outPath: out,
    now: '2026-06-18T00:00:00Z',
  });
  const m = JSON.parse(readFileSync(out, 'utf8'));
  expect(m.generated_at).toBe('2026-06-18T00:00:00Z');
  expect(Array.isArray(m.cells)).toBe(true);
  expect(m.cells.length).toBeGreaterThan(0);
});
