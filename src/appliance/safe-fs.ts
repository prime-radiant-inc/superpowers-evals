// Path-validated, delete-free filesystem moves for landed evidence. The only
// mutation primitive here is renameSync: into place, or into quarantine.
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { ApplianceError } from './errors.ts';
import { mkdirPrivate } from './fs.ts';
import type { LoadedApplianceConfig } from './types.ts';

// Resolve target against root and refuse the root itself or any escape —
// lexically, and via symlink through the nearest existing ancestor. Dangling
// symlinks fail closed: lstat sees the link entry itself, so a path through an
// unresolved link is rejected now rather than only when its target appears.
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
  // A missing root would otherwise surface as a raw ENOENT from realpathSync;
  // refuse it with the same typed error as every other config fault.
  if (!existsSync(r)) {
    throw new ApplianceError(
      'config_invalid',
      'safe-fs',
      `root does not exist: ${root}`,
    );
  }
  // Walk up to the nearest existing entry WITHOUT following symlinks, so a
  // dangling link is an entry we then fail to resolve, not a missing tail.
  let cursor = t;
  for (;;) {
    if (lstatSync(cursor, { throwIfNoEntry: false }) !== undefined) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const realBase = realpathSync(r);
  let realCursor: string;
  try {
    realCursor = realpathSync(cursor);
  } catch {
    throw new ApplianceError(
      'config_invalid',
      'safe-fs',
      `path resolves through a dangling or unresolved symlink: ${target}`,
    );
  }
  if (realCursor !== realBase && !realCursor.startsWith(realBase + sep)) {
    throw new ApplianceError(
      'config_invalid',
      'safe-fs',
      `refusing symlink escape: ${target}`,
    );
  }
}

interface TreeScan {
  files: Map<string, string>; // rel -> abs
  nonRegular: boolean; // a symlink/fifo/socket/device entry is present
}

function scanTree(root: string, exclude: ReadonlySet<string>): TreeScan {
  const files = new Map<string, string>();
  let nonRegular = false;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(p);
      } else if (entry.isFile()) {
        const rel = relative(root, p);
        if (!exclude.has(rel)) files.set(rel, p);
      } else {
        // Symlink (to file or dir), fifo, socket, device: refuse to vouch for
        // byte-identity of trees carrying anything but regular files.
        nonRegular = true;
      }
    }
  };
  if (existsSync(root)) visit(root);
  return { files, nonRegular };
}

// Byte-identity over relative file sets: same paths (minus exclusions) and the
// same sha-256 per file. Exclusions match relative paths exactly — import adds
// 'appliance-provenance.json' to a landed run dir, so the bundle payload and
// the landed dir compare equal only with that file excluded. A tree carrying
// any non-regular entry compares unequal: a conservative false negative is
// safer than a false idempotent match over silently ignored symlinks.
export function dirsEquivalent(
  a: string,
  b: string,
  opts?: { exclude?: readonly string[] },
): boolean {
  const exclude = new Set(opts?.exclude ?? []);
  const sa = scanTree(a, exclude);
  const sb = scanTree(b, exclude);
  if (sa.nonRegular || sb.nonRegular) return false;
  if (sa.files.size !== sb.files.size) return false;
  for (const [rel, pa] of sa.files) {
    const pb = sb.files.get(rel);
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
  // The slot name becomes one path component of the destination; refuse
  // anything that is not exactly a single safe component.
  if (name === '' || name === '.' || name === '..' || name !== basename(name)) {
    throw new ApplianceError(
      'config_invalid',
      'quarantine',
      `refusing unsafe quarantine name: ${name}`,
    );
  }
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
