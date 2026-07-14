import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Basenames that are never part of the plugin, at ANY depth: VCS, dependency, and
// language tooling caches.
const IGNORE_ANYWHERE: ReadonlySet<string> = new Set<string>([
  '.git',
  'node_modules',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.ty',
  '.venv',
  '__pycache__',
]);

// Top-level-only non-plugin trees: the `evals` submodule (this harness's own
// output — results/, run dirs, fixtures), `.claude` (dev worktrees + local
// state, each a full checkout with its own evals/results), and `.worktrees`
// (using-git-worktrees checkouts — same full-checkout cruft as `.claude`).
// `.claude-plugin` (the plugin manifest) is a different name and is preserved;
// a nested `evals`/`.claude`/`.worktrees` deeper in the tree is real plugin
// content and is kept.
const IGNORE_AT_ROOT: ReadonlySet<string> = new Set<string>([
  'evals',
  '.claude',
  '.worktrees',
]);

// Recursively copy `src` into `dest`, skipping ignored entries BEFORE descending.
// Because ignored directories are never walked, a `dest` that lives inside an
// ignored subtree of `src` (e.g. the codex plugin cache under
// <root>/evals/results/<run>/…) is never visited — so this tolerates
// dest-under-src, which node:fs cpSync rejects outright as a precondition.
function isFileTarget(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false; // dangling link
  }
}

function copyPluginTree(src: string, dest: string, root: string): void {
  mkdirSync(dest, { recursive: true });
  const atRoot = resolve(src) === resolve(root);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const name = entry.name;
    if (IGNORE_ANYWHERE.has(name)) {
      continue;
    }
    if (atRoot && IGNORE_AT_ROOT.has(name)) {
      continue;
    }
    const srcPath = join(src, name);
    const destPath = join(dest, name);
    if (entry.isDirectory()) {
      copyPluginTree(srcPath, destPath, root);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
    } else if (entry.isSymbolicLink() && isFileTarget(srcPath)) {
      // File symlinks are staged as their target's contents, so the staged
      // plugin is self-contained rather than a web of links back into
      // SUPERPOWERS_ROOT. Directory-target and dangling links are skipped:
      // copyfile cannot stage them, and a stray link must never crash
      // provisioning. Sockets/FIFOs are likewise never plugin content.
      copyFileSync(srcPath, destPath);
    }
  }
}

// THE single way to stage the Superpowers plugin into an agent's sandbox. Copies
// the plugin payload from `root` (SUPERPOWERS_ROOT) into `dest`, dropping eval
// output and VCS/build cruft. Every Coding-Agent provisioning adapter that needs
// the plugin in its throwaway home routes through here, so "what the plugin is"
// has exactly one definition.
export function stageSuperpowersPlugin(root: string, dest: string): void {
  copyPluginTree(root, dest, root);
}
