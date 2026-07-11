// Content-addressed scenario fixture baselines.
//
// A baseline manifest names every regular file in a scenario's fixtures tree.
// The same parsed manifest is used twice: `quorum check` validates the static
// fixtures and the `baseline-manifest` check verb validates the seeded worktree
// before a Coding-Agent is launched.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { join, posix } from 'node:path';
import { z } from 'zod';

const BaselineFileSchema = z
  .object({
    path: z.string(),
    mode: z.string(),
    sha256: z.string(),
  })
  .strict();

const BaselineManifestSchema = z
  .object({
    schema_version: z.literal(1),
    roles: z
      .object({
        spec: z.string(),
        plan: z.string(),
      })
      .strict(),
    files: z.array(BaselineFileSchema),
  })
  .strict();

export type BaselineManifest = z.infer<typeof BaselineManifestSchema>;

export interface VerifyBaselineTreeArgs {
  readonly manifest: BaselineManifest;
  readonly rootDir: string;
  /** Ignore the root worktree's `.git/` directory, and nothing else. */
  readonly ignoreGitDir?: boolean;
}

/** Parse and strictly narrow a baseline-manifest.json document. */
export function parseBaselineManifest(path: string): BaselineManifest {
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON: ${detail}`);
  }
  return BaselineManifestSchema.parse(parsed);
}

/**
 * Compare a manifest with a tree of regular files. Paths, modes, bytes, and
 * inventory must match exactly. The result is sorted so scenario checks remain
 * stable across filesystem traversal order.
 */
export function verifyBaselineTree(args: VerifyBaselineTreeArgs): string[] {
  const problems = new Set<string>();
  const manifestProblems = validateManifestDefinition(args.manifest);
  for (const problem of manifestProblems) problems.add(problem);

  const declared = new Map<string, BaselineManifest['files'][number]>();
  for (const file of args.manifest.files) {
    if (isSafeRelativePath(file.path)) declared.set(file.path, file);
  }

  const tree = inspectTree(args.rootDir, args.ignoreGitDir === true);
  for (const problem of tree.problems) problems.add(problem);

  for (const [path, file] of declared) {
    const actual = lstatAt(args.rootDir, path);
    if (actual === null) {
      problems.add(`missing file: ${path}`);
      continue;
    }
    if (actual.isSymbolicLink()) {
      problems.add(`symlink: ${path}`);
      continue;
    }
    if (!actual.isFile()) {
      problems.add(`not a regular file: ${path}`);
      continue;
    }
    const actualMode = gitMode(actual);
    if (actualMode !== file.mode) {
      problems.add(
        `mode mismatch: ${path} (expected ${file.mode}, got ${actualMode})`,
      );
    }
    if (digestAt(args.rootDir, path) !== file.sha256) {
      problems.add(`sha256 mismatch: ${path}`);
    }
  }

  for (const path of tree.files) {
    if (!declared.has(path)) problems.add(`extra file: ${path}`);
  }

  return [...problems].sort(comparePaths);
}

/**
 * Validate an optional scenario manifest against its static fixtures tree.
 * Callers check for file presence first so older scenarios remain unchanged.
 */
export function validateBaselineManifest(scenarioDir: string): string[] {
  const manifestPath = join(scenarioDir, 'baseline-manifest.json');
  let manifest: BaselineManifest;
  try {
    manifest = parseBaselineManifest(manifestPath);
  } catch (error) {
    return [`baseline-manifest.json invalid: ${errorDetail(error)}`];
  }
  return verifyBaselineTree({
    manifest,
    rootDir: join(scenarioDir, 'fixtures'),
  });
}

function validateManifestDefinition(manifest: BaselineManifest): string[] {
  const problems = new Set<string>();
  const seen = new Set<string>();
  let previous: string | undefined;

  for (const file of manifest.files) {
    if (!isSafeRelativePath(file.path)) {
      problems.add(`invalid path: ${file.path}`);
      continue;
    }
    if (seen.has(file.path)) problems.add(`duplicate path: ${file.path}`);
    seen.add(file.path);
    if (previous !== undefined && comparePaths(previous, file.path) > 0) {
      problems.add('manifest files must be sorted by path');
    }
    previous = file.path;
    if (file.mode !== '100644' && file.mode !== '100755') {
      problems.add(`invalid mode: ${file.path} (${file.mode})`);
    }
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) {
      problems.add(`invalid sha256: ${file.path}`);
    }
  }

  for (const role of ['spec', 'plan'] as const) {
    const path = manifest.roles[role];
    if (!isSafeRelativePath(path)) {
      problems.add(`invalid role path: ${role}: ${path}`);
    } else if (!seen.has(path)) {
      problems.add(`role ${role} is not declared in files: ${path}`);
    }
  }

  return [...problems].sort(comparePaths);
}

function isSafeRelativePath(path: string): boolean {
  if (
    path === '' ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }
  const normalized = posix.normalize(path);
  return (
    normalized === path &&
    !path
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

interface TreeInspection {
  readonly files: readonly string[];
  readonly problems: readonly string[];
}

function inspectTree(rootDir: string, ignoreGitDir: boolean): TreeInspection {
  const files: string[] = [];
  const problems = new Set<string>();
  const root = lstatAt(rootDir, '');
  if (root === null) {
    problems.add('baseline root missing');
    return { files, problems: [...problems] };
  }
  if (root.isSymbolicLink()) {
    problems.add('baseline root is a symlink');
    return { files, problems: [...problems] };
  }
  if (!root.isDirectory()) {
    problems.add('baseline root is not a directory');
    return { files, problems: [...problems] };
  }

  const visit = (directory: string, relativeDir: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => comparePaths(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      const absolutePath = join(directory, entry.name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        problems.add(`symlink: ${relativePath}`);
      } else if (stat.isDirectory()) {
        if (ignoreGitDir && relativeDir === '' && entry.name === '.git') {
          continue;
        }
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        files.push(relativePath);
      } else {
        problems.add(`non-regular file: ${relativePath}`);
      }
    }
  };

  visit(rootDir, '');
  return { files: files.sort(comparePaths), problems: [...problems] };
}

function lstatAt(rootDir: string, relativePath: string): Stats | null {
  try {
    return lstatSync(
      relativePath === '' ? rootDir : join(rootDir, relativePath),
    );
  } catch {
    return null;
  }
}

function digestAt(rootDir: string, relativePath: string): string {
  return createHash('sha256')
    .update(readFileSync(join(rootDir, relativePath)))
    .digest('hex');
}

function gitMode(stat: Stats): string {
  return `100${(stat.mode & 0o7777).toString(8).padStart(3, '0')}`;
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
