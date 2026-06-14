import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTarget, ShowError } from '../src/cli/resolve-target.ts';

// Parity tests for the show-target resolver against quorum/show.py:resolve_target.

test('an existing non-batch dir without verdict.json throws "no verdict.json in {p}"', () => {
  // Python show.py rule 2: an existing directory lacking verdict.json raises
  // immediately — it does NOT fall through to prefix matching.
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  const emptyDir = join(root, 'run-empty');
  mkdirSync(emptyDir, { recursive: true });
  expect(() => resolveTarget(emptyDir, root)).toThrow(ShowError);
  expect(() => resolveTarget(emptyDir, root)).toThrow(
    `no verdict.json in ${emptyDir}`,
  );
});

test('an existing non-batch dir without verdict.json does not fall through to a prefix match', () => {
  // Pathological case: a dir name that is also a valid prefix under
  // resultsRoot must NOT resolve to a different run dir than the path named.
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  // A real run whose name shares the directory's basename as a prefix.
  const prefixed = join(root, 'run-empty-20260101T000000Z-aaaa');
  mkdirSync(prefixed, { recursive: true });
  writeFileSync(
    join(prefixed, 'verdict.json'),
    JSON.stringify({ final: 'pass' }),
  );
  // The bare existing dir "run-empty" under root, lacking a verdict.
  const emptyDir = join(root, 'run-empty');
  mkdirSync(emptyDir, { recursive: true });
  // Must raise on the empty dir, not silently resolve to the prefixed sibling.
  expect(() => resolveTarget(emptyDir, root)).toThrow(
    `no verdict.json in ${emptyDir}`,
  );
});

test('a file whose basename merely ends with "verdict.json" is not treated as a verdict file', () => {
  // Python rule 3 requires p.name == "verdict.json" exactly. A file named
  // "oldverdict.json" must NOT resolve to its parent dir.
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  const dir = join(root, 'run-x');
  mkdirSync(dir, { recursive: true });
  const decoy = join(dir, 'oldverdict.json');
  writeFileSync(decoy, JSON.stringify({ final: 'pass' }));
  expect(() => resolveTarget(decoy, root)).toThrow(ShowError);
});

test('an exact verdict.json file still resolves to its parent dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  const dir = join(root, 'run-y');
  mkdirSync(dir, { recursive: true });
  const verdict = join(dir, 'verdict.json');
  writeFileSync(verdict, JSON.stringify({ final: 'pass' }));
  expect(resolveTarget(verdict, root)).toBe(dir);
});
