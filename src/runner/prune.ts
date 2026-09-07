import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export const DEPENDENCY_TREE_NAMES: readonly string[] = [
  'node_modules',
  '.venv',
];

/** Removes every dependency tree under `workdir` (any depth) before the
 *  attempt manifest is written: a campaign publishes behavioral evidence,
 *  and dependency trees (thousands of files, reproducible from lockfiles)
 *  starve the controller that has to hash them. Never follows symlinks: a
 *  symlink NAMED like a tree is unlinked (link only), a symlinked directory
 *  is neither descended nor removed, and a regular file with a tree's name
 *  is left alone. Returns the removed paths relative to `workdir`,
 *  POSIX-separated, in the order removed (depth-first; siblings in sorted
 *  readdir order). A missing `workdir` yields []. */
export function pruneDependencyTrees(workdir: string): string[] {
  if (!existsSync(workdir) || !lstatSync(workdir).isDirectory()) return [];

  const removed: string[] = [];

  const walk = (dir: string, displayPath: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const relPath =
        displayPath.length === 0 ? entry.name : `${displayPath}/${entry.name}`;
      if (DEPENDENCY_TREE_NAMES.includes(entry.name)) {
        if (entry.isSymbolicLink()) {
          unlinkSync(path);
          removed.push(relPath);
        } else if (entry.isDirectory()) {
          rmSync(path, { recursive: true, force: true });
          removed.push(relPath);
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(path, relPath);
      }
    }
  };

  walk(workdir, '');
  return removed;
}
