import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneDependencyTrees } from '../src/runner/prune.ts';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

test('removes top-level dependency trees and leaves other files, sorted sibling order', () => {
  const root = tempRoot('runner-prune-');
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module');
  mkdirSync(join(root, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(root, '.venv', 'bin', 'python'), 'py');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'app');
  writeFileSync(join(root, 'package-lock.json'), '{}');

  const removed = pruneDependencyTrees(root);

  expect(removed).toEqual(['.venv', 'node_modules']);
  expect(existsSync(join(root, 'node_modules'))).toBe(false);
  expect(existsSync(join(root, '.venv'))).toBe(false);
  expect(existsSync(join(root, 'src', 'app.ts'))).toBe(true);
  expect(existsSync(join(root, 'package-lock.json'))).toBe(true);
});

test('removes nested dependency trees under arbitrary depth', () => {
  const root = tempRoot('runner-prune-');
  mkdirSync(join(root, 'packages', 'a', 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'packages', 'a', 'node_modules', 'm.js'), 'm');
  mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'a', 'src', 'index.ts'), 'idx');

  const removed = pruneDependencyTrees(root);

  expect(removed).toContain('packages/a/node_modules');
  expect(existsSync(join(root, 'packages', 'a', 'node_modules'))).toBe(false);
  expect(existsSync(join(root, 'packages', 'a', 'src', 'index.ts'))).toBe(true);
});

test('unlinks a symlink named like a dependency tree without touching its target', () => {
  const root = tempRoot('runner-prune-');
  const outside = tempRoot('runner-prune-outside-');
  mkdirSync(join(outside, 'x'), { recursive: true });
  writeFileSync(join(outside, 'x', 'index.js'), 'x');
  symlinkSync(outside, join(root, 'node_modules'));

  const removed = pruneDependencyTrees(root);

  expect(removed).toEqual(['node_modules']);
  expect(existsSync(join(root, 'node_modules'))).toBe(false);
  expect(() => lstatSync(join(root, 'node_modules'))).toThrow();
  expect(existsSync(outside)).toBe(true);
  expect(existsSync(join(outside, 'x', 'index.js'))).toBe(true);
});

test('never follows a symlinked directory to reach a nested dependency tree', () => {
  const root = tempRoot('runner-prune-');
  const outside = tempRoot('runner-prune-outside-');
  mkdirSync(join(outside, 'node_modules'), { recursive: true });
  writeFileSync(join(outside, 'node_modules', 'y.js'), 'y');
  symlinkSync(outside, join(root, 'linked'));

  const removed = pruneDependencyTrees(root);

  expect(removed).toEqual([]);
  expect(existsSync(join(outside, 'node_modules', 'y.js'))).toBe(true);
});

test('leaves a regular file named like a dependency tree alone, and a missing workdir yields []', () => {
  const root = tempRoot('runner-prune-');
  writeFileSync(join(root, 'node_modules'), 'not a directory');

  const removed = pruneDependencyTrees(root);

  expect(removed).toEqual([]);
  expect(existsSync(join(root, 'node_modules'))).toBe(true);
  expect(lstatSync(join(root, 'node_modules')).isFile()).toBe(true);

  expect(pruneDependencyTrees(join(root, 'missing'))).toEqual([]);
});
