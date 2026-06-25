// test/setup-helpers-cli.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../src/paths.ts';
import { runHelpers } from '../src/setup-helpers/cli.ts';
import { runGit } from '../src/setup-helpers/git.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-cli-'));
}

describe('runHelpers', () => {
  test('chains create_base_repo + create_caller_consent_plan', async () => {
    const dir = tmp();
    try {
      await runHelpers(['create_base_repo', 'create_caller_consent_plan'], {
        workdir: dir,
        repoRoot: repoRoot(),
        superpowersRoot: undefined,
        scenarioDir: undefined,
      });
      expect(runGit(['log', '-1', '--format=%s'], dir).trim()).toBe(
        'add caller consent gate plan',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unknown helper throws with the known list', async () => {
    const dir = tmp();
    try {
      await expect(
        runHelpers(['nope'], {
          workdir: dir,
          repoRoot: repoRoot(),
          superpowersRoot: undefined,
          scenarioDir: undefined,
        }),
      ).rejects.toThrow(/unknown helper/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a needsSuperpowersRoot helper throws when root is missing', async () => {
    const dir = tmp();
    try {
      await expect(
        runHelpers(['symlink_superpowers'], {
          workdir: dir,
          repoRoot: repoRoot(),
          superpowersRoot: undefined,
          scenarioDir: undefined,
        }),
      ).rejects.toThrow(/SUPERPOWERS_ROOT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('init_repo_from_fixtures throws when QUORUM_SCENARIO_DIR is missing', async () => {
    const dir = tmp();
    try {
      await expect(
        runHelpers(['init_repo_from_fixtures'], {
          workdir: dir,
          repoRoot: repoRoot(),
          superpowersRoot: undefined,
          scenarioDir: undefined,
        }),
      ).rejects.toThrow(/QUORUM_SCENARIO_DIR/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('init_repo_from_fixtures seeds the workdir from the scenario fixtures dir', async () => {
    const scenario = tmp();
    const work = tmp();
    try {
      const fixtures = join(scenario, 'fixtures');
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(join(fixtures, 'plan.md'), 'PLAN\n');

      await runHelpers(['init_repo_from_fixtures'], {
        workdir: work,
        repoRoot: repoRoot(),
        superpowersRoot: undefined,
        scenarioDir: scenario,
      });

      expect(runGit(['show', 'HEAD:plan.md'], work)).toContain('PLAN');
    } finally {
      rmSync(scenario, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
