import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  type DiagnosisHarness,
  type FilePreservation,
  type FixtureArgs,
  type FixtureFile,
  FixtureManifestSchema,
} from './contracts.ts';

const STORE_ROOT_PARTS: Readonly<Record<DiagnosisHarness, readonly string[]>> =
  {
    claude: ['.claude', 'projects'],
    codex: ['.codex', 'sessions'],
    pi: ['.pi', 'agent', 'sessions'],
  };

interface PreparedFile {
  readonly declaration: FixtureFile;
  readonly sourcePath: string;
  readonly installedPath: string;
  readonly destinationContainmentRoot: string;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`diagnosis-fixtures: ${label} is not a directory`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`diagnosis-fixtures: ${label} is a symbolic link`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`diagnosis-fixtures: ${label} is not a directory`);
  }
}

function assertSafePath(
  root: string,
  candidate: string,
  label: 'source' | 'destination',
): void {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (!isWithin(absoluteRoot, absoluteCandidate)) {
    throw new Error(`diagnosis-fixtures: ${label} path escapes its root`);
  }

  let current = absoluteRoot;
  if (existsSync(current)) {
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `diagnosis-fixtures: ${label} path contains a symbolic link`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new Error(`diagnosis-fixtures: ${label} root is not a directory`);
    }
  }

  const parts = relative(absoluteRoot, absoluteCandidate).split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    if (!existsSync(current)) {
      continue;
    }
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `diagnosis-fixtures: ${label} path contains a symbolic link`,
      );
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new Error(
        `diagnosis-fixtures: ${label} path has a non-directory parent`,
      );
    }
  }
}

function destinationRoot(args: FixtureArgs, file: FixtureFile): string {
  return file.destination === 'session-store'
    ? join(args.home, ...STORE_ROOT_PARTS[args.manifest.harness])
    : args.workdir;
}

function assertNoDestinationConflicts(files: readonly PreparedFile[]): void {
  for (const [index, file] of files.entries()) {
    const installedPath = resolve(file.installedPath);
    for (const other of files.slice(index + 1)) {
      const otherInstalledPath = resolve(other.installedPath);
      if (
        installedPath === otherInstalledPath ||
        isWithin(installedPath, otherInstalledPath) ||
        isWithin(otherInstalledPath, installedPath)
      ) {
        throw new Error(
          `diagnosis-fixtures: destination conflict: ${file.declaration.destination}/${file.declaration.relativePath} and ${other.declaration.destination}/${other.declaration.relativePath}`,
        );
      }
    }
  }
}

function prepareFiles(args: FixtureArgs): PreparedFile[] {
  const manifest = FixtureManifestSchema.parse(args.manifest);
  assertDirectory(args.corpusDir, 'corpusDir');
  const corpusRoot = resolve(args.corpusDir);

  const prepared = manifest.files.map((declaration) => {
    const sourcePath = join(corpusRoot, declaration.path);
    assertSafePath(corpusRoot, sourcePath, 'source');
    if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
      throw new Error(
        `diagnosis-fixtures: source is missing or not a regular file: ${declaration.path}`,
      );
    }
    if (sha256(sourcePath) !== declaration.sha256) {
      throw new Error(
        `diagnosis-fixtures: source hash mismatch: ${declaration.path}`,
      );
    }

    const root = destinationRoot({ ...args, manifest }, declaration);
    const installedPath = join(root, declaration.relativePath);
    return {
      declaration,
      sourcePath,
      installedPath,
      destinationContainmentRoot:
        declaration.destination === 'session-store' ? args.home : args.workdir,
    };
  });

  assertNoDestinationConflicts(prepared);
  return prepared;
}

/** Install the reviewed fixture files without interpreting their contents. */
export function installDiagnosisFixture(args: FixtureArgs): void {
  const prepared = prepareFiles(args);

  for (const file of prepared) {
    assertSafePath(
      file.destinationContainmentRoot,
      file.installedPath,
      'destination',
    );
    if (existsSync(file.installedPath)) {
      throw new Error(
        `diagnosis-fixtures: destination already exists: ${file.declaration.destination}/${file.declaration.relativePath}`,
      );
    }
  }

  for (const file of prepared) {
    mkdirSync(dirname(file.installedPath), { recursive: true });
    copyFileSync(file.sourcePath, file.installedPath, constants.COPYFILE_EXCL);
  }
}

/** Compare installed fixture bytes with the reviewed manifest. */
export function verifyDiagnosisFixture(args: FixtureArgs): FilePreservation[] {
  const prepared = prepareFiles(args);

  return prepared.map((file) => {
    assertSafePath(
      file.destinationContainmentRoot,
      file.installedPath,
      'destination',
    );
    if (!existsSync(file.installedPath)) {
      return {
        source: file.declaration.path,
        installedPath: file.installedPath,
        expectedSha256: file.declaration.sha256,
        actualSha256: null,
        status: 'missing',
      };
    }
    const metadata = lstatSync(file.installedPath);
    if (!metadata.isFile()) {
      return {
        source: file.declaration.path,
        installedPath: file.installedPath,
        expectedSha256: file.declaration.sha256,
        actualSha256: null,
        status: 'missing',
      };
    }
    const actualSha256 = sha256(file.installedPath);
    return {
      source: file.declaration.path,
      installedPath: file.installedPath,
      expectedSha256: file.declaration.sha256,
      actualSha256,
      status:
        actualSha256 === file.declaration.sha256 ? 'unchanged' : 'changed',
    };
  });
}
