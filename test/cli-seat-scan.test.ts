import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'seat-scan.ts');
const FIXTURES = resolve(import.meta.dir, 'fixtures', 'seats');

function run(args: string[]) {
  return spawnSync('bun', [CLI, ...args], { encoding: 'utf8' });
}

test('seat-scan prints an (agent, role) table with seat and rep columns', () => {
  const proc = run(['--results', FIXTURES, '--scenario-prefix', 'sdd-']);
  expect(proc.status).toBe(0);
  expect(proc.stdout).toContain('2 runs with per-thread logs');
  expect(proc.stdout).toContain('claude   final_reviewer');
  expect(proc.stdout).toContain('codex    task_reviewer');
  // Rep-level columns are present alongside the seat-level ones: reps are the
  // randomization unit, so a rate over reps is what a comparison needs.
  expect(proc.stdout).toContain('reps');
  expect(proc.stdout).toContain('rep≥1redun');
});

test('seat-scan states the tree-mutation proxy limitation in its output', () => {
  // The redundancy verdict is an upper bound; a reader who does not know that
  // will over-claim from it, so the CLI has to say so every time.
  const proc = run(['--results', FIXTURES, '--scenario-prefix', 'sdd-']);
  expect(proc.stdout).toContain('LIMITATION');
  expect(proc.stdout).toContain('upper bound');
});

test('seat-scan --json emits per-seat rows carrying the arm identity', () => {
  const out = join(
    mkdtempSync(join(tmpdir(), 'seat-scan-')),
    'nested',
    'seats.json',
  );
  const proc = run([
    '--results',
    FIXTURES,
    '--scenario-prefix',
    'sdd-',
    '--json',
    out,
  ]);
  expect(proc.status).toBe(0);
  const payload = JSON.parse(readFileSync(out, 'utf8')) as {
    runs: number;
    rollup: unknown[];
    seats: Record<string, unknown>[];
  };
  expect(payload.runs).toBe(2);
  expect(payload.seats).toHaveLength(8);
  const finalReviewer = payload.seats.find(
    (s) => s['role'] === 'final_reviewer' && s['agent'] === 'claude',
  );
  // superpowers_rev, credential and models are what let two arms be told apart
  // downstream.
  expect(finalReviewer?.['superpowers_rev']).toBe(
    'c686bb947ab1469bd396e0b691f28f96a3c4ee0c',
  );
  expect(finalReviewer?.['credential']).toBe('opus');
  expect(finalReviewer?.['models']).toEqual(['claude-opus-4-8']);
  expect(finalReviewer?.['suite_runs']).toBe(2);
  expect(finalReviewer?.['full_suite_runs']).toBe(1);
  expect(finalReviewer?.['focused_suite_runs']).toBe(1);
  expect(finalReviewer?.['redundant_suite_runs']).toBe(2);
  expect(finalReviewer?.['applied_no_patches']).toBe(true);
});

test('seat-scan without --results is a usage error, not a silent empty table', () => {
  const proc = run([]);
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('--results is required');
});

test('seat-scan on a results dir with no matching runs reports zero, exit 0', () => {
  const proc = run(['--results', FIXTURES, '--scenario-prefix', 'nothing-']);
  expect(proc.status).toBe(0);
  expect(proc.stdout).toContain('0 runs with per-thread logs');
});
