import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export type DiscoveryHarness = 'claude' | 'codex' | 'pi';

export interface HistoryInstall {
  agent: DiscoveryHarness;
  home: string;
  workdir: string;
  sourceDir: string;
}

export interface HistoryFile {
  relativePath: string;
  sha256: string;
}

const LOG_ROOT_PARTS: Readonly<Record<DiscoveryHarness, readonly string[]>> = {
  claude: ['.claude', 'projects'],
  codex: ['.codex', 'sessions'],
  pi: ['.pi', 'agent', 'sessions'],
};

interface CorpusFile extends HistoryFile {
  readonly absolutePath: string;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function portableRelativePath(path: string): string {
  return path.split(sep).join('/');
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    throw new Error(`session-discovery-fixtures: ${label} is not a directory`);
  }
}

function listCorpus(sourceDir: string): CorpusFile[] {
  assertDirectory(sourceDir, 'sourceDir');
  const sourceRoot = realpathSync(sourceDir);
  const files: CorpusFile[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          'session-discovery-fixtures: sourceDir may contain only regular files and directories',
        );
      }
      const resolvedFile = realpathSync(absolutePath);
      if (!isWithin(sourceRoot, resolvedFile)) {
        throw new Error(
          'session-discovery-fixtures: corpus path escapes sourceDir',
        );
      }
      const relativePath = portableRelativePath(
        relative(sourceRoot, resolvedFile),
      );
      if (!relativePath.endsWith('.jsonl')) {
        throw new Error(
          `session-discovery-fixtures: corpus file is not a native JSONL history: ${relativePath}`,
        );
      }
      files.push({
        absolutePath: resolvedFile,
        relativePath,
        sha256: sha256(resolvedFile),
      });
    }
  }

  visit(sourceRoot);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  if (files.length !== 3) {
    throw new Error(
      `session-discovery-fixtures: expected exactly three history files, found ${files.length}`,
    );
  }
  return files;
}

function assertNoSymlinkPath(root: string, candidate: string): void {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (!isWithin(absoluteRoot, absoluteCandidate)) {
    throw new Error(
      'session-discovery-fixtures: destination path escapes its root',
    );
  }

  let current = absoluteRoot;
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
    throw new Error(
      'session-discovery-fixtures: destination path contains a symbolic link',
    );
  }
  for (const part of relative(absoluteRoot, absoluteCandidate).split(sep)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(
        'session-discovery-fixtures: destination path contains a symbolic link',
      );
    }
  }
}

function copyCorpus(
  files: readonly CorpusFile[],
  destinationRoot: string,
  containmentRoot: string,
): void {
  assertNoSymlinkPath(containmentRoot, destinationRoot);
  mkdirSync(destinationRoot, { recursive: true });
  for (const file of files) {
    const destination = join(destinationRoot, file.relativePath);
    assertNoSymlinkPath(destinationRoot, destination);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file.absolutePath, destination, constants.COPYFILE_EXCL);
  }
}

function historyRoot(args: HistoryInstall): string {
  return join(args.home, ...LOG_ROOT_PARTS[args.agent]);
}

function publicManifest(files: readonly CorpusFile[]): HistoryFile[] {
  return files.map(({ relativePath, sha256: digest }) => ({
    relativePath,
    sha256: digest,
  }));
}

/** Install the three reviewed native histories without touching the workdir. */
export function installHistory(args: HistoryInstall): HistoryFile[] {
  const files = listCorpus(args.sourceDir);
  copyCorpus(files, historyRoot(args), args.home);
  return publicManifest(files);
}

/**
 * Retain only the installed corpus files after verifying their bytes still
 * match the reviewed source. New evaluation logs and home configuration are
 * intentionally outside this allowlist.
 */
export function collectHistory(
  args: HistoryInstall & { outputDir: string },
): HistoryFile[] {
  if (!isWithin(args.workdir, args.outputDir)) {
    throw new Error(
      'session-discovery-fixtures: outputDir must be beneath workdir',
    );
  }
  if (existsSync(args.outputDir)) {
    throw new Error(
      'session-discovery-fixtures: outputDir already exists; refusing to mix evidence',
    );
  }

  const files = listCorpus(args.sourceDir);
  const installedRoot = historyRoot(args);
  for (const file of files) {
    const installed = join(installedRoot, file.relativePath);
    assertNoSymlinkPath(installedRoot, installed);
    if (!existsSync(installed) || !lstatSync(installed).isFile()) {
      throw new Error(
        `session-discovery-fixtures: installed history is missing or not regular: ${file.relativePath}`,
      );
    }
    if (sha256(installed) !== file.sha256) {
      throw new Error(
        `session-discovery-fixtures: installed history has changed bytes: ${file.relativePath}`,
      );
    }
  }

  copyCorpus(
    files.map((file) => ({
      ...file,
      absolutePath: join(installedRoot, file.relativePath),
    })),
    args.outputDir,
    args.workdir,
  );
  return publicManifest(files);
}
