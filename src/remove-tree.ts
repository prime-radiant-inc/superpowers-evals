import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Removes a directory tree that a tool may have left partly read-only (Go
 *  extracts its module cache with 0555 directories): every real directory
 *  is first made writable and searchable for the owner, walking with lstat
 *  so symlinks are never followed or changed through, then the tree is
 *  removed. A missing `root` is fine; other failures propagate. */
export function removeTree(root: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(root);
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return;
    throw e;
  }
  if (stat.isDirectory()) makeWritable(root);
  rmSync(root, { recursive: true, force: true });
}

function makeWritable(dir: string): void {
  chmodSync(dir, lstatSync(dir).mode | 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) makeWritable(join(dir, entry.name));
  }
}
