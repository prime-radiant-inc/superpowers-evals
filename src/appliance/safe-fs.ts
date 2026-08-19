// Path-validated, delete-free filesystem moves for landed evidence, plus the
// no-follow boundary every mutable appliance namespace root must pass. The
// only mutation primitives here are renameSync (into place, or into
// quarantine) and the private mkdir of a validated missing namespace dir.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { ApplianceError } from './errors.ts';
import type { LoadedApplianceStateConfig } from './types.ts';

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

function namespaceFault(
  label: string,
  path: string,
  detail: string,
): ApplianceError {
  return new ApplianceError(
    'config_invalid',
    'safe-fs',
    `${label} ${detail}: ${path}`,
  );
}

function lstatNoFollow(path: string, label: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    throw namespaceFault(
      label,
      path,
      `is unreadable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function assertRealDirStats(
  stats: Stats | undefined,
  path: string,
  label: string,
): void {
  if (stats === undefined) {
    throw namespaceFault(label, path, 'does not exist');
  }
  if (stats.isSymbolicLink()) {
    throw namespaceFault(label, path, 'is a symlink; repair it manually');
  }
  if (!stats.isDirectory()) {
    throw namespaceFault(label, path, 'must be a real directory');
  }
}

// One namespace probe, walked from the FILESYSTEM root: every component of
// the absolute path — intermediate and final — must be a real directory
// reached without following a symlink. A final-component-only lstat would
// happily traverse an intermediate link (<root>/evals -> elsewhere) and
// vouch for a directory living outside the configured tree, so the walk is
// component-by-component. Operators must configure real paths, not symlink
// aliases; nothing here realpath-normalizes configuration silently.
export function assertRealDirNoFollow(path: string, label: string): void {
  const target = resolve(path);
  let cursor = parse(target).root;
  const rel = relative(cursor, target);
  for (const segment of rel === '' ? [] : rel.split(sep)) {
    cursor = join(cursor, segment);
    assertRealDirStats(lstatNoFollow(cursor, label), cursor, label);
  }
}

// The namespace chain: every EXISTING component from base down to target
// must be a real directory reached without following a symlink. Missing
// tail components are allowed — mutating callers create them via
// ensurePrivateDirNoFollow, read-only callers treat the target as absent.
// Returns whether the target itself exists.
export function assertNoFollowDirChain(
  base: string,
  target: string,
  label: string,
): boolean {
  const b = resolve(base);
  const t = resolve(target);
  const rel = relative(b, t);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw namespaceFault(label, target, `escapes its namespace base ${base}`);
  }
  assertRealDirNoFollow(b, label);
  let cursor = b;
  for (const segment of rel === '' ? [] : rel.split(sep)) {
    cursor = join(cursor, segment);
    const stats = lstatNoFollow(cursor, label);
    if (stats === undefined) {
      return false;
    }
    assertRealDirStats(stats, cursor, label);
  }
  return true;
}

// Mutating ensure over the same boundary: validate the existing prefix,
// then create AT MOST ONE missing component at a time — never a recursive
// mkdir across an unvalidated path — revalidating each component no-follow
// right after creating it. The final target ends private (0o700).
export function ensurePrivateDirNoFollow(
  base: string,
  target: string,
  label: string,
): void {
  assertRealDirNoFollow(base, label);
  const b = resolve(base);
  const t = resolve(target);
  const rel = relative(b, t);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw namespaceFault(label, target, `escapes its namespace base ${base}`);
  }
  let cursor = b;
  for (const segment of rel === '' ? [] : rel.split(sep)) {
    cursor = join(cursor, segment);
    let stats = lstatNoFollow(cursor, label);
    if (stats === undefined) {
      try {
        mkdirSync(cursor, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
      stats = lstatNoFollow(cursor, label);
    }
    assertRealDirStats(stats, cursor, label);
  }
  chmodSync(t, 0o700);
}

export function quarantineRoot(loaded: LoadedApplianceStateConfig): string {
  return join(loaded.config.root, 'state', 'quarantine');
}

// Read-only validation of every mutable appliance namespace root: the
// configured root, the results root, and the state jobs/locks/provenance/
// quarantine roots. Creates and chmods nothing — missing state dirs are
// fine (mutation paths ensure them); symlinked or non-directory ones are
// config faults that need manual repair.
export function assertApplianceNamespaces(
  loaded: LoadedApplianceStateConfig,
): void {
  const root = loaded.config.root;
  assertRealDirNoFollow(root, 'appliance root');
  assertRealDirNoFollow(loaded.config.container.results_root, 'results_root');
  assertNoFollowDirChain(root, loaded.paths.jobs, 'state/jobs');
  assertNoFollowDirChain(root, loaded.paths.locks, 'state/locks');
  assertNoFollowDirChain(root, loaded.paths.provenance, 'state/provenance');
  assertNoFollowDirChain(root, quarantineRoot(loaded), 'state/quarantine');
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
  loaded: LoadedApplianceStateConfig,
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
  const qroot = quarantineRoot(loaded);
  ensurePrivateDirNoFollow(loaded.config.root, qroot, 'state/quarantine');
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
