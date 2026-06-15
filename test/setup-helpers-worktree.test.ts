import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { repoRoot } from '../src/paths.ts';
import { createBaseRepo } from '../src/setup-helpers/base.ts';
import { runGit } from '../src/setup-helpers/git.ts';
import {
  addExistingWorktree,
  createCallerConsentPlan,
  detachWorktreeHead,
  linkGeminiExtension,
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

class GeminiRunner implements CommandRunner {
  calls: Array<readonly string[]> = [];
  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push([command, ...args]);
    return { status: 0, stdout: '', stderr: '' };
  }
}

// Build a hermetic superpowersRoot that mirrors the live-eval failure: the
// checkout contains the whole evals/ submodule (with prior run output under
// results/), a .git dir, and node_modules — none of which belong in the linked
// Gemini extension.
function makeSuperpowersRoot(parent: string): string {
  const root = join(parent, 'sp');
  mkdirSync(join(root, 'skills', 'using-superpowers', 'references'), {
    recursive: true,
  });
  writeFileSync(
    join(root, 'skills', 'using-superpowers', 'SKILL.md'),
    'skill\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'skills', 'using-superpowers', 'references', 'gemini-tools.md'),
    'tools\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'gemini-extension.json'),
    JSON.stringify({ name: 'superpowers' }),
    'utf8',
  );
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'hook.sh'), 'echo hi\n', 'utf8');
  mkdirSync(join(root, 'evals', 'results', 'junk'), { recursive: true });
  writeFileSync(
    join(root, 'evals', 'results', 'junk', 'prior-run.txt'),
    'old output\n',
    'utf8',
  );
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '0\n', 'utf8');
  return root;
}

test('linkGeminiExtension uninstalls then links a clean staged extension', () => {
  const parent = mkdtempSync(join(tmpdir(), 'sh-gem-'));
  const run = new GeminiRunner();
  try {
    const root = makeSuperpowersRoot(parent);
    const wd = join(parent, 'wd');
    linkGeminiExtension({
      workdir: wd,
      superpowersRoot: root,
      run,
    } as never);

    expect(run.calls[0]).toEqual([
      'gemini',
      'extensions',
      'uninstall',
      'superpowers',
    ]);
    expect(run.calls[1]?.slice(0, 3)).toEqual(['gemini', 'extensions', 'link']);

    // The linked path is a STAGED copy, not the raw superpowersRoot.
    const linkedPath = run.calls[1]?.[3];
    expect(linkedPath).toBeDefined();
    expect(linkedPath).not.toBe(root);

    // The staged dir excludes evals/.git/node_modules ...
    expect(existsSync(join(linkedPath as string, 'evals'))).toBe(false);
    expect(existsSync(join(linkedPath as string, '.git'))).toBe(false);
    expect(existsSync(join(linkedPath as string, 'node_modules'))).toBe(false);
    // ... but still contains the actual extension contents.
    expect(
      existsSync(join(linkedPath as string, 'gemini-extension.json')),
    ).toBe(true);
    expect(existsSync(join(linkedPath as string, 'skills'))).toBe(true);
    expect(existsSync(join(linkedPath as string, 'hooks'))).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('linkGeminiExtension GEMINI.md @imports point at the staged skills dir', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'sh-gem-'));
  const run = new GeminiRunner();
  try {
    const root = makeSuperpowersRoot(parent);
    const wd = join(parent, 'wd');
    linkGeminiExtension({
      workdir: wd,
      superpowersRoot: root,
      run,
    } as never);

    const linkedPath = run.calls[1]?.[3] as string;
    const gemini = await Bun.file(join(wd, 'GEMINI.md')).text();
    // The @import resolves to the staged skills dir (which is what gemini
    // actually linked), not the raw root's skills dir.
    expect(gemini).toContain(
      `@${join(linkedPath, 'skills')}/using-superpowers/SKILL.md`,
    );
    expect(gemini).toContain(
      `@${join(linkedPath, 'skills')}/using-superpowers/references/gemini-tools.md`,
    );
    expect(gemini).not.toContain(`@${join(root, 'skills')}/`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
