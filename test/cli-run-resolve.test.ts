import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');

// `run` accepts either an explicit scenario path OR a bare name resolved under
// --scenarios-root (an ergonomic improvement over the Python CLI, which only
// takes a path). These tests pin the resolution, not a full gauntlet drive.

test('run resolves a bare scenario name under --scenarios-root', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  mkdirSync(join(root, 'my-scn'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  // The bare name resolves to <root>/my-scn; the run then fails fast on the
  // missing agent yaml — but NOT with a "scenario not found" resolution error.
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run',
      'my-scn',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      out,
      '--out-root',
      out,
      '--coding-agent',
      'nope',
    ],
    { encoding: 'utf8' },
  );
  expect(proc.stderr).not.toContain('scenario not found');
});

test('run accepts an explicit scenario path (e.g. scenarios/<name>)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  mkdirSync(join(root, 'my-scn'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  // Pass the full path as the argument; it resolves as-given.
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run',
      join(root, 'my-scn'),
      '--coding-agents-dir',
      out,
      '--out-root',
      out,
      '--coding-agent',
      'nope',
    ],
    { encoding: 'utf8' },
  );
  expect(proc.stderr).not.toContain('scenario not found');
});

test('run errors (exit 2) when neither the path nor <root>/<name> exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const proc = spawnSync(
    'bun',
    [CLI, 'run', 'ghost', '--scenarios-root', root, '--coding-agent', 'x'],
    { encoding: 'utf8' },
  );
  expect(proc.status).toBe(2);
  expect(proc.stderr).toContain('scenario not found');
  expect(proc.stderr).toContain(root);
});
