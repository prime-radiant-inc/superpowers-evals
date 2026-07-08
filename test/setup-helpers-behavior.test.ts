import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import {
  createClaimWithoutVerification,
  createCodeReviewPlantedBugs,
  createFinishingBranchWorktree,
  createPhantomCompletion,
  createReviewPushback,
  FINISHING_BRANCH_MARKER,
  FINISHING_BRANCH_NAME,
} from '../src/setup-helpers/behavior-fixtures.ts';
import { runGit } from '../src/setup-helpers/git.ts';

class FakeRunner implements CommandRunner {
  calls: string[] = [];
  run(command: string): CommandResult {
    this.calls.push(command);
    return { status: 0, stdout: '', stderr: '' };
  }
}
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-beh-'));
}
function ctx(dir: string, run: CommandRunner) {
  return {
    workdir: dir,
    templateDir: undefined,
    superpowersRoot: undefined,
    scenarioDir: undefined,
    run,
  };
}
function subjects(dir: string): string[] {
  return runGit(['log', '--format=%s', '--reverse'], dir).trim().split('\n');
}

describe('behavior fixtures', () => {
  test('claim_without_verification: 3 commits + provisionVenv invoked', () => {
    const dir = tmp();
    const run = new FakeRunner();
    try {
      createClaimWithoutVerification(ctx(dir, run));
      expect(subjects(dir)).toEqual([
        'initial project scaffolding',
        'add chunk_text utility',
        'add chunking tests',
      ]);
      expect(runGit(['show', 'HEAD:src/textkit/chunking.py'], dir)).toContain(
        'chunk_size - 1',
      );
      expect(run.calls.length).toBeGreaterThan(0); // venv provisioned via seam
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('code_review_planted_bugs: 2 commits, db.js rewritten with SQLi (no venv)', () => {
    const dir = tmp();
    const run = new FakeRunner();
    try {
      createCodeReviewPlantedBugs(ctx(dir, run));
      expect(subjects(dir)).toEqual([
        'initial: parameterized findUserByEmail',
        'refactor user lookup, add login',
      ]);
      // The verbatim DB_PLANTED SQLi concatenation is `'" + email + "'`
      // (the plan's draft assertion dropped the inner double-quotes; the
      // fixture content is the authoritative verbatim Python port).
      expect(runGit(['show', 'HEAD:src/db.js'], dir)).toContain(
        '\'" + email + "\'',
      );
      expect(run.calls.length).toBe(0); // no venv
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('phantom_completion: stub slugify + false COMPLETE plan', () => {
    const dir = tmp();
    try {
      createPhantomCompletion(ctx(dir, new FakeRunner()));
      expect(subjects(dir)).toEqual([
        'initial project scaffolding',
        'Task 1: slugify implementation',
      ]);
      expect(runGit(['show', 'HEAD:src/slugkit/slugify.py'], dir)).toContain(
        'return title',
      );
      expect(
        runGit(['show', 'HEAD:docs/plans/2026-06-08-slugify.md'], dir),
      ).toContain('COMPLETE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('review_pushback: off-by-one <= and time.monotonic both present', () => {
    const dir = tmp();
    try {
      createReviewPushback(ctx(dir, new FakeRunner()));
      expect(subjects(dir)).toEqual([
        'initial project scaffolding',
        'add sliding-window limiter',
      ]);
      const limiter = runGit(['show', 'HEAD:src/ratelimit/limiter.py'], dir);
      expect(limiter).toContain('<= self.limit');
      expect(limiter).toContain('time.monotonic()');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finishing_branch_worktree: superpowers-owned worktree with committed feature work + launch-cwd sentinel', () => {
    const dir = tmp();
    try {
      createFinishingBranchWorktree(ctx(dir, new FakeRunner()));

      // Main worktree is on `main`, still 2 commits (README, then the
      // gitignored .worktrees/ commit) — the feature commit lives only on
      // the feature branch's worktree.
      expect(runGit(['branch', '--show-current'], dir).trim()).toBe('main');
      expect(subjects(dir)).toEqual([
        'initial project scaffolding',
        'ignore .worktrees/',
      ]);

      // git worktree list: main + the feature worktree.
      const worktrees = runGit(['worktree', 'list'], dir)
        .trim()
        .split('\n')
        .filter((l) => l.length > 0);
      expect(worktrees.length).toBe(2);

      // The feature branch exists and carries the committed marker.
      expect(
        runGit(['rev-parse', '--verify', FINISHING_BRANCH_NAME], dir).trim()
          .length,
      ).toBe(40);
      const worktreePath = join(dir, '.worktrees', 'report-export');
      expect(
        runGit(['log', '-1', '--format=%s'], worktreePath).trim(),
      ).toContain(FINISHING_BRANCH_MARKER);
      expect(
        runGit(
          ['show', `${FINISHING_BRANCH_NAME}:src/reports/csv-export.js`],
          worktreePath,
        ),
      ).toContain('toCsv');

      // The launch-cwd sentinel points at the worktree's absolute path.
      const sentinel = Bun.file(join(dir, '.quorum-launch-cwd'));
      expect(sentinel.size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finishing_branch_worktree: launch-cwd sentinel resolves to the worktree', async () => {
    const dir = tmp();
    try {
      createFinishingBranchWorktree(ctx(dir, new FakeRunner()));
      const sentinelPath = (
        await Bun.file(join(dir, '.quorum-launch-cwd')).text()
      ).trim();
      expect(sentinelPath).toBe(join(dir, '.worktrees', 'report-export'));
      expect(runGit(['branch', '--show-current'], sentinelPath).trim()).toBe(
        FINISHING_BRANCH_NAME,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Python parity (L-helper-missing-workdir-mkdir): every behavior helper must
  // create $QUORUM_WORKDIR itself before `git init` when it does not yet exist.
  test('each behavior helper creates the workdir when it does not exist', () => {
    const base = tmp();
    try {
      const cases: Array<[string, (c: ReturnType<typeof ctx>) => void]> = [
        ['claim', createClaimWithoutVerification],
        ['planted', createCodeReviewPlantedBugs],
        ['phantom', createPhantomCompletion],
        ['pushback', createReviewPushback],
        ['finishing', createFinishingBranchWorktree],
      ];
      for (const [name, helper] of cases) {
        const missing = join(base, name, 'nested', 'workdir');
        helper(ctx(missing, new FakeRunner()));
        expect(runGit(['rev-parse', 'HEAD'], missing).trim().length).toBe(40);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
