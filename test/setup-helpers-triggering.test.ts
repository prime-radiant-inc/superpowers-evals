import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import {
  addAuthExecutionPlan,
  createWritingPlansSkeleton,
} from '../src/setup-helpers/triggering-fixtures.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-trig-'));
}

describe('triggering fixtures', () => {
  test('createWritingPlansSkeleton: self-contained express repo', () => {
    const dir = tmp();
    try {
      createWritingPlansSkeleton({ workdir: dir } as never);
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: express app with in-memory user store',
      );
      const tracked = runGit(['ls-tree', '-r', '--name-only', 'HEAD'], dir)
        .trim()
        .split('\n')
        .sort();
      expect(tracked).toEqual(['app.js', 'package.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Python parity (L-helper-missing-workdir-mkdir): the scratch-building
  // skeleton helper must create $QUORUM_WORKDIR before `git init` when absent.
  test('createWritingPlansSkeleton creates the workdir when it does not exist', () => {
    const base = tmp();
    try {
      const missing = join(base, 'nested', 'workdir');
      createWritingPlansSkeleton({ workdir: missing } as never);
      expect(runGit(['rev-parse', 'HEAD'], missing).trim().length).toBe(40);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('addAuthExecutionPlan: layers a concrete plan commit onto an existing repo', () => {
    const dir = tmp();
    try {
      runGit(['init', '-b', 'main'], dir);
      runGit(['config', 'user.email', 'drill@test.local'], dir);
      runGit(['config', 'user.name', 'Drill Test'], dir);
      runGit(['commit', '--allow-empty', '-m', 'base'], dir);
      addAuthExecutionPlan({ workdir: dir } as never);
      expect(runGit(['log', '-1', '--format=%s'], dir).trim()).toBe(
        'add auth execution plan',
      );
      const plan = runGit(
        ['show', 'HEAD:docs/superpowers/plans/2024-01-15-auth-system.md'],
        dir,
      );
      expect(plan).toContain('src/authToken.js');
      expect(plan).toContain('test/authToken.test.js');
      expect(plan).toContain('npm test');
      expect(plan).not.toMatch(/\b(stub|placeholder|no-op)\b/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
