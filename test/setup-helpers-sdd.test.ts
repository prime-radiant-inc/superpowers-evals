// test/setup-helpers-sdd.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import {
  addSddAuthPlan,
  STALE_LEDGER_BLOB,
  scaffoldSddBrokenPlan,
  scaffoldSddQualityDefectPlan,
  scaffoldSddSpecConstraintPlan,
  scaffoldSddStaleForeignWorkspace,
  scaffoldSddYagniPlan,
} from '../src/setup-helpers/sdd-fixtures.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-sdd-'));
}

describe('sdd fixtures', () => {
  test('scaffoldSddBrokenPlan keeps the literal backslash-n in the plan', () => {
    const dir = tmp();
    try {
      scaffoldSddBrokenPlan({ workdir: dir } as never);
      const plan = runGit(
        ['show', 'HEAD:docs/superpowers/plans/report-plan.md'],
        dir,
      );
      // The plan embeds `lines.join("\n")` as LITERAL backslash-n, not a newline.
      expect(plan).toContain('lines.join("\\n")');
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: report formatter plan',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scaffoldSddYagniPlan uses math-plan.md + its own commit message', () => {
    const dir = tmp();
    try {
      scaffoldSddYagniPlan({ workdir: dir } as never);
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: math YAGNI plan',
      );
      expect(
        runGit(['show', 'HEAD:docs/superpowers/plans/math-plan.md'], dir),
      ).toContain('DO NOT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scaffoldSddQualityDefectPlan: report-quality pkg + literal backslash-n', () => {
    const dir = tmp();
    try {
      scaffoldSddQualityDefectPlan({ workdir: dir } as never);
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: report formatter plan',
      );
      expect(runGit(['show', 'HEAD:package.json'], dir)).toContain(
        '"report-quality"',
      );
      const plan = runGit(
        ['show', 'HEAD:docs/superpowers/plans/report-plan.md'],
        dir,
      );
      expect(plan).toContain('lines.join("\\n")'); // literal backslash-n, not a newline
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Mirrors tests/test_sdd_neutral_setup_helper.py: the plan cites the spec by
  // path (the "quartz" marker lives only in the spec), and the repo lands on a
  // clean `main` with no implementation present.
  test('scaffoldSddSpecConstraintPlan: plan cites spec, quartz only in spec, clean main', () => {
    const dir = tmp();
    try {
      scaffoldSddSpecConstraintPlan({ workdir: dir } as never);

      const specRel = 'docs/superpowers/specs/2026-06-12-priority-design.md';
      const planRel = 'docs/superpowers/plans/2026-06-12-priority.md';
      expect(existsSync(join(dir, specRel))).toBe(true);
      expect(existsSync(join(dir, planRel))).toBe(true);

      const spec = runGit(['show', `HEAD:${specRel}`], dir);
      const plan = runGit(['show', `HEAD:${planRel}`], dir);
      expect(spec).toContain('quartz');
      expect(plan).toContain(specRel);
      expect(plan).not.toContain('quartz');

      expect(runGit(['branch', '--show-current'], dir).trim()).toBe('main');
      expect(runGit(['status', '--short'], dir).trim()).toBe('');
      expect(existsSync(join(dir, 'src', 'priority.js'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Python parity (L-helper-missing-workdir-mkdir): the scratch-building sdd
  // helpers (fixture-reading scaffold + embedded-body) must create
  // $QUORUM_WORKDIR before `git init` when it is absent.
  test('each scratch sdd helper creates the workdir when it does not exist', () => {
    const base = tmp();
    try {
      const cases: Array<[string, (ctx: never) => void]> = [
        ['broken', scaffoldSddBrokenPlan],
        ['quality', scaffoldSddQualityDefectPlan],
        ['yagni', scaffoldSddYagniPlan],
        ['spec-constraint', scaffoldSddSpecConstraintPlan],
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

  test('addSddAuthPlan layers onto an existing repo (no init)', () => {
    const dir = tmp();
    try {
      runGit(['init', '-b', 'main'], dir);
      runGit(['config', 'user.email', 'drill@test.local'], dir);
      runGit(['config', 'user.name', 'Drill Test'], dir);
      runGit(['commit', '--allow-empty', '-m', 'base'], dir);
      addSddAuthPlan({ workdir: dir } as never);
      expect(runGit(['log', '-1', '--format=%s'], dir).trim()).toBe(
        'draft auth-system plan',
      );
      expect(
        runGit(['show', 'HEAD:docs/superpowers/plans/auth-system.md'], dir),
      ).toContain('Auth System');
      const plan = runGit(
        ['show', 'HEAD:docs/superpowers/plans/auth-system.md'],
        dir,
      );
      expect(plan).toContain('src/auth/credentials.js');
      expect(plan).toContain('test/auth/credentials.test.js');
      expect(plan).toContain('npm test');
      expect(plan).not.toMatch(/\b(stub|placeholder|no-op)\b/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scaffoldSddStaleForeignWorkspace plants a hash-bearing stale flat ledger', () => {
    const dir = tmp();
    try {
      scaffoldSddStaleForeignWorkspace({ workdir: dir } as never);
      // Tracked state: notes module green, plan committed, clean tree.
      expect(runGit(['status', '--porcelain'], dir).trim()).toBe('');
      expect(
        runGit(
          ['show', 'HEAD:docs/superpowers/plans/2026-07-15-report-export.md'],
          dir,
        ),
      ).toContain('do not modify `src/export-csv.js`');
      // Untracked stale ledger: old flat format, no identity line, real hashes.
      const ledger = readFileSync(
        join(dir, '.superpowers/sdd/progress.md'),
        'utf8',
      );
      expect(ledger).not.toContain('# SDD ledger');
      const shorts = runGit(['log', '--format=%h', '--abbrev=7'], dir)
        .trim()
        .split('\n')
        .reverse(); // oldest first: [skeleton, notesTask1, notesTask2, plan]
      expect(ledger).toContain(
        `Task 1: complete (commits ${shorts[0]}..${shorts[1]}, review clean)`,
      );
      expect(ledger).toContain(
        `Task 2: complete (commits ${shorts[1]}..${shorts[2]}, review clean)`,
      );
      // Self-ignoring gitignore, exactly as pre-PR sdd-workspace wrote it.
      expect(
        readFileSync(join(dir, '.superpowers/sdd/.gitignore'), 'utf8'),
      ).toBe('*\n');
      // Ledger blob hash is stable and matches the exported literal.
      expect(
        runGit(['hash-object', '.superpowers/sdd/progress.md'], dir).trim(),
      ).toBe(STALE_LEDGER_BLOB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scaffoldSddStaleForeignWorkspace is fully deterministic across runs', () => {
    const heads: string[] = [];
    for (let i = 0; i < 2; i++) {
      const dir = tmp();
      try {
        scaffoldSddStaleForeignWorkspace({ workdir: dir } as never);
        heads.push(runGit(['rev-parse', 'HEAD'], dir).trim());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(heads[0]).toBe(heads[1]);
  });
});
