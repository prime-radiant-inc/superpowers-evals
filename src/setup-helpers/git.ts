// src/setup-helpers/git.ts
import { spawnSync } from 'node:child_process';
import { envSnapshot } from '../env.ts';

// Port of setup_helpers/base.py:_git. Runs `git <args>` in cwd with the
// fixed Drill Test identity injected, so commits are deterministic in
// author/committer regardless of host git config. Python spreads
// {defaults, **os.environ} — os.environ WINS — so spread the real env LAST.
// Throws on nonzero exit (Python check=True); returns decoded stdout.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Drill Test',
  GIT_AUTHOR_EMAIL: 'drill@test.local',
  GIT_COMMITTER_NAME: 'Drill Test',
  GIT_COMMITTER_EMAIL: 'drill@test.local',
};

export function runGit(args: readonly string[], cwd: string): string {
  const proc = spawnSync('git', [...args], {
    cwd,
    env: { ...IDENTITY, ...envSnapshot() },
    encoding: 'utf8',
  });
  if (proc.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${proc.status})\n${proc.stderr ?? ''}`,
    );
  }
  return proc.stdout ?? '';
}

// Non-throwing variant for the one git call Python runs unchecked:
// detach_head's final `git branch -D` (a stale branch is acceptable). Returns
// the exit status so the caller doesn't need an empty catch (banned by the
// coding standard).
export function runGitAllowFail(args: readonly string[], cwd: string): number {
  const proc = spawnSync('git', [...args], {
    cwd,
    env: { ...IDENTITY, ...envSnapshot() },
    encoding: 'utf8',
  });
  return proc.status ?? 1;
}
