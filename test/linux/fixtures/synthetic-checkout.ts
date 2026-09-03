import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const EXCLUDED_TOP_LEVEL_DIRECTORIES = new Set([
  '.worktrees',
  'node_modules',
  'results',
]);

const DEFAULT_UNTRACKED_PATHS = ['test/linux/fixtures/fake-coding-agent'];

export interface SyntheticCheckoutOptions {
  readonly scenarioName: string;
  readonly configure: (root: string) => void;
  readonly sourceRoot?: string;
  readonly untrackedPaths?: readonly string[];
}

export interface SyntheticCheckout {
  readonly root: string;
  readonly commit: string;
  readonly cleanup: () => void;
}

function checkedGit(
  root: string,
  args: readonly string[],
  options: { readonly allowFailure?: boolean } = {},
): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  if (result.error !== undefined) {
    throw new Error('synthetic checkout could not start git');
  }
  const stdout = result.stdout ?? '';
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error('synthetic checkout git command failed');
  }
  return stdout;
}

function copyEntry(source: string, destination: string): void {
  const stats = lstatSync(source);
  mkdirSync(dirname(destination), { recursive: true });
  if (stats.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination);
    return;
  }
  if (!stats.isFile()) {
    throw new Error(`synthetic checkout cannot copy ${source}`);
  }
  copyFileSync(source, destination);
  chmodSync(destination, stats.mode & 0o7777);
}

function shouldCopy(path: string): boolean {
  const topLevel = path.split('/')[0];
  return (
    topLevel !== undefined && !EXCLUDED_TOP_LEVEL_DIRECTORIES.has(topLevel)
  );
}

function copyRepositoryFiles(
  sourceRoot: string,
  destinationRoot: string,
  untrackedPaths: readonly string[],
): void {
  const tracked = checkedGit(sourceRoot, ['ls-files', '-z', '--cached'])
    .split('\0')
    .filter((path) => path !== '' && shouldCopy(path));
  const paths = new Set(tracked);
  for (const path of untrackedPaths) {
    if (!shouldCopy(path)) continue;
    const source = join(sourceRoot, path);
    if (!existsSync(source)) {
      throw new Error(`synthetic checkout fixture is missing: ${path}`);
    }
    paths.add(path);
  }
  for (const path of paths) {
    copyEntry(join(sourceRoot, path), join(destinationRoot, path));
  }

  const sourceNodeModules = join(sourceRoot, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    symlinkSync(sourceNodeModules, join(destinationRoot, 'node_modules'));
  }
}

function runQuorumCheck(root: string, scenarioName: string): void {
  const environment: Record<string, string> = {
    PATH: Bun.env['PATH'] ?? '',
    HOME: Bun.env['HOME'] ?? root,
    LANG: Bun.env['LANG'] ?? 'C',
    LC_ALL: Bun.env['LC_ALL'] ?? 'C',
  };
  const result = spawnSync(
    'bun',
    [
      'run',
      'quorum',
      'check',
      scenarioName,
      '--update-manifests',
      '--credentials-file',
      join(root, 'credentials.yaml'),
    ],
    {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      maxBuffer: Number.POSITIVE_INFINITY,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const diagnostics = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new Error(
      diagnostics === ''
        ? 'synthetic checkout quorum check failed'
        : `synthetic checkout quorum check failed: ${diagnostics}`,
    );
  }
}

function initializeCommit(root: string, scenarioName: string): string {
  const init = spawnSync('git', ['init', '--quiet', root], {
    encoding: 'utf8',
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  if (init.error !== undefined || init.status !== 0) {
    throw new Error('synthetic checkout could not initialize git');
  }
  const configure = (args: readonly string[]): void => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: Number.POSITIVE_INFINITY,
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error('synthetic checkout git configuration failed');
    }
  };
  configure(['config', 'user.name', 'quorum synthetic fixture']);
  configure(['config', 'user.email', 'quorum-synthetic@example.invalid']);
  configure(['add', '--', '.']);
  configure([
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    `test fixture: ${scenarioName}`,
  ]);
  const status = checkedGit(root, ['status', '--porcelain']);
  if (status !== '') {
    throw new Error('synthetic checkout is not clean after its fixture commit');
  }
  const commit = checkedGit(root, ['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('synthetic checkout did not produce a commit');
  }
  return commit;
}

export function createSyntheticCheckout(
  options: SyntheticCheckoutOptions,
): SyntheticCheckout {
  const sourceRoot = resolve(
    options.sourceRoot ?? resolve(import.meta.dir, '../../..'),
  );
  const root = mkdtempSync(join(tmpdir(), 'quorum-synthetic-'));
  let cleaned = false;
  try {
    copyRepositoryFiles(
      sourceRoot,
      root,
      options.untrackedPaths ?? DEFAULT_UNTRACKED_PATHS,
    );
    options.configure(root);
    runQuorumCheck(root, options.scenarioName);
    const commit = initializeCommit(root, options.scenarioName);
    return {
      root,
      commit,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (!cleaned) {
      cleaned = true;
      rmSync(root, { recursive: true, force: true });
    }
    throw error;
  }
}
