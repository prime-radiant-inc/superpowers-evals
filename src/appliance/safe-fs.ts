// Path-validated, delete-free filesystem moves for landed evidence. The only
// mutation primitive here is renameSync: into place, or into quarantine.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ApplianceError } from './errors.ts';
import { mkdirPrivate } from './fs.ts';
import type { LoadedApplianceConfig } from './types.ts';

// Resolve target against root and refuse the root itself or any escape —
// lexically, and via symlink through the nearest existing ancestor.
export function assertInsideRoot(root: string, target: string): void {
  const r = resolve(root);
  const t = resolve(target);
  if (t === r || !t.startsWith(r + sep)) {
    throw new ApplianceError(
      'config_invalid',
      'safe-fs',
      `refusing path outside root: ${target}`,
    );
  }
  let cursor = t;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // A missing root would otherwise surface as a raw ENOENT from realpathSync;
  // refuse it with the same typed error as every other config fault.
  if (!existsSync(r)) {
    throw new ApplianceError(
      'config_invalid',
      'safe-fs',
      `root does not exist: ${root}`,
    );
  }
  const realBase = realpathSync(r);
  const realCursor = realpathSync(cursor);
  if (realCursor !== realBase && !realCursor.startsWith(realBase + sep)) {
    throw new ApplianceError(
      'config_invalid',
      'safe-fs',
      `refusing symlink escape: ${target}`,
    );
  }
}

function listFiles(
  root: string,
  exclude: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>(); // rel -> abs
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(p);
      } else if (entry.isFile()) {
        const rel = relative(root, p);
        if (!exclude.has(rel)) out.set(rel, p);
      }
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

// Byte-identity over relative file sets: same paths (minus exclusions) and the
// same sha-256 per file. Exclusions match relative paths exactly — import adds
// 'appliance-provenance.json' to a landed run dir, so the bundle payload and
// the landed dir compare equal only with that file excluded.
export function dirsEquivalent(
  a: string,
  b: string,
  opts?: { exclude?: readonly string[] },
): boolean {
  const exclude = new Set(opts?.exclude ?? []);
  const fa = listFiles(a, exclude);
  const fb = listFiles(b, exclude);
  if (fa.size !== fb.size) return false;
  for (const [rel, pa] of fa) {
    const pb = fb.get(rel);
    if (pb === undefined) return false;
    if (
      Bun.SHA256.hash(readFileSync(pa), 'hex') !==
      Bun.SHA256.hash(readFileSync(pb), 'hex')
    ) {
      return false;
    }
  }
  return true;
}

// O(1) rename into state/quarantine/ — never a recursive copy, never a delete.
// state/ sits beside the results root under the appliance root, so this is
// same-volume by construction; a cross-volume surprise is a typed error, not a
// copy-delete fallback.
export function moveToQuarantine(
  loaded: LoadedApplianceConfig,
  sourcePath: string,
  name: string,
): string {
  assertInsideRoot(loaded.config.container.results_root, sourcePath);
  const qroot = join(loaded.config.root, 'state', 'quarantine');
  mkdirPrivate(qroot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dest = join(qroot, `${stamp}-${name}`);
  for (let n = 2; existsSync(dest); n += 1) {
    dest = join(qroot, `${stamp}-${name}-${n}`);
  }
  try {
    renameSync(sourcePath, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new ApplianceError(
        'config_invalid',
        'quarantine',
        `quarantine is cross-volume for ${sourcePath}; refusing copy-delete fallback`,
      );
    }
    throw error;
  }
  return dest;
}
