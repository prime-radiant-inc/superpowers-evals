import type { CommandResult, CommandRunner } from '../agents/command-runner.ts';
import { ApplianceError, type ApplianceErrorCode } from './errors.ts';

interface ManagedRepo {
  readonly path: string;
  readonly remote: string;
  readonly ref: string;
  readonly label: string;
}

interface RefRepo {
  readonly path: string;
  readonly remote: string;
}

interface RefCandidate {
  readonly kind: 'branch' | 'tag' | 'sha';
  readonly sha: string;
}

function resultSummary(result: CommandResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return [
    `status=${result.status ?? 'null'}`,
    `stdout=${stdout === '' ? '<empty>' : stdout}`,
    `stderr=${stderr === '' ? '<empty>' : stderr}`,
  ].join(' ');
}

function git(repoPath: string, args: readonly string[], runner: CommandRunner) {
  return runner.run('git', ['-C', repoPath, ...args]);
}

function throwGitError(
  code: ApplianceErrorCode,
  action: string,
  result: CommandResult,
): never {
  throw new ApplianceError(code, 'git', `${action}: ${resultSummary(result)}`);
}

function requireGit(
  repoPath: string,
  args: readonly string[],
  runner: CommandRunner,
  code: ApplianceErrorCode,
  action: string,
): CommandResult {
  const result = git(repoPath, args, runner);
  if (result.status !== 0) {
    throwGitError(code, action, result);
  }
  return result;
}

function maybeRevParse(
  repoPath: string,
  ref: string,
  runner: CommandRunner,
): string | null {
  const result = git(repoPath, ['rev-parse', '--verify', ref], runner);
  if (result.status !== 0) {
    return null;
  }
  const sha = result.stdout.trim();
  return sha === '' ? null : sha;
}

function isFullSha(ref: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(ref);
}

export function ensureCleanWorktree(path: string, runner: CommandRunner): void {
  const result = requireGit(
    path,
    ['status', '--porcelain'],
    runner,
    'checkout_failed',
    `failed to inspect worktree ${path}`,
  );
  const status = result.stdout.trim();
  if (status !== '') {
    throw new ApplianceError(
      'repo_dirty',
      'git',
      `dirty worktree at ${path}: ${status}`,
    );
  }
}

export function fetchRepo(
  path: string,
  remote: string,
  runner: CommandRunner,
): void {
  requireGit(
    path,
    ['fetch', '--prune', '--tags', remote],
    runner,
    'fetch_failed',
    `failed to fetch ${remote} in ${path}`,
  );
}

export function fastForwardManagedRepo(
  repo: ManagedRepo,
  runner: CommandRunner,
): string {
  requireGit(
    repo.path,
    ['checkout', repo.ref],
    runner,
    'checkout_failed',
    `failed to checkout ${repo.label} ref ${repo.ref}`,
  );
  requireGit(
    repo.path,
    ['merge', '--ff-only', `${repo.remote}/${repo.ref}`],
    runner,
    'fetch_failed',
    `failed to fast-forward ${repo.label} from ${repo.remote}/${repo.ref}`,
  );
  return requireGit(
    repo.path,
    ['rev-parse', 'HEAD'],
    runner,
    'checkout_failed',
    `failed to resolve ${repo.label} HEAD`,
  ).stdout.trim();
}

export function resolveSuperpowersRef(
  repo: RefRepo,
  requestedRef: string,
  runner: CommandRunner,
): string {
  const candidates: RefCandidate[] = [];
  const branchSha = maybeRevParse(
    repo.path,
    `refs/remotes/${repo.remote}/${requestedRef}`,
    runner,
  );
  if (branchSha !== null) {
    candidates.push({ kind: 'branch', sha: branchSha });
  }

  const tagSha = maybeRevParse(repo.path, `refs/tags/${requestedRef}`, runner);
  if (tagSha !== null) {
    candidates.push({ kind: 'tag', sha: tagSha });
  }

  if (isFullSha(requestedRef)) {
    const result = git(
      repo.path,
      ['cat-file', '-e', `${requestedRef}^{commit}`],
      runner,
    );
    if (result.status === 0) {
      candidates.push({ kind: 'sha', sha: requestedRef.toLowerCase() });
    }
  }

  if (candidates.length > 1) {
    throw new ApplianceError(
      'ref_ambiguous',
      'git',
      `${requestedRef} is ambiguous in ${repo.path}: ${candidates
        .map((candidate) => candidate.kind)
        .join(', ')}`,
    );
  }
  if (candidates.length === 0) {
    throw new ApplianceError(
      'ref_not_found',
      'git',
      `${requestedRef} not found in ${repo.path}`,
    );
  }
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new ApplianceError(
      'ref_not_found',
      'git',
      `${requestedRef} not found in ${repo.path}`,
    );
  }
  return candidate.sha;
}

export function checkoutDetached(
  repoPath: string,
  sha: string,
  runner: CommandRunner,
): void {
  requireGit(
    repoPath,
    ['checkout', '--detach', sha],
    runner,
    'checkout_failed',
    `failed to checkout detached ${sha}`,
  );
  const head = requireGit(
    repoPath,
    ['rev-parse', 'HEAD'],
    runner,
    'checkout_failed',
    `failed to verify detached checkout ${sha}`,
  ).stdout.trim();
  if (head.toLowerCase() !== sha.toLowerCase()) {
    throw new ApplianceError(
      'checkout_failed',
      'git',
      `detached checkout mismatch in ${repoPath}: expected ${sha}, got ${head}`,
    );
  }
}
