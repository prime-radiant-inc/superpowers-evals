import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const FULL_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DEVELOPMENT_PATHS = ['docs', 'tests'] as const;
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'Quorum Runtime Packager',
  GIT_AUTHOR_EMAIL: 'quorum-runtime-package@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Quorum Runtime Packager',
  GIT_COMMITTER_EMAIL: 'quorum-runtime-package@example.invalid',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

export interface PackageFile {
  path: string;
  sha256: string;
}

export interface PackageReceipt {
  source_sha: string;
  runtime_sha: string;
  files: PackageFile[];
}

export interface RuntimePackageRequest {
  sourceCheckout: string;
  sourceSha: string;
  outputDir: string;
  importCheckout: string;
  retainRef: string;
}

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function command(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function resolvedCommit(checkout: string, sourceSha: string): string {
  if (!FULL_SHA_RE.test(sourceSha)) {
    throw new Error(
      `source SHA must be a full hexadecimal commit id: ${sourceSha}`,
    );
  }
  const resolved = command(
    'git',
    ['rev-parse', '--verify', `${sourceSha}^{commit}`],
    { cwd: checkout },
  );
  if (resolved !== sourceSha) {
    throw new Error(`source SHA resolved to a different commit: ${resolved}`);
  }
  return resolved;
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

function validateSymlink(
  packageRoot: string,
  canonicalRoot: string,
  path: string,
): void {
  const target = readlinkSync(path);
  if (isAbsolute(target)) {
    throw new Error(
      `escaping symlink: ${relative(packageRoot, path)} -> ${target}`,
    );
  }
  const lexicalTarget = resolve(dirname(path), target);
  if (!isWithin(packageRoot, lexicalTarget)) {
    throw new Error(
      `escaping symlink: ${relative(packageRoot, path)} -> ${target}`,
    );
  }
  let actualTarget: string;
  try {
    actualTarget = realpathSync(path);
  } catch {
    throw new Error(
      `unresolved symlink: ${relative(packageRoot, path)} -> ${target}`,
    );
  }
  if (!isWithin(canonicalRoot, actualTarget)) {
    throw new Error(
      `escaping symlink: ${relative(packageRoot, path)} -> ${target}`,
    );
  }
}

function inventory(packageRoot: string): PackageFile[] {
  const files: PackageFile[] = [];
  const canonicalRoot = realpathSync(packageRoot);
  const visit = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        validateSymlink(packageRoot, canonicalRoot, path);
      } else if (stats.isDirectory()) {
        visit(path);
      } else if (stats.isFile()) {
        files.push({
          path: relative(packageRoot, path),
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        });
      } else {
        throw new Error(
          `unsupported package entry: ${relative(packageRoot, path)}`,
        );
      }
    }
  };
  visit(packageRoot);
  return files.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

function createRootCommit(packageRoot: string, scratchRoot: string): {
  repo: string;
  sha: string;
} {
  const repo = join(scratchRoot, 'runtime-repo');
  mkdirSync(repo);
  cpSync(packageRoot, repo, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  command('git', ['init', '-q'], { cwd: repo });
  command('git', ['symbolic-ref', 'HEAD', 'refs/heads/runtime-package'], {
    cwd: repo,
  });
  command('git', ['add', '-A'], { cwd: repo });
  command('git', ['commit', '-q', '--no-gpg-sign', '-m', 'Runtime package'], {
    cwd: repo,
    env: { ...process.env, ...COMMIT_ENV },
  });
  return { repo, sha: command('git', ['rev-parse', 'HEAD'], { cwd: repo }) };
}

function validateRetainRef(checkout: string, retainRef: string): void {
  if (!retainRef.startsWith('refs/')) {
    throw new Error(`retained ref must start with refs/: ${retainRef}`);
  }
  command('git', ['check-ref-format', retainRef], { cwd: checkout });
}

/** Build an immutable package tree and retain its parentless commit in the
 * configured Superpowers object database. The receipt is deliberately adjacent
 * to, rather than inside, the package tree. */
export function buildRuntimePackage(
  request: RuntimePackageRequest,
): PackageReceipt {
  const sourceCheckout = realpathSync(request.sourceCheckout);
  const importCheckout = realpathSync(request.importCheckout);
  const outputDir = resolve(request.outputDir);
  if (existsSync(outputDir)) {
    throw new Error(`refusing to replace existing package output: ${outputDir}`);
  }
  validateRetainRef(importCheckout, request.retainRef);
  const sourceSha = resolvedCommit(sourceCheckout, request.sourceSha);
  const scratchRoot = mkdtempSync(join(tmpdir(), 'pr2236-package-'));
  try {
    const archivePath = join(scratchRoot, 'source.tar');
    const packageRoot = join(scratchRoot, 'package');
    mkdirSync(packageRoot);
    command(
      'git',
      ['archive', '--format=tar', `--output=${archivePath}`, sourceSha],
      { cwd: sourceCheckout },
    );
    command('tar', ['-xf', archivePath, '-C', packageRoot]);
    for (const path of DEVELOPMENT_PATHS) {
      rmSync(join(packageRoot, path), { recursive: true, force: true });
    }
    const files = inventory(packageRoot);
    const runtime = createRootCommit(packageRoot, scratchRoot);

    command(
      'git',
      ['fetch', '--quiet', '--no-tags', runtime.repo, 'refs/heads/runtime-package'],
      { cwd: importCheckout },
    );
    command('git', ['update-ref', request.retainRef, runtime.sha], {
      cwd: importCheckout,
    });

    const receipt: PackageReceipt = {
      source_sha: sourceSha,
      runtime_sha: runtime.sha,
      files,
    };
    mkdirSync(dirname(outputDir), { recursive: true });
    const publishDir = mkdtempSync(
      join(dirname(outputDir), `.${basename(outputDir)}-staging-`),
    );
    try {
      cpSync(packageRoot, join(publishDir, 'package'), {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      writeFileSync(
        join(publishDir, 'receipt.json'),
        `${JSON.stringify(receipt, null, 2)}\n`,
        { mode: 0o600 },
      );
      renameSync(publishDir, outputDir);
    } catch (error) {
      rmSync(publishDir, { recursive: true, force: true });
      throw error;
    }
    return receipt;
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

interface CliOptions {
  sourceCheckout: string;
  importCheckout: string;
  controlSha: string;
  treatmentSha: string;
  outputRoot: string;
}

function usage(): string {
  return (
    'usage: bun scripts/experiments/pr2236-package.ts ' +
    '--source-checkout <path> [--import-checkout <path>] ' +
    '--control <sha> --treatment <sha> --out <path>\n'
  );
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith('--')) {
      throw new Error(usage().trim());
    }
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    values.set(flag, value);
  }
  const sourceCheckout = values.get('--source-checkout');
  const controlSha = values.get('--control');
  const treatmentSha = values.get('--treatment');
  const outputRoot = values.get('--out');
  const known = new Set([
    '--source-checkout',
    '--import-checkout',
    '--control',
    '--treatment',
    '--out',
  ]);
  const unknown = [...values.keys()].find((flag) => !known.has(flag));
  if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`);
  if (
    sourceCheckout === undefined ||
    controlSha === undefined ||
    treatmentSha === undefined ||
    outputRoot === undefined
  ) {
    throw new Error(usage().trim());
  }
  return {
    sourceCheckout,
    importCheckout: values.get('--import-checkout') ?? sourceCheckout,
    controlSha,
    treatmentSha,
    outputRoot,
  };
}

export function main(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage());
    return 0;
  }
  try {
    const options = parseArgs(argv);
    const outputRoot = resolve(options.outputRoot);
    if (existsSync(outputRoot)) {
      throw new Error(
        `refusing to replace existing package output root: ${outputRoot}`,
      );
    }
    const control = buildRuntimePackage({
      sourceCheckout: options.sourceCheckout,
      sourceSha: options.controlSha,
      outputDir: join(outputRoot, 'control'),
      importCheckout: options.importCheckout,
      retainRef: 'refs/pr2236-session-discovery/control-runtime',
    });
    const treatment = buildRuntimePackage({
      sourceCheckout: options.sourceCheckout,
      sourceSha: options.treatmentSha,
      outputDir: join(outputRoot, 'treatment'),
      importCheckout: options.importCheckout,
      retainRef: 'refs/pr2236-session-discovery/treatment-runtime',
    });
    process.stdout.write(`${JSON.stringify({ control, treatment }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
