import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplianceError } from '../src/appliance/errors.ts';
import {
  assertInsideRoot,
  dirsEquivalent,
  moveToQuarantine,
} from '../src/appliance/safe-fs.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

function tree(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
}

// Minimal LoadedApplianceConfig shape: moveToQuarantine reads
// config.container.results_root and config.root only.
function fakeLoaded(root: string): LoadedApplianceConfig {
  mkdirSync(join(root, 'evals/results'), { recursive: true });
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: { name: 'q', results_root: join(root, 'evals/results') },
    },
    bundle: { bundle_id: 'b', rotated_at: 'x', providers: [], note: 't' },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  } as LoadedApplianceConfig;
}

test('assertInsideRoot accepts a child and rejects the root itself and escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'safe-root-'));
  assertInsideRoot(root, join(root, 'a/b.txt')); // does not throw
  expect(() => assertInsideRoot(root, root)).toThrow(ApplianceError);
  expect(() => assertInsideRoot(root, join(root, '..', 'outside'))).toThrow(
    ApplianceError,
  );
});

test('assertInsideRoot rejects a symlink escape through an existing ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'safe-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'safe-outside-'));
  symlinkSync(outside, join(root, 'link'));
  expect(() => assertInsideRoot(root, join(root, 'link', 'x.txt'))).toThrow(
    ApplianceError,
  );
});

test('dirsEquivalent: identical trees true; drift, missing, extra false; exclusion honored', () => {
  const a = mkdtempSync(join(tmpdir(), 'tree-a-'));
  const b = mkdtempSync(join(tmpdir(), 'tree-b-'));
  tree(a, { 'verdict.json': '{"final":"pass"}', 'sub/x.txt': 'x' });
  tree(b, { 'verdict.json': '{"final":"pass"}', 'sub/x.txt': 'x' });
  expect(dirsEquivalent(a, b)).toBe(true);
  writeFileSync(join(b, 'verdict.json'), '{"final":"fail"}');
  expect(dirsEquivalent(a, b)).toBe(false);
  tree(b, { 'verdict.json': '{"final":"pass"}', 'extra.txt': 'e' });
  expect(dirsEquivalent(a, b)).toBe(false);
  // The import-provenance exclusion case: b gains ONLY the excluded file:
  tree(a, { 'appliance-provenance.json': '{"kind":"imported"}' });
  expect(
    dirsEquivalent(a, b, {
      exclude: ['appliance-provenance.json', 'extra.txt'],
    }),
  ).toBe(true);
});

test('moveToQuarantine renames (never copies) into state/quarantine and returns the path', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const loaded = fakeLoaded(root);
  const src = join(loaded.config.container.results_root, 'run-1');
  tree(src, { 'verdict.json': 'v' });
  const dest = moveToQuarantine(loaded, src, 'prune-run-1');
  expect(existsSync(src)).toBe(false);
  expect(readFileSync(join(dest, 'verdict.json'), 'utf8')).toBe('v');
  expect(dest).toContain(join('state', 'quarantine'));
});

test('moveToQuarantine suffixes on collision', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const loaded = fakeLoaded(root);
  const mk = (name: string) => {
    const src = join(loaded.config.container.results_root, name);
    tree(src, { 'v.txt': name });
    return src;
  };
  // Same logical name twice within one stamp second → second gets a suffix.
  const d1 = moveToQuarantine(loaded, mk('run-a'), 'prune-run-a');
  const d2 = moveToQuarantine(loaded, mk('run-b'), 'prune-run-a');
  expect(d1).not.toBe(d2);
  expect(existsSync(d1)).toBe(true);
  expect(existsSync(d2)).toBe(true);
});

test('moveToQuarantine refuses a source outside the results root', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const loaded = fakeLoaded(root);
  const outside = mkdtempSync(join(tmpdir(), 'not-results-'));
  expect(() => moveToQuarantine(loaded, outside, 'x')).toThrow(ApplianceError);
  expect(existsSync(outside)).toBe(true); // untouched
});
