// Tests for the unified check-tool dispatcher and its non-transcript verbs.
//
// Strategy (mirrors test/check-transcript.test.ts): exercise each verb both
// directly (the verbX functions over a CheckContext) and end-to-end (source the
// check prelude and call the verb function with a temp fixture + record sink,
// asserting exit code + record).

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { negate, runVerb } from '../src/check/dispatch.ts';
import type { CheckContext } from '../src/check/fs-verbs.ts';
import {
  verbAssertCheckoutClean,
  verbCommandSucceeds,
  verbFileContains,
  verbFileExists,
  verbFilesExist,
  verbGitBranch,
  verbGitClean,
  verbGitCount,
  verbGitRepo,
  verbRequiresTool,
} from '../src/check/fs-verbs.ts';

const REPO = resolve(import.meta.dir, '..');
const PRELUDE = resolve(REPO, 'src', 'checks', 'prelude.sh');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'ct-wd-'));
}

function ctxFor(cwd: string, env: Record<string, string> = {}): CheckContext {
  return { cwd, env: (k) => env[k] };
}

function writeFile(dir: string, rel: string, content = 'x'): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

function gitInit(dir: string): void {
  const opts = { cwd: dir, encoding: 'utf8' as const };
  spawnSync('git', ['init', '-q'], opts);
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], opts);
  spawnSync('git', ['config', 'user.email', 't@t'], opts);
  spawnSync('git', ['config', 'user.name', 't'], opts);
}

function gitCommit(dir: string, file: string): void {
  const opts = { cwd: dir, encoding: 'utf8' as const };
  writeFileSync(join(dir, file), file);
  spawnSync('git', ['add', '-A'], opts);
  spawnSync('git', ['commit', '-qm', file], opts);
}

interface ShimResult {
  exitCode: number;
  record: Record<string, unknown> | null;
  records: Record<string, unknown>[];
}

/**
 * Run a check verb via the sourced prelude from `cwd` with a record sink; parse
 * the records. The prelude defines each verb as a function delegating to
 * check-tool.ts, so this exercises the same path scenario checks.sh use.
 */
function runShim(
  tool: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): ShimResult {
  const sink = join(mkdtempSync(join(tmpdir(), 'ct-sink-')), 'records.jsonl');
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const proc = spawnSync(
    'bash',
    ['-c', `source '${PRELUDE}'; ${tool} ${quoted}`],
    {
      cwd,
      env: {
        ...process.env,
        QUORUM_REPO_ROOT: REPO,
        QUORUM_RECORD_SINK: sink,
        ...env,
      },
      encoding: 'utf8',
    },
  );
  let records: Record<string, unknown>[] = [];
  try {
    records = readFileSync(sink, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    records = [];
  }
  return {
    exitCode: proc.status ?? 0,
    record: records[records.length - 1] ?? null,
    records,
  };
}

// ---------------------------------------------------------------------------
// file-exists (incl. globstar)
// ---------------------------------------------------------------------------

test('file-exists: literal path hit', () => {
  const wd = workdir();
  writeFile(wd, 'a.txt');
  expect(verbFileExists(['a.txt'], ctxFor(wd)).passed).toBe(true);
});

test('file-exists: literal path miss', () => {
  const wd = workdir();
  const r = verbFileExists(['nope.txt'], ctxFor(wd));
  expect(r.passed).toBe(false);
  expect(r.detail).toBe('no path matched: nope.txt');
});

test('file-exists: single-segment glob', () => {
  const wd = workdir();
  writeFile(wd, 'src/one.js');
  writeFile(wd, 'src/two.js');
  expect(verbFileExists(['src/*.js'], ctxFor(wd)).passed).toBe(true);
  expect(verbFileExists(['src/*.py'], ctxFor(wd)).passed).toBe(false);
});

test('file-exists: globstar matches a nested basename (** /name)', () => {
  const wd = workdir();
  writeFile(wd, 'deep/nested/dir/target.md');
  expect(verbFileExists(['**/target.md'], ctxFor(wd)).passed).toBe(true);
  expect(verbFileExists(['**/missing.md'], ctxFor(wd)).passed).toBe(false);
});

test('file-exists: globstar matches a nested path with a surviving slash (a/**/b/c)', () => {
  const wd = workdir();
  writeFile(wd, 'a/x/y/b/c');
  expect(verbFileExists(['a/**/b/c'], ctxFor(wd)).passed).toBe(true);
  expect(verbFileExists(['a/**/b/nope'], ctxFor(wd)).passed).toBe(false);
});

test('file-exists: globstar on a glob suffix (**/*.md)', () => {
  const wd = workdir();
  writeFile(wd, 'docs/specs/p.md');
  expect(verbFileExists(['docs/**/*.md'], ctxFor(wd)).passed).toBe(true);
});

test('file-exists: literal path with spaces (no glob chars)', () => {
  const wd = workdir();
  writeFile(wd, 'a file.txt');
  expect(verbFileExists(['a file.txt'], ctxFor(wd)).passed).toBe(true);
});

// ---------------------------------------------------------------------------
// file-contains
// ---------------------------------------------------------------------------

test('file-contains: pattern hit', () => {
  const wd = workdir();
  writeFile(wd, 'm.js', 'export function add(){}\n');
  expect(
    verbFileContains(['m.js', 'export function add'], ctxFor(wd)).passed,
  ).toBe(true);
});

test('file-contains: pattern miss', () => {
  const wd = workdir();
  writeFile(wd, 'm.js', 'export function add(){}\n');
  const r = verbFileContains(['m.js', 'function divide'], ctxFor(wd));
  expect(r.passed).toBe(false);
  expect(r.detail).toBe('pattern not found in m.js');
});

test('file-contains: missing file', () => {
  const wd = workdir();
  const r = verbFileContains(['nope.js', 'x'], ctxFor(wd));
  expect(r.passed).toBe(false);
  expect(r.detail).toBe('file not found: nope.js');
});

test('file-contains: POSIX bracket class is translated ([[:space:]])', () => {
  const wd = workdir();
  writeFile(wd, 'm.txt', 'hello   world\n');
  expect(
    verbFileContains(['m.txt', 'hello[[:space:]]+world'], ctxFor(wd)).passed,
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// command-succeeds
// ---------------------------------------------------------------------------

test('command-succeeds: exit 0 passes', () => {
  const wd = workdir();
  expect(verbCommandSucceeds(['true'], ctxFor(wd)).passed).toBe(true);
});

test('command-succeeds: non-zero fails with truncated, newline-stripped detail', () => {
  const wd = workdir();
  const r = verbCommandSucceeds(['printf boom; false'], ctxFor(wd));
  expect(r.passed).toBe(false);
  expect(r.detail).toBe('exit non-zero: boom');
});

test('command-succeeds: runs from the workdir cwd', () => {
  const wd = workdir();
  writeFile(wd, 'present.txt');
  expect(verbCommandSucceeds(['test -f present.txt'], ctxFor(wd)).passed).toBe(
    true,
  );
});

// ---------------------------------------------------------------------------
// git-repo / git-branch / git-clean
// ---------------------------------------------------------------------------

test('git-repo: pass inside a work tree, fail outside', () => {
  const wd = workdir();
  expect(verbGitRepo([], ctxFor(wd)).passed).toBe(false);
  gitInit(wd);
  expect(verbGitRepo([], ctxFor(wd)).passed).toBe(true);
});

test('git-branch: matches current; reports mismatch', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  expect(verbGitBranch(['main'], ctxFor(wd)).passed).toBe(true);
  const r = verbGitBranch(['other'], ctxFor(wd));
  expect(r.passed).toBe(false);
  expect(r.detail).toBe("branch is 'main', expected 'other'");
});

test('git-branch detached: passes when HEAD is detached', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: wd,
    encoding: 'utf8',
  }).stdout.trim();
  spawnSync('git', ['checkout', '-q', head], { cwd: wd, encoding: 'utf8' });
  expect(verbGitBranch(['detached'], ctxFor(wd)).passed).toBe(true);
});

test('git-clean: clean tree passes, dirty fails', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  expect(verbGitClean([], ctxFor(wd)).passed).toBe(true);
  writeFileSync(join(wd, 'dirty'), 'x');
  expect(verbGitClean([], ctxFor(wd)).passed).toBe(false);
});

// ---------------------------------------------------------------------------
// git-count — all six operators + broken dim/op
// ---------------------------------------------------------------------------

test('git-count: all six operators against a 2-commit repo', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  gitCommit(wd, 'b');
  const c = ctxFor(wd);
  expect(verbGitCount(['commits', 'eq', '2'], c).passed).toBe(true);
  expect(verbGitCount(['commits', 'eq', '3'], c).passed).toBe(false);
  expect(verbGitCount(['commits', 'ne', '3'], c).passed).toBe(true);
  expect(verbGitCount(['commits', 'ne', '2'], c).passed).toBe(false);
  expect(verbGitCount(['commits', 'gt', '1'], c).passed).toBe(true);
  expect(verbGitCount(['commits', 'gt', '2'], c).passed).toBe(false);
  expect(verbGitCount(['commits', 'gte', '2'], c).passed).toBe(true);
  expect(verbGitCount(['commits', 'gte', '3'], c).passed).toBe(false);
  expect(verbGitCount(['commits', 'lt', '3'], c).passed).toBe(true);
  expect(verbGitCount(['commits', 'lt', '2'], c).passed).toBe(false);
  expect(verbGitCount(['commits', 'lte', '2'], c).passed).toBe(true);
  expect(verbGitCount(['commits', 'lte', '1'], c).passed).toBe(false);
});

test('git-count: worktrees counts the main worktree', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  expect(verbGitCount(['worktrees', 'eq', '1'], ctxFor(wd)).passed).toBe(true);
});

test('git-count: unknown dimension is broken (non-invertible)', () => {
  const wd = workdir();
  gitInit(wd);
  const r = verbGitCount(['blobs', 'eq', '1'], ctxFor(wd));
  expect(r.broken).toBe(true);
  expect(r.detail).toBe('unknown dimension: blobs');
});

test('git-count: unknown operator is broken (non-invertible)', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  const r = verbGitCount(['commits', 'bogus', '1'], ctxFor(wd));
  expect(r.broken).toBe(true);
  expect(r.detail).toBe('unknown op: bogus');
});

// ---------------------------------------------------------------------------
// assert-checkout-clean
// ---------------------------------------------------------------------------

test('assert-checkout-clean: clean tree passes; the launch-cwd sentinel is ignored', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  expect(verbAssertCheckoutClean(['.'], ctxFor(wd)).passed).toBe(true);
  writeFileSync(join(wd, '.quorum-launch-cwd'), 'x');
  expect(verbAssertCheckoutClean(['.'], ctxFor(wd)).passed).toBe(true);
});

test('assert-checkout-clean: real drift fails', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  writeFileSync(join(wd, 'drift'), 'x');
  const r = verbAssertCheckoutClean(['.'], ctxFor(wd));
  expect(r.passed).toBe(false);
  expect(r.detail).toContain('not clean');
});

test('assert-checkout-clean: non-repo path fails', () => {
  const wd = workdir();
  const r = verbAssertCheckoutClean(['.'], ctxFor(wd));
  expect(r.passed).toBe(false);
  expect(r.detail).toContain('is not a git work tree');
});

// ---------------------------------------------------------------------------
// requires-tool
// ---------------------------------------------------------------------------

test('requires-tool: present tool passes', () => {
  const wd = workdir();
  const r = verbRequiresTool(
    ['git'],
    ctxFor(wd, { PATH: process.env['PATH'] ?? '' }),
  );
  expect(r.passed).toBe(true);
  expect(r.detail).toBe('all required tools on PATH: git');
});

test('requires-tool: missing tool fails (env-missing, not broken)', () => {
  const wd = workdir();
  const r = verbRequiresTool(
    ['nope_tool_xyz'],
    ctxFor(wd, { PATH: process.env['PATH'] ?? '' }),
  );
  expect(r.passed).toBe(false);
  expect(r.broken).toBeUndefined();
  expect(r.detail).toBe('required tool(s) not on PATH: nope_tool_xyz');
});

test('requires-tool: no args is broken', () => {
  const wd = workdir();
  const r = verbRequiresTool([], ctxFor(wd, { PATH: '' }));
  expect(r.broken).toBe(true);
});

// ---------------------------------------------------------------------------
// files-exist
// ---------------------------------------------------------------------------

test('files-exist: all present passes', () => {
  const wd = workdir();
  writeFile(wd, 'root/a');
  writeFile(wd, 'root/b/c');
  expect(verbFilesExist(['root', 'a', 'b/c'], ctxFor(wd)).passed).toBe(true);
});

test('files-exist: missing rels listed in detail', () => {
  const wd = workdir();
  writeFile(wd, 'root/a');
  const r = verbFilesExist(['root', 'a', 'missing'], ctxFor(wd));
  expect(r.passed).toBe(false);
  expect(r.detail).toBe('missing');
});

test('files-exist: no rels is broken', () => {
  const wd = workdir();
  expect(verbFilesExist(['root'], ctxFor(wd)).broken).toBe(true);
});

// ---------------------------------------------------------------------------
// negate (the `not` verb) — three load-bearing rules
// ---------------------------------------------------------------------------

test('negate: inverts an inner FAIL to a pass, one record under the inner name', () => {
  const wd = workdir();
  const r = negate(['file-exists', 'nope.txt'], ctxFor(wd));
  expect(r.refused).toBe(false);
  expect(r.passed).toBe(true);
  expect(r.check).toBe('file-exists');
  expect(r.args).toEqual(['nope.txt']);
  expect(r.negated).toBe(true);
});

test('negate: inverts an inner PASS to a fail', () => {
  const wd = workdir();
  writeFile(wd, 'a.txt');
  const r = negate(['file-exists', 'a.txt'], ctxFor(wd));
  expect(r.passed).toBe(false);
  expect(r.negated).toBe(true);
  expect(r.check).toBe('file-exists');
});

test('negate: refuses to invert a MISSING inner tool (records under not, exit-1 semantics)', () => {
  const wd = workdir();
  const r = negate(['file-exits', 'a'], ctxFor(wd));
  expect(r.refused).toBe(true);
  expect(r.passed).toBe(false);
  expect(r.check).toBe('not');
  expect(r.detail).toContain('unknown inner tool: file-exits');
});

test('negate: refuses to invert a CRASH (inner broken check)', () => {
  const wd = workdir();
  gitInit(wd);
  // git-count with an unknown op returns broken — must NOT be inverted to a pass.
  const r = negate(['git-count', 'commits', 'bogus', '1'], ctxFor(wd));
  expect(r.refused).toBe(true);
  expect(r.passed).toBe(false);
  expect(r.check).toBe('not');
});

test('negate: wraps check-transcript under the wrapper name (TRACE_PRIMITIVES guard)', () => {
  // With no transcript loaded, an empty capture makes tool-not-called FAIL, so
  // the negation passes; the record's check is the inner tool name.
  const wd = workdir();
  const r = negate(['check-transcript', 'tool-called', 'Edit'], ctxFor(wd));
  expect(r.check).toBe('check-transcript');
  expect(r.negated).toBe(true);
});

// ---------------------------------------------------------------------------
// runVerb dispatch table
// ---------------------------------------------------------------------------

test('runVerb: unknown verb returns null', () => {
  expect(runVerb('totally-unknown', [], ctxFor(workdir()))).toBeNull();
});

// ---------------------------------------------------------------------------
// End-to-end via the check prelude (record shape + exit codes)
// ---------------------------------------------------------------------------

test('E2E: file-exists shim emits a byte-shaped record and exits 0', () => {
  const wd = workdir();
  writeFile(wd, 'present.txt');
  const r = runShim('file-exists', ['present.txt'], wd);
  expect(r.exitCode).toBe(0);
  expect(r.record).toEqual({
    check: 'file-exists',
    args: ['present.txt'],
    negated: false,
    passed: true,
    detail: null,
  });
});

test('E2E: file-exists miss exits 1 with a detail string', () => {
  const wd = workdir();
  const r = runShim('file-exists', ['nope.txt'], wd);
  expect(r.exitCode).toBe(1);
  expect(r.record).toMatchObject({
    passed: false,
    detail: 'no path matched: nope.txt',
  });
});

test('E2E: not file-exists (miss) inverts to pass, single negated record', () => {
  const wd = workdir();
  const r = runShim('not', ['file-exists', 'nope.txt'], wd);
  expect(r.exitCode).toBe(0);
  expect(r.records).toHaveLength(1);
  expect(r.record).toEqual({
    check: 'file-exists',
    args: ['nope.txt'],
    negated: true,
    passed: true,
    detail: null,
  });
});

test('E2E: not on a typo tool exits 1 (NOT 127) with a fail record under not', () => {
  const wd = workdir();
  const r = runShim('not', ['file-exits', 'a'], wd);
  expect(r.exitCode).toBe(1);
  expect(r.record).toMatchObject({
    check: 'not',
    negated: false,
    passed: false,
  });
});

test('E2E: git-count unknown op exits 127 (non-invertible) with a fail record', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  const r = runShim('git-count', ['commits', 'bogus', '1'], wd);
  expect(r.exitCode).toBe(127);
  expect(r.record).toMatchObject({ check: 'git-count', passed: false });
});

test('E2E: unknown verb exits 127 with a fail record', () => {
  const wd = workdir();
  const cli = resolve(import.meta.dir, '..', 'src', 'cli', 'check-tool.ts');
  const sink = join(mkdtempSync(join(tmpdir(), 'ct-sink-')), 'r.jsonl');
  const proc = spawnSync('bun', ['run', cli, 'totally-unknown-verb'], {
    cwd: wd,
    env: { ...process.env, QUORUM_RECORD_SINK: sink },
    encoding: 'utf8',
  });
  expect(proc.status).toBe(127);
  const rec = JSON.parse(readFileSync(sink, 'utf8').trim()) as Record<
    string,
    unknown
  >;
  expect(rec['passed']).toBe(false);
});

test('E2E: setup-helpers prelude function resolves to the TS CLI', () => {
  // The prelude's setup-helpers function must delegate to the unified CLI.
  const proc = spawnSync('bash', ['-c', `source '${PRELUDE}'; setup-helpers`], {
    env: { ...process.env, QUORUM_REPO_ROOT: REPO },
    encoding: 'utf8',
  });
  // Missing `run` subcommand → usage error exit 2 (the CLI's distinction).
  expect(proc.status).toBe(2);
});

// PRI-2494 arity gates: a missing/empty required arg is a BROKEN check (127
// band), never a vacuous pass. Mirrors transcript-dispatch's REQUIRED_ARGS.
test('file-exists with no args is broken, not a pass', () => {
  const ctx = { cwd: mkdtempSync(join(tmpdir(), 'wd-')), env: () => undefined };
  for (const args of [[], ['']]) {
    const r = verbFileExists(args, ctx);
    expect(r.broken).toBe(true);
    expect(r.passed).toBe(false);
  }
});

test('file-contains with a missing path or pattern is broken', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(join(cwd, 'f.txt'), 'hello\n');
  const ctx = { cwd, env: () => undefined };
  for (const args of [[], ['f.txt'], ['f.txt', ''], ['', 'hello']]) {
    const r = verbFileContains(args, ctx);
    expect(r.broken).toBe(true);
  }
  // Two real args still work.
  expect(verbFileContains(['f.txt', 'hello'], ctx).passed).toBe(true);
});

test('command-succeeds with a missing/empty command is broken (bash -c "" would pass)', () => {
  const ctx = { cwd: mkdtempSync(join(tmpdir(), 'wd-')), env: () => undefined };
  for (const args of [[], ['']]) {
    const r = verbCommandSucceeds(args, ctx);
    expect(r.broken).toBe(true);
  }
});

// PRI-2494 glob fix: a trailing-`**` matches any descendant of the prefix dir.
test('file-exists with a trailing-** glob matches directory descendants', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wd-'));
  mkdirSync(join(cwd, 'docs', 'sub'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'sub', 'a.md'), 'x');
  const ctx = { cwd, env: () => undefined };
  expect(verbFileExists(['docs/**'], ctx).passed).toBe(true);
  // An empty dir has no descendants: no match.
  mkdirSync(join(cwd, 'empty'));
  expect(verbFileExists(['empty/**'], ctx).passed).toBe(false);
});
