import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  existsSync as realExistsSync,
  realpathSync,
  renameSync as realRenameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { ApplianceError } from '../src/appliance/errors.ts';
import {
  assertInsideRoot,
  assertNoFollowDirChain,
  assertRealDirNoFollow,
  dirsEquivalent,
  ensurePrivateDirNoFollow,
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-')));
  const loaded = fakeLoaded(root);
  const src = join(loaded.config.container.results_root, 'run-1');
  tree(src, { 'verdict.json': 'v' });
  const inodeBefore = statSync(src).ino;
  const dest = moveToQuarantine(loaded, src, 'prune-run-1');
  expect(realExistsSync(src)).toBe(false);
  expect(statSync(dest).ino).toBe(inodeBefore); // same inode => rename, not copy+delete
  expect(readFileSync(join(dest, 'verdict.json'), 'utf8')).toBe('v');
  expect(dest).toContain(join('state', 'quarantine'));
});

test('moveToQuarantine suffixes on collision', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-')));
  const loaded = fakeLoaded(root);
  const mk = (name: string) => {
    const src = join(loaded.config.container.results_root, name);
    tree(src, { 'v.txt': name });
    return src;
  };
  const qroot = join(root, 'state', 'quarantine');
  // The stamp comes from the wall clock, so a real same-millisecond collision
  // cannot be forced deterministically. Instead, fake the filesystem fact a
  // collision produces — "that slot is occupied" — for the loop's first
  // existsSync(candidate) probes under qroot, scoped to this slot's path shape
  // and restored in finally. Delegates everything else to the real fs.
  //
  // Two occupied slots -> suffix -3; one -> -2. `first` records the loop's
  // own first candidate, so the assertions are exact, not pattern-based.
  // (realExists is captured by value BEFORE spyOn: named imports are live
  // namespace accesses in Bun, so delegating through an import inside the
  // mock would recurse into the spy itself.)
  const suffix = (occupiedSlots: number) => {
    const realExists = fs.existsSync;
    let occupied = 0;
    let first = '';
    const spy = spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      const rel = s.startsWith(qroot + sep) ? s.slice(qroot.length + 1) : null;
      // Candidates look like `<stamp>-prune-run-a` then `-2`, `-3`, ...
      if (rel !== null && /^.*-prune-run-a(-\d+)?$/.test(rel)) {
        if (!first) first = s;
        if (occupied < occupiedSlots) {
          occupied += 1;
          return true;
        }
      }
      return realExists(p);
    });
    return {
      dest: () => moveToQuarantine(loaded, mk('run-b'), 'prune-run-a'),
      firstCandidate: () => first,
      restore: () => spy.mockRestore(),
    };
  };

  const two = suffix(2);
  let d3: string;
  try {
    d3 = two.dest();
  } finally {
    two.restore();
  }
  expect(d3).toBe(`${two.firstCandidate()}-3`);
  expect(realExistsSync(d3)).toBe(true);

  const one = suffix(1);
  let d2: string;
  try {
    d2 = one.dest();
  } finally {
    one.restore();
  }
  expect(d2).toBe(`${one.firstCandidate()}-2`);
  expect(realExistsSync(d2)).toBe(true);
  expect(d2).not.toBe(d3);
});

test('moveToQuarantine maps rename EXDEV to a typed error, never a copy-delete fallback', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-')));
  const loaded = fakeLoaded(root);
  const src = join(loaded.config.container.results_root, 'run-x');
  tree(src, { 'v.txt': 'v' });
  // Scoped fake fs: renameSync fails cross-volume for this one call; the spy
  // is restored in finally, so nothing leaks to later tests.
  const spy = spyOn(fs, 'renameSync').mockImplementation(() => {
    const err = new Error(
      'EXDEV: cross-device link not permitted',
    ) as NodeJS.ErrnoException;
    err.code = 'EXDEV';
    throw err;
  });
  let caught: unknown;
  try {
    caught = captureError(() => moveToQuarantine(loaded, src, 'run-x'));
  } finally {
    spy.mockRestore();
  }
  expect(caught).toBeInstanceOf(ApplianceError);
  const err = caught as ApplianceError;
  expect(err.code).toBe('config_invalid');
  expect(err.step).toBe('quarantine');
  expect(err.message).toContain('copy-delete');
  expect(realExistsSync(src)).toBe(true); // evidence untouched
  expect(readdirSync(join(root, 'state', 'quarantine'))).toEqual([]); // no partial slot
  // Post-restore sanity: the real rename primitive works again.
  const probe = join(loaded.config.container.results_root, 'probe');
  tree(probe, { 'p.txt': 'p' });
  realRenameSync(probe, `${probe}-moved`);
  expect(realExistsSync(`${probe}-moved`)).toBe(true);
});

test('moveToQuarantine rejects a traversal name and leaves the source in place', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-')));
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
  expect(realExistsSync(src)).toBe(true); // untouched
  expect(realExistsSync(join(root, 'outside'))).toBe(false); // no escape artifact
  expect(() => moveToQuarantine(loaded, src, '')).toThrow(ApplianceError);
});

test('moveToQuarantine refuses a source outside the results root', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-')));
  const loaded = fakeLoaded(root);
  const outside = mkdtempSync(join(tmpdir(), 'not-results-'));
  expect(() => moveToQuarantine(loaded, outside, 'x')).toThrow(ApplianceError);
  expect(realExistsSync(outside)).toBe(true); // untouched
});

// --- The no-follow namespace boundary: existing components must be real
// --- directories; missing tails are allowed and safely creatable.

test('assertRealDirNoFollow accepts a real dir and rejects symlink, file, and absence', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chain-')));
  assertRealDirNoFollow(root, 'probe'); // does not throw
  writeFileSync(join(root, 'file'), 'x');
  symlinkSync(root, join(root, 'link'));
  for (const target of [
    join(root, 'file'),
    join(root, 'link'),
    join(root, 'missing'),
  ]) {
    const caught = captureError(() => assertRealDirNoFollow(target, 'probe'));
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
  }
});

test('assertNoFollowDirChain allows a missing tail but rejects symlinked or file components', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chain-')));
  expect(
    assertNoFollowDirChain(root, join(root, 'state', 'jobs'), 'jobs'),
  ).toBe(false);
  mkdirSync(join(root, 'state', 'jobs'), { recursive: true });
  expect(
    assertNoFollowDirChain(root, join(root, 'state', 'jobs'), 'jobs'),
  ).toBe(true);
  // A symlinked intermediate:
  const other = mkdtempSync(join(tmpdir(), 'chain-other-'));
  mkdirSync(join(root, 'linked'));
  symlinkSync(other, join(root, 'linked', 'state'));
  expect(() =>
    assertNoFollowDirChain(root, join(root, 'linked', 'state', 'jobs'), 'jobs'),
  ).toThrow(ApplianceError);
  // A file where a directory belongs:
  writeFileSync(join(root, 'flat'), 'x');
  expect(() =>
    assertNoFollowDirChain(root, join(root, 'flat', 'jobs'), 'jobs'),
  ).toThrow(ApplianceError);
  // A target outside the base is never a valid namespace:
  expect(() =>
    assertNoFollowDirChain(root, join(root, '..', 'escape'), 'jobs'),
  ).toThrow(ApplianceError);
});

test('ensurePrivateDirNoFollow creates a missing chain private and rejects a symlinked one', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ensure-')));
  const target = join(root, 'state', 'quarantine');
  ensurePrivateDirNoFollow(root, target, 'quarantine');
  expect(statSync(target).mode & 0o777).toBe(0o700);
  // Redirected component: nothing may be created or chmodded through it.
  const other = mkdtempSync(join(tmpdir(), 'ensure-other-'));
  const root2 = realpathSync(mkdtempSync(join(tmpdir(), 'ensure2-')));
  symlinkSync(other, join(root2, 'state'));
  expect(() =>
    ensurePrivateDirNoFollow(root2, join(root2, 'state', 'quarantine'), 'q'),
  ).toThrow(ApplianceError);
  expect(readdirSync(other)).toEqual([]);
});

test('moveToQuarantine refuses a symlinked quarantine root and leaves the source in place', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-')));
  const loaded = fakeLoaded(root);
  const src = join(loaded.config.container.results_root, 'run-1');
  tree(src, { 'v.txt': 'v' });
  const victim = join(root, 'victim');
  mkdirSync(victim);
  mkdirSync(join(root, 'state'), { recursive: true });
  symlinkSync(victim, join(root, 'state', 'quarantine'));
  const caught = captureError(() => moveToQuarantine(loaded, src, 'slot'));
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).code).toBe('config_invalid');
  expect(realExistsSync(join(src, 'v.txt'))).toBe(true);
  expect(readdirSync(victim)).toEqual([]);
});

test('assertRealDirNoFollow rejects an intermediate symlink component', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abs-')));
  const real = join(root, 'real');
  mkdirSync(join(real, 'child'), { recursive: true });
  symlinkSync(real, join(root, 'hop'));
  const caught = captureError(() =>
    assertRealDirNoFollow(join(root, 'hop', 'child'), 'probe'),
  );
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).code).toBe('config_invalid');
  // The same directory addressed by its real path is accepted:
  assertRealDirNoFollow(join(real, 'child'), 'probe');
});

test('ensurePrivateDirNoFollow rejects a base reached through an intermediate symlink', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abs-ensure-')));
  const real = join(root, 'real');
  mkdirSync(join(real, 'approot'), { recursive: true });
  symlinkSync(real, join(root, 'hop'));
  const base = join(root, 'hop', 'approot');
  expect(() =>
    ensurePrivateDirNoFollow(base, join(base, 'state'), 'state'),
  ).toThrow(ApplianceError);
  // Nothing was created through the link:
  expect(realExistsSync(join(real, 'approot', 'state'))).toBe(false);
});

// The quarantine seam is structural: it accepts a state-only loaded config
// (no bundle field) because prune/import recovery must survive a broken
// credential bundle.
test('moveToQuarantine operates on the structural state config', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-structural-')));
  const full = fakeLoaded(root);
  const { bundle: _bundle, ...structural } = full;
  const src = join(structural.config.container.results_root, 'run-s');
  tree(src, { 'v.txt': 'v' });
  const dest = moveToQuarantine(structural, src, 'run-s');
  expect(realExistsSync(dest)).toBe(true);
  expect(realExistsSync(src)).toBe(false);
});
