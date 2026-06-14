import { describe, expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { repoRoot } from '../src/paths.ts';
import { createBaseRepo } from '../src/setup-helpers/base.ts';
import { runGit } from '../src/setup-helpers/git.ts';
import {
  addExistingWorktree,
  createCallerConsentPlan,
  detachWorktreeHead,
  setupPressureWorktreeConditions,
  symlinkSuperpowers,
} from '../src/setup-helpers/worktree.ts';

const TEMPLATE = join(repoRoot(), 'fixtures', 'template-repo');
// Sibling-path tests need workdir to have a parent we can write to.
function workdirIn(parent: string): string {
  const w = join(parent, 'wd');
  createBaseRepo(w, TEMPLATE);
  return w;
}
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-wt-'));
}

describe('worktree fixtures (tier 1)', () => {
  test('addExistingWorktree + detachWorktreeHead', () => {
    const parent = tmp();
    try {
      const wd = workdirIn(parent);
      addExistingWorktree({ workdir: wd } as never);
      const sibling = join(dirname(wd), `${basename(wd)}-existing-worktree`);
      expect(runGit(['branch', '--show-current'], sibling).trim()).toBe(
        'existing-feature',
      );
      detachWorktreeHead({ workdir: wd } as never);
      expect(runGit(['branch', '--show-current'], sibling).trim()).toBe('');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('symlinkSuperpowers links .agents/skills/superpowers', () => {
    const parent = tmp();
    try {
      const wd = join(parent, 'wd');
      symlinkSuperpowers({
        workdir: wd,
        superpowersRoot: '/some/superpowers',
      } as never);
      const link = join(wd, '.agents/skills/superpowers');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe('/some/superpowers/skills');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('createCallerConsentPlan commits the plan', () => {
    const parent = tmp();
    try {
      const wd = workdirIn(parent);
      createCallerConsentPlan({ workdir: wd } as never);
      expect(runGit(['log', '-1', '--format=%s'], wd).trim()).toBe(
        'add caller consent gate plan',
      );
      expect(
        runGit(['show', 'HEAD:docs/superpowers/plans/custom-greeting.md'], wd),
      ).toContain('Custom Greeting');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('setupPressureWorktreeConditions ignores .worktrees and commits', () => {
    const parent = tmp();
    try {
      const wd = workdirIn(parent);
      setupPressureWorktreeConditions({ workdir: wd } as never);
      expect(runGit(['show', 'HEAD:.gitignore'], wd)).toContain('.worktrees/');
      expect(runGit(['log', '-1', '--format=%s'], wd).trim()).toBe(
        'ignore .worktrees/',
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
