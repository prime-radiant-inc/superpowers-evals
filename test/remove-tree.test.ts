import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTree } from '../src/remove-tree.ts';

let root: string;

/** Give the owner write+search back on every real directory under `dir` so a
 *  failing assertion cannot leave an undeletable temp root behind. */
function restoreModes(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) restoreModes(join(dir, entry.name));
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'remove-tree-')));
});

afterEach(() => {
  if (existsSync(root)) restoreModes(root);
  rmSync(root, { recursive: true, force: true });
});

test('a nested tree of read-only directories is removed', () => {
  const mod = join(root, 'mod');
  mkdirSync(join(mod, 'x', 'y'), { recursive: true });
  writeFileSync(join(mod, 'x', 'y', 'file.txt'), 'x');
  chmodSync(join(mod, 'x', 'y'), 0o555);
  chmodSync(join(mod, 'x'), 0o555);
  chmodSync(mod, 0o555);

  removeTree(mod);

  expect(existsSync(mod)).toBe(false);
});

test('a symlink to an outside read-only directory is unlinked, not followed', () => {
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  chmodSync(outside, 0o555);
  const tree = join(root, 'tree');
  mkdirSync(tree);
  symlinkSync(outside, join(tree, 'link'));

  removeTree(tree);

  expect(existsSync(tree)).toBe(false);
  expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  expect(statSync(outside).mode & 0o777).toBe(0o555);
});

test('a missing root is not an error', () => {
  expect(() => removeTree(join(root, 'missing'))).not.toThrow();
});

test('a read-only file inside a writable directory is removed', () => {
  const dir = join(root, 'writable');
  mkdirSync(dir);
  const file = join(dir, 'ro.txt');
  writeFileSync(file, 'x');
  chmodSync(file, 0o444);

  removeTree(dir);

  expect(existsSync(dir)).toBe(false);
});
