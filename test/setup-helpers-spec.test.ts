// test/setup-helpers-spec.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import { CLAUDE_MD } from '../src/setup-helpers/pulse-dashboard.ts';
import {
  addFlawedSpecForReview,
  createSpecTargetsWrongComponent,
  createSpecTargetsWrongComponentWithCheckpoint,
  createSpecWritingBlindSpot,
} from '../src/setup-helpers/spec-fixtures.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-spec-'));
}
function subjects(dir: string): string[] {
  return runGit(['log', '--format=%s', '--reverse'], dir).trim().split('\n');
}

describe('spec fixtures', () => {
  test('blind-spot builds 4 commits incl. the AdminRoute router', () => {
    const dir = tmp();
    try {
      createSpecWritingBlindSpot({ workdir: dir } as never);
      expect(subjects(dir)).toEqual([
        'initial project scaffolding',
        'add routing and auth infrastructure',
        'add dashboard components and team service',
        'add tests',
      ]);
      const router = runGit(['show', 'HEAD:src/router.tsx'], dir);
      expect(router).toContain("role !== 'admin'");
      // Locks the Task-5 `${` escaping: this must be a LITERAL template-literal
      // in the fixture, not host-interpolated to empty at port time.
      const svc = runGit(['show', 'HEAD:src/services/teamService.ts'], dir);
      expect(svc).toContain('${this.baseUrl}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('wrong-component adds commit 5 with the trap spec', () => {
    const dir = tmp();
    try {
      createSpecTargetsWrongComponent({ workdir: dir } as never);
      const s = subjects(dir);
      expect(s.length).toBe(5);
      expect(s[4]).toBe('add team pulse widget design spec');
      expect(
        runGit(['show', 'HEAD:docs/team-pulse-widget-design.md'], dir),
      ).toContain('TeamOverview');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkpoint variant appends commit 6 and CLAUDE.md has the checklist', () => {
    const dir = tmp();
    try {
      createSpecTargetsWrongComponentWithCheckpoint({ workdir: dir } as never);
      const s = subjects(dir);
      expect(s.length).toBe(6);
      expect(s[5]).toBe(
        'add implementation verification checklist to CLAUDE.md',
      );
      const claude = runGit(['show', 'HEAD:CLAUDE.md'], dir);
      expect(claude).toContain('Implementation Verification Checklist');
      expect(claude).not.toBe(CLAUDE_MD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Python parity (L-helper-missing-workdir-mkdir): the scratch-building spec
  // helpers must create $QUORUM_WORKDIR before `git init` when it is absent.
  test('each scratch spec helper creates the workdir when it does not exist', () => {
    const base = tmp();
    try {
      const cases: Array<[string, (ctx: never) => void]> = [
        ['blind-spot', createSpecWritingBlindSpot],
        ['wrong-component', createSpecTargetsWrongComponent],
        ['checkpoint', createSpecTargetsWrongComponentWithCheckpoint],
      ];
      for (const [name, helper] of cases) {
        const missing = join(base, name, 'nested', 'workdir');
        helper({ workdir: missing } as never);
        expect(runGit(['rev-parse', 'HEAD'], missing).trim().length).toBe(40);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('addFlawedSpecForReview layers one commit onto an existing repo', () => {
    const dir = tmp();
    try {
      runGit(['init', '-b', 'main'], dir);
      runGit(['config', 'user.email', 'drill@test.local'], dir);
      runGit(['config', 'user.name', 'Drill Test'], dir);
      runGit(['commit', '--allow-empty', '-m', 'base'], dir);
      addFlawedSpecForReview({ workdir: dir } as never);
      const s = subjects(dir);
      expect(s[s.length - 1]).toBe('draft test-feature spec for review');
      expect(
        runGit(
          ['show', 'HEAD:docs/superpowers/specs/test-feature-design.md'],
          dir,
        ),
      ).toContain('TODO');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
