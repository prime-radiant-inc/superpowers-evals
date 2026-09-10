import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  type Dirent,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ATIF_NORMALIZERS } from '../../capture/index.ts';
import type {
  CapturedSource,
  SourceIndex,
} from '../../capture/source-index.ts';
import {
  type CollectDiagnosisArgs,
  type DiagnosisArtifacts,
  type DiagnosisHarness,
  type FilePreservation,
  FixtureManifestSchema,
  type RetainedArtifact,
} from './contracts.ts';

const STORE_ROOT_PARTS: Readonly<Record<DiagnosisHarness, readonly string[]>> =
  {
    claude: ['.claude', 'projects'],
    codex: ['.codex', 'sessions'],
    pi: ['.pi', 'agent', 'sessions'],
  };
const HISTORY_DIR = 'diagnosis-history';
const ARTIFACTS_DIR = 'diagnosis-artifacts';
const EXCLUDED_WORKDIR_DIRECTORIES = new Set(['.git', 'node_modules', '.venv']);
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function runRelative(runDir: string, path: string): string {
  return relative(runDir, path).split(sep).join('/');
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function assertNoSymlinkComponents(root: string, candidate: string): void {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (!isWithin(absoluteRoot, absoluteCandidate)) {
    throw new Error(`path escapes collection root: ${absoluteCandidate}`);
  }
  let current = absoluteRoot;
  const parts = relative(absoluteRoot, absoluteCandidate)
    .split(sep)
    .filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part !== '') current = join(current, part);
    if (!existsSync(current)) {
      throw new Error(`missing path: ${absoluteCandidate}`);
    }
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`symbolic link refused: ${current}`);
    }
  }
}

function readRegularFile(root: string, path: string): Buffer {
  assertNoSymlinkComponents(root, path);
  const fd = openSync(path, READ_FLAGS);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`not a regular file: ${path}`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeRetained(
  args: CollectDiagnosisArgs,
  files: RetainedArtifact[],
  originalPath: string,
  retainedPath: string,
  bytes: Buffer,
): void {
  const destination = join(args.runDir, retainedPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  files.push({
    originalPath: resolve(originalPath),
    retainedPath,
    sha256: hash(bytes),
    bytes: bytes.byteLength,
  });
}

function inventoryRetained(
  args: CollectDiagnosisArgs,
  files: RetainedArtifact[],
  originalPath: string,
  bytes: Buffer,
): void {
  const retainedPath = runRelative(args.runDir, originalPath);
  if (
    retainedPath === '' ||
    retainedPath === '..' ||
    retainedPath.startsWith('../')
  ) {
    throw new Error(
      `workdir artifact is outside the run directory: ${originalPath}`,
    );
  }
  files.push({
    originalPath: resolve(originalPath),
    retainedPath,
    sha256: hash(bytes),
    bytes: bytes.byteLength,
  });
}

function walkRegularFiles(
  scanRoot: string,
  containmentRoot: string,
  errors: string[],
  excludedDirectories: ReadonlySet<string> = new Set(),
  reportSymlinks = true,
): Array<{ path: string; relativePath: string; bytes: Buffer }> {
  const found: Array<{ path: string; relativePath: string; bytes: Buffer }> =
    [];
  const walk = (directory: string, prefix: string): void => {
    let entries: Dirent<string>[];
    try {
      assertNoSymlinkComponents(containmentRoot, directory);
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(
        `artifact directory unreadable at ${directory}: ${errorMessage(error)}`,
      );
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath =
        prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        if (reportSymlinks) errors.push(`symbolic link refused: ${path}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name)) continue;
        walk(path, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        errors.push(`non-regular artifact refused: ${path}`);
        continue;
      }
      try {
        found.push({
          path,
          relativePath,
          bytes: readRegularFile(containmentRoot, path),
        });
      } catch (error) {
        errors.push(`artifact unreadable at ${path}: ${errorMessage(error)}`);
      }
    }
  };
  if (existsSync(scanRoot)) walk(scanRoot, '');
  return found;
}

function installedPath(args: CollectDiagnosisArgs, index: number): string {
  const declaration = args.manifest.files[index];
  if (declaration === undefined)
    throw new Error(`manifest file ${index} missing`);
  const destinationRoot =
    declaration.destination === 'session-store'
      ? join(args.home, ...STORE_ROOT_PARTS[args.manifest.harness])
      : args.workdir;
  return join(destinationRoot, declaration.relativePath);
}

/** Retain diagnosis evidence without following links or pricing old sessions. */
export function collectDiagnosisArtifacts(
  input: CollectDiagnosisArgs,
): DiagnosisArtifacts {
  const manifest = FixtureManifestSchema.parse(input.manifest);
  const args: CollectDiagnosisArgs = { ...input, manifest };
  const artifactRoot = join(args.runDir, ARTIFACTS_DIR);
  const historyRoot = join(args.runDir, HISTORY_DIR);
  rmSync(artifactRoot, { recursive: true, force: true });
  rmSync(historyRoot, { recursive: true, force: true });
  mkdirSync(args.runDir, { recursive: true });

  const files: RetainedArtifact[] = [];
  const preservation: FilePreservation[] = [];
  const errors: string[] = [];
  const historySources: CapturedSource[] = [];
  let historyOrdinal = 0;

  const manifestPath = join(args.corpusDir, 'manifest.json');
  try {
    const bytes = readRegularFile(args.corpusDir, manifestPath);
    writeRetained(
      args,
      files,
      manifestPath,
      `${HISTORY_DIR}/manifest.json`,
      bytes,
    );
  } catch (error) {
    errors.push(
      `fixture manifest unavailable at ${manifestPath}: ${errorMessage(error)}`,
    );
  }

  for (const [index, declaration] of manifest.files.entries()) {
    const path = installedPath(args, index);
    const containmentRoot =
      declaration.destination === 'session-store' ? args.home : args.workdir;
    let bytes: Buffer | null = null;
    try {
      bytes = readRegularFile(containmentRoot, path);
    } catch (error) {
      errors.push(`historical file missing at ${path}: ${errorMessage(error)}`);
    }
    const actualSha256 = bytes === null ? null : hash(bytes);
    const status: FilePreservation['status'] =
      bytes === null
        ? 'missing'
        : actualSha256 === declaration.sha256
          ? 'unchanged'
          : 'changed';
    preservation.push({
      source: declaration.path,
      installedPath: path,
      expectedSha256: declaration.sha256,
      actualSha256,
      status,
    });
    if (status === 'changed') {
      errors.push(`historical file changed at ${path}`);
    }

    if (bytes !== null && declaration.destination === 'session-store') {
      writeRetained(
        args,
        files,
        path,
        `${HISTORY_DIR}/native/session-store/${declaration.relativePath}`,
        bytes,
      );
    }

    if (!declaration.relativePath.endsWith('.jsonl')) continue;
    historyOrdinal += 1;
    const id = `history-${String(historyOrdinal).padStart(6, '0')}`;
    const trajectoryPath = `${HISTORY_DIR}/atif-sources/${String(historyOrdinal).padStart(6, '0')}.json`;
    if (bytes === null) {
      historySources.push({
        id,
        nativePath: path,
        sha256: '',
        trajectoryPath: null,
        error: 'native historical file is unavailable',
      });
      continue;
    }
    try {
      const normalizer = ATIF_NORMALIZERS[manifest.harness];
      if (normalizer === undefined) {
        throw new Error(`unknown normalizer: ${manifest.harness}`);
      }
      const trajectory = normalizer(bytes.toString('utf8'), 'unknown');
      const destination = join(args.runDir, trajectoryPath);
      writeRetained(
        args,
        files,
        destination,
        trajectoryPath,
        Buffer.from(`${JSON.stringify(trajectory, null, 2)}\n`),
      );
      historySources.push({
        id,
        nativePath: path,
        sha256: actualSha256 ?? '',
        trajectoryPath,
        error: null,
      });
    } catch (error) {
      const message = errorMessage(error);
      historySources.push({
        id,
        nativePath: path,
        sha256: actualSha256 ?? '',
        trajectoryPath: null,
        error: message,
      });
      errors.push(`historical normalization failed for ${path}: ${message}`);
    }
  }

  const sourceIndex: SourceIndex = {
    schemaVersion: 1,
    sources: historySources,
    mergedSteps: [],
  };
  const sourceIndexPath = join(historyRoot, 'atif-sources.json');
  writeRetained(
    args,
    files,
    sourceIndexPath,
    `${HISTORY_DIR}/atif-sources.json`,
    Buffer.from(`${JSON.stringify(sourceIndex, null, 2)}\n`),
  );

  const diagnosisRoot = join(
    args.home,
    '.superpowers',
    'diagnosing-superpowers',
  );
  for (const generated of walkRegularFiles(diagnosisRoot, args.home, errors)) {
    writeRetained(
      args,
      files,
      generated.path,
      `${ARTIFACTS_DIR}/${generated.relativePath}`,
      generated.bytes,
    );
  }

  const inventoried = new Set(files.map((file) => file.originalPath));
  for (const generated of walkRegularFiles(
    args.workdir,
    args.workdir,
    errors,
    EXCLUDED_WORKDIR_DIRECTORIES,
    false,
  )) {
    const absolute = resolve(generated.path);
    if (inventoried.has(absolute)) continue;
    try {
      inventoryRetained(args, files, generated.path, generated.bytes);
      inventoried.add(absolute);
    } catch (error) {
      errors.push(
        `workdir artifact unavailable at ${generated.path}: ${errorMessage(error)}`,
      );
    }
  }

  files.sort((a, b) => a.retainedPath.localeCompare(b.retainedPath));
  const result: DiagnosisArtifacts = {
    schemaVersion: 1,
    files,
    preservation,
    errors,
  };
  writeFileSync(
    join(args.runDir, 'diagnosis-artifacts.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}
