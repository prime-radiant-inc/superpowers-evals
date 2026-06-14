import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');

const MISSING_ROOT = '/tmp/quorum-list-check-no-root-xyz-987';

// Parity with Python's click.Path(exists=True, file_okay=False) on
// --scenarios-root for list and check: a typo'd root is a hard error, not a
// silent no-op (exit 0).

test('list errors on a nonexistent --scenarios-root (not a silent exit 0)', () => {
  const proc = spawnSync(
    'bun',
    [CLI, 'list', '--scenarios-root', MISSING_ROOT],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
});

test('check (no names) errors on a nonexistent --scenarios-root', () => {
  const proc = spawnSync(
    'bun',
    [CLI, 'check', '--scenarios-root', MISSING_ROOT],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
});

test('list still succeeds (exit 0) on an existing scenarios-root', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const scn = join(root, 'alpha');
  mkdirSync(scn, { recursive: true });
  writeFileSync(join(scn, 'story.md'), '# story');
  const proc = spawnSync('bun', [CLI, 'list', '--scenarios-root', root], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(0);
  expect(proc.stdout).toContain('alpha');
});

test('check (no names) still succeeds (exit 0) on an empty existing scenarios-root', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const proc = spawnSync('bun', [CLI, 'check', '--scenarios-root', root], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(0);
});
