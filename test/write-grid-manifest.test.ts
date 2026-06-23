import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeGridManifest } from '../src/run-all/write-grid-manifest.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');

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

test('grid-manifest CLI default writes under results', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gm-cli-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'grid-manifest',
      '--scenarios-root',
      resolve('test/fixtures/grid/scenarios'),
      '--coding-agents-dir',
      resolve('test/fixtures/grid/coding-agents'),
    ],
    { cwd, encoding: 'utf8' },
  );

  expect(proc.status).toBe(0);
  expect(existsSync(join(cwd, 'results/grid-manifest.json'))).toBe(true);
  expect(existsSync(join(cwd, 'grid-manifest.json'))).toBe(false);
});
