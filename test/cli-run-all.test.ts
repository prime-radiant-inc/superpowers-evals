import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');

// CLI-boundary validation for `run-all`. These pin the fail-fast behavior that
// stops a bad invocation before any agent is launched — they never drive a real
// gauntlet run.

test('run-all rejects a non-integer --jobs value (e.g. 3.5)', () => {
  // Python validates --jobs with click.IntRange(min=1); a fractional token like
  // "3.5" is a usage error. TS must not silently truncate it to 3.
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--jobs',
      '3.5',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('--jobs');
});

test('run-all rejects a trailing-garbage --jobs value (e.g. 8x)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--jobs',
      '8x',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('--jobs');
});

test('run-all errors when --scenarios-root does not exist', () => {
  // Python declares run-all's --scenarios-root as click.Path(exists=True),
  // failing fast at the CLI boundary on a missing root.
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--scenarios-root',
      '/tmp/quorum-does-not-exist-xyz-123',
      '--coding-agents-dir',
      out,
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('--scenarios-root does not exist');
});

test('run-all errors when --coding-agents-dir does not exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      '/tmp/quorum-does-not-exist-agents-xyz-123',
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('--coding-agents-dir does not exist');
});
