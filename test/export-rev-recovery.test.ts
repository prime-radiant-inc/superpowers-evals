import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from '../src/agents/command-runner.ts';
import { SpawnCommandRunner } from '../src/agents/command-runner.ts';
import { envSnapshot } from '../src/env.ts';
import {
  buildSkillsTreeIndex,
  recoverSuperpowersRev,
  skillsTreeSha,
} from '../src/export-runs/rev-recovery.ts';
import {
  subprocessTraceDir,
  traceError,
  writeSubprocessTrace,
} from './fixtures/subprocess-trace.ts';

const realRunner = new SpawnCommandRunner();
const traceDir = subprocessTraceDir('rev-recovery');
let nextCallId = 0;
// Only operation names are retained: no argv, environment, stdin or tree bytes.
const operation = (args: readonly string[]) =>
  args[0] === '--work-tree' ? 'add-archived-tree' : args[0];
const runner: CommandRunner = {
  run(command, args, options) {
    const call_id = ++nextCallId;
    const started = performance.now();
    writeSubprocessTrace(traceDir, {
      event: 'start',
      call_id,
      layer: 'production',
      command,
      operation: operation(args),
      cwd: options?.cwd,
    });
    try {
      const result = realRunner.run(command, args, options);
      writeSubprocessTrace(traceDir, {
        event: 'end',
        call_id,
        elapsed_ms: performance.now() - started,
        status: result.status,
        ...(result.status === 0
          ? {}
          : { stderr: result.stderr.slice(0, 1024) }),
      });
      return result;
    } catch (error) {
      writeSubprocessTrace(traceDir, {
        event: 'throw',
        call_id,
        elapsed_ms: performance.now() - started,
        error: traceError(error),
      });
      throw error;
    }
  },
};

function git(cwd: string, args: string[], date?: string): string {
  const call_id = ++nextCallId;
  const started = performance.now();
  writeSubprocessTrace(traceDir, {
    event: 'start',
    call_id,
    layer: 'fixture',
    command: 'git',
    operation: operation(args),
    cwd,
  });
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env:
      date === undefined
        ? envSnapshot()
        : {
            ...envSnapshot(),
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_DATE: date,
          },
  });
  writeSubprocessTrace(traceDir, {
    event: 'end',
    call_id,
    elapsed_ms: performance.now() - started,
    status: proc.status,
    signal: proc.signal,
    error: traceError(proc.error),
    ...(proc.status === 0 ? {} : { stderr: proc.stderr.slice(0, 1024) }),
  });
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${proc.stderr}`);
  }
  return proc.stdout.trim();
}

function writeSkill(root: string, name: string, body: string): void {
  mkdirSync(join(root, 'skills', name), { recursive: true });
  writeFileSync(join(root, 'skills', name, 'SKILL.md'), body);
}

// Commit dates are pinned so the tie-break test has a real time gap to work
// with; back-to-back test commits would otherwise share a second.
const C1_DATE = '2026-07-30T10:00:00-07:00';
const C2_DATE = '2026-07-30T12:51:00-07:00';
const C3_DATE = '2026-07-30T15:56:00-07:00';

// A superpowers-like repo with three commits:
//   c1 -> skills A          (tree T1)
//   c2 -> skills A + B      (tree T2)
//   c3 -> docs only         (tree T2 again, identical skills)
interface Fixture {
  readonly repo: string;
  readonly c1: string;
  readonly c2: string;
  readonly c3: string;
}

function superpowersRepo(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), 'sp-repo-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);

  writeSkill(repo, 'brainstorming', 'first version\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'add brainstorming'], C1_DATE);
  const c1 = git(repo, ['rev-parse', 'HEAD']);

  writeSkill(repo, 'debugging', 'debugging skill\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'add debugging'], C2_DATE);
  const c2 = git(repo, ['rev-parse', 'HEAD']);

  writeFileSync(join(repo, 'README.md'), 'docs only\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'docs: readme'], C3_DATE);
  const c3 = git(repo, ['rev-parse', 'HEAD']);

  return { repo, c1, c2, c3 };
}

// A run dir whose archived plugin cache holds a copy of the given skills tree.
function runWithArchivedTree(
  skills: ReadonlyArray<readonly [string, string]>,
): string {
  const run = mkdtempSync(join(tmpdir(), 'run-'));
  const local = join(run, 'home/.codex/plugins/cache/debug/superpowers/local');
  for (const [name, body] of skills) {
    writeSkill(local, name, body);
  }
  return run;
}

test('skillsTreeSha hashes an archived skills dir to a git tree sha', () => {
  const fixture = superpowersRepo();
  const run = runWithArchivedTree([['brainstorming', 'first version\n']]);

  const sha = skillsTreeSha(
    join(run, 'home/.codex/plugins/cache/debug/superpowers/local/skills'),
    fixture.repo,
    runner,
  );

  expect(sha).toBe(git(fixture.repo, ['rev-parse', `${fixture.c1}:skills`]));
});

test('recoverSuperpowersRev returns recorded when the verdict already has it', () => {
  const fixture = superpowersRepo();
  const index = buildSkillsTreeIndex(fixture.repo, runner);

  const result = recoverSuperpowersRev({
    runDir: runWithArchivedTree([['brainstorming', 'first version\n']]),
    recordedRev: 'abc123',
    startedAt: '2026-07-30T20:15:15Z',
    superpowersRepo: fixture.repo,
    index,
    runner,
  });

  expect(result.status).toBe('recorded');
  expect(result.superpowersSha).toBe('abc123');
});

test('recoverSuperpowersRev recovers an exact sha from the archived tree', () => {
  const fixture = superpowersRepo();
  const index = buildSkillsTreeIndex(fixture.repo, runner);

  const result = recoverSuperpowersRev({
    runDir: runWithArchivedTree([['brainstorming', 'first version\n']]),
    recordedRev: null,
    startedAt: '2026-07-30T20:15:15Z',
    superpowersRepo: fixture.repo,
    index,
    runner,
  });

  expect(result.status).toBe('recovered');
  expect(result.superpowersSha).toBe(fixture.c1);
  expect(result.superpowersTreeSha).toBe(
    git(fixture.repo, ['rev-parse', `${fixture.c1}:skills`]),
  );
});

test('a skills-tree tie is broken by the newest commit preceding started_at', () => {
  const fixture = superpowersRepo();
  const index = buildSkillsTreeIndex(fixture.repo, runner);
  // c2 and c3 share a skills tree; c3 is the docs-only commit stacked on c2.
  const archived: ReadonlyArray<readonly [string, string]> = [
    ['brainstorming', 'first version\n'],
    ['debugging', 'debugging skill\n'],
  ];

  // 13:15 PDT: after c2 (12:51), before c3 (15:56).
  const startedAt = '2026-07-30T20:15:15Z';

  const result = recoverSuperpowersRev({
    runDir: runWithArchivedTree(archived),
    recordedRev: null,
    startedAt,
    superpowersRepo: fixture.repo,
    index,
    runner,
  });

  expect(result.status).toBe('recovered');
  expect(result.superpowersSha).toBe(fixture.c2);
});

test('a modified tree that matches no commit is tree_only, keeping the tree sha', () => {
  const fixture = superpowersRepo();
  const index = buildSkillsTreeIndex(fixture.repo, runner);

  const result = recoverSuperpowersRev({
    runDir: runWithArchivedTree([['brainstorming', 'LOCALLY MODIFIED\n']]),
    recordedRev: null,
    startedAt: '2026-07-30T20:15:15Z',
    superpowersRepo: fixture.repo,
    index,
    runner,
  });

  expect(result.status).toBe('tree_only');
  expect(result.superpowersSha).toBeNull();
  expect(result.superpowersTreeSha).not.toBeNull();
});

test('a run with no archived tree is unknown', () => {
  const fixture = superpowersRepo();
  const index = buildSkillsTreeIndex(fixture.repo, runner);
  const run = mkdtempSync(join(tmpdir(), 'run-bare-'));
  mkdirSync(join(run, 'home/.gemini/extensions/superpowers'), {
    recursive: true,
  });

  const result = recoverSuperpowersRev({
    runDir: run,
    recordedRev: null,
    startedAt: '2026-07-30T20:15:15Z',
    superpowersRepo: fixture.repo,
    index,
    runner,
  });

  expect(result.status).toBe('unknown');
  expect(result.superpowersSha).toBeNull();
  expect(result.superpowersTreeSha).toBeNull();
});
