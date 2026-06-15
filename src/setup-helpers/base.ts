// src/setup-helpers/base.ts (createBaseRepo + recordHead; provisionVenv added in Task 4)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '../agents/command-runner.ts';
import { runGit } from './git.ts';

function copyIfPresent(src: string, dest: string): void {
  if (existsSync(src)) {
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(src, dest);
  }
}

export function createBaseRepo(workdir: string, templateDir: string): void {
  if (existsSync(join(templateDir, '.git'))) {
    // Plain clone path (matches Python's subprocess git clone, no identity env).
    const proc = spawnSync('git', ['clone', templateDir, workdir], {
      encoding: 'utf8',
    });
    if (proc.status !== 0) {
      throw new Error(`git clone failed: ${proc.stderr ?? ''}`);
    }
    return;
  }
  mkdirSync(workdir, { recursive: true });
  runGit(['init', '-b', 'main'], workdir);
  runGit(['config', 'user.email', 'drill@test.local'], workdir);
  runGit(['config', 'user.name', 'Drill Test'], workdir);

  copyIfPresent(
    join(templateDir, 'package.json'),
    join(workdir, 'package.json'),
  );
  copyIfPresent(join(templateDir, 'README.md'), join(workdir, 'README.md'));
  runGit(['add', 'package.json', 'README.md'], workdir);
  runGit(['commit', '-m', 'initial commit'], workdir);

  copyIfPresent(
    join(templateDir, 'src', 'utils.js'),
    join(workdir, 'src', 'utils.js'),
  );
  runGit(['add', 'src/utils.js'], workdir);
  runGit(['commit', '-m', 'add utils module'], workdir);

  copyIfPresent(
    join(templateDir, 'src', 'index.js'),
    join(workdir, 'src', 'index.js'),
  );
  runGit(['add', 'src/index.js'], workdir);
  runGit(['commit', '-m', 'add entry point'], workdir);
}

export function recordHead(workdir: string): void {
  const gitDir = runGit(['rev-parse', '--absolute-git-dir'], workdir).trim();
  const head = runGit(['rev-parse', 'HEAD'], workdir).trim();
  writeFileSync(join(gitDir, 'quorum-recorded-head'), `${head}\n`, 'utf8');
}

interface ProvisionOpts {
  readonly uvAvailable?: boolean;
  readonly python?: string;
}

// A PATH lookup, NOT a subprocess. Using Bun.which (vs spawning `uv --version`
// through the seam) means no extra recorded call, so the behavior tests see
// `run.calls[0]` == the venv call.
function uvOnPath(): boolean {
  return Bun.which('uv') !== null;
}

function must(
  result: { status: number | null; stderr: string },
  label: string,
): void {
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} failed: ${result.stderr}`);
  }
}

// Python's no-uv branch builds the venv with `sys.executable` — a SPECIFIC,
// present interpreter resolved to an absolute path, version-consistent with the
// uv branch's `--python 3.12`. The TS harness runs under Bun, not Python, so
// there is no "running interpreter" to mirror; instead resolve the same kind of
// interpreter Python guarantees: an absolute path to a present python, preferring
// 3.12 (the uv-branch standard) then 3.x, rather than a bare PATH `python3` that
// may be a different interpreter or absent (which would defer an opaque ENOENT).
const PYTHON_CANDIDATES = ['python3.12', 'python3', 'python'] as const;

function resolvePython(): string {
  for (const candidate of PYTHON_CANDIDATES) {
    const resolved = Bun.which(candidate);
    if (resolved !== null) {
      return resolved;
    }
  }
  throw new Error(
    `no python interpreter found on PATH (tried ${PYTHON_CANDIDATES.join(', ')})`,
  );
}

// Creates <workdir>/.venv with pytest + the workdir package installed editable.
// Uses uv when available (fast), else stdlib venv + pip. Routed through
// CommandRunner for testability.
export function provisionVenv(
  workdir: string,
  run: CommandRunner,
  opts: ProvisionOpts = {},
): void {
  const venv = join(workdir, '.venv');
  const venvPython = join(venv, 'bin', 'python');
  const uvAvailable = opts.uvAvailable ?? uvOnPath();

  if (uvAvailable) {
    must(
      run.run('uv', ['venv', '--python', '3.12', venv], { cwd: workdir }),
      'uv venv',
    );
    must(
      run.run(
        'uv',
        ['pip', 'install', '--python', venvPython, 'pytest', '-e', '.'],
        { cwd: workdir },
      ),
      'uv pip install',
    );
    return;
  }
  const python = opts.python ?? resolvePython();
  must(
    run.run(python, ['-m', 'venv', venv], { cwd: workdir }),
    'python -m venv',
  );
  must(
    run.run(
      venvPython,
      ['-m', 'pip', 'install', '--quiet', 'pytest', '-e', '.'],
      { cwd: workdir },
    ),
    'pip install',
  );
}
