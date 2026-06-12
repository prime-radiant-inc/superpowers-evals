import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');

type FinalStatus = 'pass' | 'fail' | 'indeterminate';

function runDirWithVerdict(final: FinalStatus): {
  root: string;
  dir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  const dir = join(root, 'scn-claude-20260612T010101Z-abcd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final,
      final_reason: 'because',
      gauntlet: null,
      checks: [],
      error: null,
      economics: null,
    }),
  );
  return { root, dir };
}

test('show <dir> --quiet prints final + reason and exits 0 even for a fail verdict', () => {
  const { dir } = runDirWithVerdict('fail');
  const proc = spawnSync('bun', [CLI, 'show', dir, '--quiet'], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(0);
  expect(proc.stdout).toBe('fail\nbecause\n');
});

test('show --quiet --json together exits 1', () => {
  const { dir } = runDirWithVerdict('pass');
  const proc = spawnSync('bun', [CLI, 'show', dir, '--quiet', '--json'], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(1);
});

test('show with no target resolves the newest run under results-root', () => {
  const { root } = runDirWithVerdict('pass');
  const proc = spawnSync(
    'bun',
    [CLI, 'show', '--results-root', root, '--json'],
    {
      encoding: 'utf8',
    },
  );
  expect(proc.status).toBe(0);
  const parsed = JSON.parse(proc.stdout) as { final: string };
  expect(parsed.final).toBe('pass');
});

test('show resolves a bare verdict.json file to its parent run dir', () => {
  const { dir } = runDirWithVerdict('indeterminate');
  const proc = spawnSync(
    'bun',
    [CLI, 'show', join(dir, 'verdict.json'), '--quiet'],
    { encoding: 'utf8' },
  );
  expect(proc.status).toBe(0);
  expect(proc.stdout).toBe('indeterminate\nbecause\n');
});

test('show resolves a scenario prefix to the newest matching run', () => {
  const { root } = runDirWithVerdict('pass');
  const proc = spawnSync(
    'bun',
    [CLI, 'show', 'scn', '--results-root', root, '--quiet'],
    { encoding: 'utf8' },
  );
  expect(proc.status).toBe(0);
  expect(proc.stdout).toBe('pass\nbecause\n');
});

test('show exits 1 when the target cannot be resolved', () => {
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  const proc = spawnSync('bun', [CLI, 'show', '--results-root', root], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(1);
});

test('show exits 2 on a malformed verdict.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  const dir = join(root, 'scn-claude-20260612T010101Z-abcd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verdict.json'), '{ not valid json');
  const proc = spawnSync('bun', [CLI, 'show', dir], { encoding: 'utf8' });
  expect(proc.status).toBe(2);
  expect(proc.stderr).toContain('malformed verdict.json');
});

test('show exits 2 when verdict.json fails schema validation', () => {
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  const dir = join(root, 'scn-claude-20260612T010101Z-abcd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({ schema: 1, final: 'maybe' }),
  );
  const proc = spawnSync('bun', [CLI, 'show', dir], { encoding: 'utf8' });
  expect(proc.status).toBe(2);
});

test('show --json emits the raw verdict and never recolors', () => {
  const { dir } = runDirWithVerdict('fail');
  const proc = spawnSync('bun', [CLI, 'show', dir, '--json'], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(0);
  const parsed = JSON.parse(proc.stdout) as { final: string; schema: number };
  expect(parsed.final).toBe('fail');
  expect(parsed.schema).toBe(1);
});

test('show full mode renders the run-dir basename and an uppercased final', () => {
  const { dir } = runDirWithVerdict('pass');
  const proc = spawnSync('bun', [CLI, 'show', dir, '--no-color'], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(0);
  expect(proc.stdout).toContain('scn-claude-20260612T010101Z-abcd');
  expect(proc.stdout).toContain('PASS');
  expect(proc.stdout).toContain('because');
  // --no-color must produce no ANSI escape sequences (no ESC control char).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the absence of the ESC control char is the point of this test.
  expect(proc.stdout).not.toMatch(/\x1b\[/);
});
