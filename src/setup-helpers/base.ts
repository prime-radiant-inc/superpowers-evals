// src/setup-helpers/base.ts (createBaseRepo + recordHead; provisionVenv added in Task 4)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
