import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
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

// Returns the thrown value, or undefined when fn returns normally, so tests
// can assert on code/step without try/catch scaffolding.
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
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

test('assertInsideRoot rejects a path through a dangling symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'safe-root-'));
  // Dangling: the link entry exists, its target does not. existsSync-based
  // walking treats it as a missing tail; the guard must not.
  symlinkSync(join(root, 'never-created'), join(root, 'dangling'));
  const caught = captureError(() =>
    assertInsideRoot(root, join(root, 'dangling', 'x.txt')),
  );
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).code).toBe('config_invalid');
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

test('dirsEquivalent refuses symlink-bearing trees instead of ignoring the links', () => {
  // One-sided: only one tree carries a link (even to an identical file).
  {
    const a = mkdtempSync(join(tmpdir(), 'one-a-'));
    const b = mkdtempSync(join(tmpdir(), 'one-b-'));
    tree(a, { 'x.txt': 'x' });
    tree(b, { 'x.txt': 'x' });
    symlinkSync('x.txt', join(b, 'alias'));
    expect(dirsEquivalent(a, b)).toBe(false);
  }
  // Links on both sides, differing targets.
  {
    const a = mkdtempSync(join(tmpdir(), 'two-a-'));
    const b = mkdtempSync(join(tmpdir(), 'two-b-'));
    tree(a, { 'x.txt': 'x', 'y.txt': 'y' });
    tree(b, { 'x.txt': 'x', 'y.txt': 'y' });
    symlinkSync('x.txt', join(a, 'alias'));
    symlinkSync('y.txt', join(b, 'alias'));
    expect(dirsEquivalent(a, b)).toBe(false);
  }
  // Even byte-identical links on both sides: conservative rejection — no
  // vouching for symlinked evidence.
  {
    const a = mkdtempSync(join(tmpdir(), 'same-a-'));
    const b = mkdtempSync(join(tmpdir(), 'same-b-'));
    tree(a, { 'x.txt': 'x' });
    tree(b, { 'x.txt': 'x' });
    symlinkSync('x.txt', join(a, 'alias'));
    symlinkSync('x.txt', join(b, 'alias'));
    expect(dirsEquivalent(a, b)).toBe(false);
  }
});

test('moveToQuarantine renames (never copies) into state/quarantine and returns the path', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const loaded = fakeLoaded(root);
  const src = join(loaded.config.container.results_root, 'run-1');
  tree(src, { 'verdict.json': 'v' });
  const inodeBefore = statSync(src).ino;
  const dest = moveToQuarantine(loaded, src, 'prune-run-1');
  expect(existsSync(src)).toBe(false);
  expect(statSync(dest).ino).toBe(inodeBefore); // same inode => rename, not copy+delete
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
  // Pinned clock: identical stamps force a real collision, so d2/d3 must come
  // from the -2/-3 suffix loop, not from a fresh timestamp.
  const now = () => new Date('2026-01-01T00:00:00.000Z');
  const d1 = moveToQuarantine(loaded, mk('run-a'), 'prune-run-a', { now });
  const d2 = moveToQuarantine(loaded, mk('run-b'), 'prune-run-a', { now });
  const d3 = moveToQuarantine(loaded, mk('run-c'), 'prune-run-a', { now });
  expect(d2).toBe(`${d1}-2`);
  expect(d3).toBe(`${d1}-3`);
  expect(existsSync(d1)).toBe(true);
  expect(existsSync(d2)).toBe(true);
  expect(existsSync(d3)).toBe(true);
});

test('moveToQuarantine maps rename EXDEV to a typed error, never a copy-delete fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const loaded = fakeLoaded(root);
  const src = join(loaded.config.container.results_root, 'run-x');
  tree(src, { 'v.txt': 'v' });
  // Smallest seam: inject the rename failure itself. No module-wide mock.
  const rename: typeof import('node:fs').renameSync = () => {
    const err = new Error(
      'EXDEV: cross-device link not permitted',
    ) as NodeJS.ErrnoException;
    err.code = 'EXDEV';
    throw err;
  };
  const caught = captureError(() =>
    moveToQuarantine(loaded, src, 'run-x', { rename }),
  );
  expect(caught).toBeInstanceOf(ApplianceError);
  const err = caught as ApplianceError;
  expect(err.code).toBe('config_invalid');
  expect(err.step).toBe('quarantine');
  expect(err.message).toContain('copy-delete');
  expect(existsSync(src)).toBe(true); // evidence untouched
  expect(readdirSync(join(root, 'state', 'quarantine'))).toEqual([]); // no partial slot
});

test('moveToQuarantine rejects a traversal name and leaves the source in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const loaded = fakeLoaded(root);
  const src = join(loaded.config.container.results_root, 'run-1');
  tree(src, { 'v.txt': 'v' });
  const caught = captureError(() =>
    moveToQuarantine(loaded, src, 'slot/../../../outside'),
  );
  expect(caught).toBeInstanceOf(ApplianceError);
  const err = caught as ApplianceError;
  expect(err.code).toBe('config_invalid');
  expect(err.step).toBe('quarantine');
  expect(existsSync(src)).toBe(true); // untouched
  expect(existsSync(join(root, 'outside'))).toBe(false); // no escape artifact
  expect(() => moveToQuarantine(loaded, src, '')).toThrow(ApplianceError);
});

test('moveToQuarantine refuses a source outside the results root', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const loaded = fakeLoaded(root);
  const outside = mkdtempSync(join(tmpdir(), 'not-results-'));
  expect(() => moveToQuarantine(loaded, outside, 'x')).toThrow(ApplianceError);
  expect(existsSync(outside)).toBe(true); // untouched
});
