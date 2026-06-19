import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpawnCommandRunner } from '../src/agents/command-runner.ts';
import {
  ApplianceError,
  type ApplianceErrorCode,
} from '../src/appliance/errors.ts';
import {
  checkoutDetached,
  ensureCleanWorktree,
  fastForwardManagedRepo,
  fetchRepo,
  resolveSuperpowersRef,
} from '../src/appliance/git.ts';

const runner = new SpawnCommandRunner();

function git(cwd: string, args: string[]): string {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (proc.status !== 0) throw new Error(proc.stderr);
  return proc.stdout.trim();
}

function gitStatus(cwd: string, args: string[]): number | null {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status;
}

function expectApplianceCode(fn: () => void, code: ApplianceErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApplianceError);
    expect((error as ApplianceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ApplianceError ${code}`);
}

function repo(): { root: string; bare: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'appliance-git-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, ['init', '--bare', bare]);
  git(root, ['clone', bare, work]);
  git(work, ['config', 'user.email', 'drill@test.local']);
  git(work, ['config', 'user.name', 'Drill Test']);
  writeFileSync(join(work, 'README.md'), 'one\n');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-m', 'initial']);
  git(work, ['push', 'origin', 'HEAD:main']);
  git(work, ['checkout', '-B', 'main', 'origin/main']);
  return { root, bare, work };
}

function cloneWithIdentity(bare: string): string {
  const other = join(
    mkdtempSync(join(tmpdir(), 'appliance-git-other-')),
    'other',
  );
  git(join(other, '..'), ['clone', bare, other]);
  git(other, ['config', 'user.email', 'drill@test.local']);
  git(other, ['config', 'user.name', 'Drill Test']);
  git(other, ['checkout', '-B', 'main', 'origin/main']);
  return other;
}

describe('appliance git helpers', () => {
  test('ensureCleanWorktree rejects dirty files', () => {
    const { work } = repo();
    writeFileSync(join(work, 'dirty.txt'), 'dirty\n');
    expectApplianceCode(() => ensureCleanWorktree(work, runner), 'repo_dirty');
  });

  test('fetchRepo prunes stale branches and fetches tags', () => {
    const { bare, work } = repo();
    const other = cloneWithIdentity(bare);
    git(other, ['checkout', '-B', 'stale']);
    writeFileSync(join(other, 'STALE.md'), 'stale\n');
    git(other, ['add', 'STALE.md']);
    git(other, ['commit', '-m', 'stale']);
    git(other, ['push', 'origin', 'HEAD:stale']);
    git(work, ['fetch', 'origin']);
    expect(
      git(work, ['rev-parse', '--verify', 'refs/remotes/origin/stale']),
    ).toMatch(/^[0-9a-f]{40}$/);

    git(other, ['checkout', 'main']);
    git(other, ['tag', 'v1']);
    git(other, ['push', 'origin', 'v1']);
    git(other, ['push', 'origin', '--delete', 'stale']);

    fetchRepo(work, 'origin', runner);

    expect(() =>
      git(work, ['rev-parse', '--verify', 'refs/remotes/origin/stale']),
    ).toThrow();
    expect(git(work, ['rev-parse', '--verify', 'refs/tags/v1'])).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  test('fastForwardManagedRepo moves configured branch by ff-only', () => {
    const { bare, work } = repo();
    const other = cloneWithIdentity(bare);
    writeFileSync(join(other, 'README.md'), 'two\n');
    git(other, ['commit', '-am', 'second']);
    git(other, ['push', 'origin', 'HEAD:main']);
    fetchRepo(work, 'origin', runner);

    const sha = fastForwardManagedRepo(
      { path: work, remote: 'origin', ref: 'main', label: 'evals' },
      runner,
    );
    expect(sha).toBe(git(work, ['rev-parse', 'HEAD']));
    expect(git(work, ['status', '--porcelain'])).toBe('');
  });

  test('resolveSuperpowersRef resolves branches, tags, and full commit shas', () => {
    const { bare, work } = repo();
    const mainSha = git(work, ['rev-parse', 'HEAD']);
    git(work, ['tag', 'release']);
    git(work, ['push', 'origin', 'release']);
    const other = cloneWithIdentity(bare);
    git(other, ['checkout', '-B', 'feature']);
    writeFileSync(join(other, 'FEATURE.md'), 'feature\n');
    git(other, ['add', 'FEATURE.md']);
    git(other, ['commit', '-m', 'feature']);
    git(other, ['push', 'origin', 'HEAD:feature']);
    fetchRepo(work, 'origin', runner);

    const featureSha = git(work, [
      'rev-parse',
      '--verify',
      'refs/remotes/origin/feature',
    ]);

    expect(
      resolveSuperpowersRef(
        { path: work, remote: 'origin' },
        'feature',
        runner,
      ),
    ).toBe(featureSha);
    expect(
      resolveSuperpowersRef(
        { path: work, remote: 'origin' },
        'release',
        runner,
      ),
    ).toBe(mainSha);
    expect(
      resolveSuperpowersRef({ path: work, remote: 'origin' }, mainSha, runner),
    ).toBe(mainSha);
  });

  test('resolveSuperpowersRef peels annotated tags to commit shas', () => {
    const { work } = repo();
    const mainSha = git(work, ['rev-parse', 'HEAD']);
    git(work, ['tag', '-a', 'annotated-release', '-m', 'annotated release']);
    const tagObjectSha = git(work, [
      'rev-parse',
      '--verify',
      'refs/tags/annotated-release',
    ]);
    expect(tagObjectSha).not.toBe(mainSha);

    expect(
      resolveSuperpowersRef(
        { path: work, remote: 'origin' },
        'annotated-release',
        runner,
      ),
    ).toBe(mainSha);
  });

  test('resolveSuperpowersRef fails closed on branch tag ambiguity', () => {
    const { work } = repo();
    git(work, ['tag', 'same']);
    git(work, ['push', 'origin', 'refs/tags/same:refs/tags/same']);
    git(work, ['checkout', '-B', 'same']);
    git(work, ['push', 'origin', 'refs/heads/same:refs/heads/same']);
    fetchRepo(work, 'origin', runner);
    expectApplianceCode(
      () =>
        resolveSuperpowersRef({ path: work, remote: 'origin' }, 'same', runner),
      'ref_ambiguous',
    );
  });

  test('resolveSuperpowersRef fails closed for missing refs', () => {
    const { work } = repo();
    expectApplianceCode(
      () =>
        resolveSuperpowersRef(
          { path: work, remote: 'origin' },
          'missing',
          runner,
        ),
      'ref_not_found',
    );
  });

  test('checkoutDetached leaves the repo detached at the requested sha', () => {
    const { work } = repo();
    const sha = git(work, ['rev-parse', 'HEAD']);

    checkoutDetached(work, sha, runner);

    expect(git(work, ['rev-parse', 'HEAD'])).toBe(sha);
    expect(gitStatus(work, ['symbolic-ref', '-q', 'HEAD'])).toBe(1);
  });
});
