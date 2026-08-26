import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildChildRunArgs } from '../src/run-all/index.ts';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const RUN_CHILD = resolve(import.meta.dir, '..', 'src', 'cli', 'run-child.ts');
const REPO_CREDENTIALS = resolve(import.meta.dir, '..', 'credentials.yaml');
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

function scenario(): string {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(
    join(scn, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.',
  );
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scn;
}

function tmpGitRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sp-'));
  const git = (a: string[]) =>
    spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'SKILL.md'), 'x\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return { dir, sha: (git(['rev-parse', 'HEAD']).stdout ?? '').trim() };
}

function runCli(args: string[], envExtra: Record<string, string> = {}) {
  return spawnQuorumRun([CLI, 'run'], args, envExtra);
}

// Spawn a run through either entrypoint: the public `quorum run` command or
// run-all's narrow internal child (whose argv has no `run` subcommand and a
// required --credentials-file).
function spawnQuorumRun(
  argvHead: readonly string[],
  args: string[],
  envExtra: Record<string, string> = {},
) {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      ...argvHead,
      scenario(),
      '--coding-agent',
      'claude',
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      outRoot,
      ...args,
    ],
    {
      env: {
        ...process.env,
        PATH: `${mockGauntletDir('pass')}:${MOCK}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
        ...envExtra,
      },
      encoding: 'utf8',
    },
  );
  return {
    status: proc.status,
    stdout: proc.stdout,
    stderr: proc.stderr,
    outRoot,
  };
}

function readSoleVerdict(outRoot: string) {
  const runs = readdirSync(outRoot).filter((d) => !d.startsWith('.'));
  expect(runs.length).toBe(1);
  return JSON.parse(
    readFileSync(join(outRoot, runs[0] ?? '', 'verdict.json'), 'utf8'),
  );
}

test('mutual exclusion: both flags is a usage error', () => {
  const r = runCli(['--superpowers-root', '/tmp/x', '--no-superpowers']);
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(
    /mutually exclusive|cannot be used with|conflict/i,
  );
});

test('--superpowers-root: provenance reads the threaded root, not ambient', () => {
  const { dir, sha } = tmpGitRepo();
  // Ambient SUPERPOWERS_ROOT is empty (present-but-empty counts as missing):
  // proves the root-mode run does not depend on the ambient channel — neither
  // for provenance nor for the required-env gate (threading site 6).
  const r = runCli(['--superpowers-root', dir], { SUPERPOWERS_ROOT: '' });
  expect(r.status).toBe(0);
  const verdict = readSoleVerdict(r.outRoot);
  expect(verdict.provenance.superpowers_rev).toBe(sha);
  // Behavioral: the retained substituted launcher burns in the threaded path.
  const runDir = join(
    r.outRoot,
    readdirSync(r.outRoot).filter((d) => !d.startsWith('.'))[0] ?? '',
  );
  const launcher = readFileSync(
    join(runDir, 'gauntlet-agent', 'context', 'launch-agent'),
    'utf8',
  );
  expect(launcher).toContain(`--plugin-dir "${dir}"`);
});

test('--no-superpowers: provenance null, launcher elides plugin flags, no ambient demanded', () => {
  const r = runCli(['--no-superpowers'], { SUPERPOWERS_ROOT: '' });
  // SUPERPOWERS_ROOT='' in envExtra overrides the harness seed with an empty
  // value, proving none mode does not demand the ambient var (site 6).
  expect(r.status).toBe(0);
  const verdict = readSoleVerdict(r.outRoot);
  expect(verdict.provenance.superpowers_rev).toBeNull();
  const runDir = join(
    r.outRoot,
    readdirSync(r.outRoot).filter((d) => !d.startsWith('.'))[0] ?? '',
  );
  const launcher = readFileSync(
    join(runDir, 'gauntlet-agent', 'context', 'launch-agent'),
    'utf8',
  );
  expect(launcher).not.toContain('--plugin-dir');
});

test('QUORUM_SUPERPOWERS_REV under an explicit mode errors at run start', () => {
  const { dir } = tmpGitRepo();
  const r = runCli(['--superpowers-root', dir], {
    QUORUM_SUPERPOWERS_REV: 'deadbeef'.repeat(5),
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/QUORUM_SUPERPOWERS_REV/);
});

test('explicit mode with --os windows fails loud', () => {
  const { dir } = tmpGitRepo();
  const r = runCli(['--superpowers-root', dir, '--os', 'windows']);
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/windows/i);
});

test('legacy: no flags, ambient set — byte-identical behavior', () => {
  const r = runCli([]);
  expect(r.status).toBe(0);
  const verdict = readSoleVerdict(r.outRoot);
  // Ambient seed is a non-git tmpdir → the legacy probe yields null.
  expect(verdict.provenance.superpowers_rev).toBeNull();
  const runDir = join(
    r.outRoot,
    readdirSync(r.outRoot).filter((d) => !d.startsWith('.'))[0] ?? '',
  );
  const launcher = readFileSync(
    join(runDir, 'gauntlet-agent', 'context', 'launch-agent'),
    'utf8',
  );
  expect(launcher).toContain('--plugin-dir "');
});

// A typo'd --superpowers-root must die before run-dir allocation — the
// explicit-root contract never falls back to ambient for a broken path.
test('--superpowers-root with a nonexistent path fails before allocation', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'nope-')), 'absent');
  const r = runCli(['--superpowers-root', missing]);
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toContain(
    `--superpowers-root does not exist: ${missing}`,
  );
  expect(readdirSync(r.outRoot).filter((d) => !d.startsWith('.'))).toEqual([]);
});

// The run-all child argv builder is a pure projection: legacy calls (no
// superpowers fields) produce the byte-identical argv, and each field appends
// exactly its flag pair.
test('buildChildRunArgs: legacy argv unchanged; superpowers flags forwarded when set', () => {
  const base = {
    scenarioDir: '/s',
    codingAgent: 'claude',
    codingAgentsDir: '/a',
    outRoot: '/o',
  };
  expect(buildChildRunArgs(base)).toEqual([
    expect.any(String),
    '/s',
    '--coding-agent',
    'claude',
    '--coding-agents-dir',
    '/a',
    '--out-root',
    '/o',
  ]);
  expect(buildChildRunArgs({ ...base, superpowersRoot: '/srv/sp' })).toEqual([
    expect.any(String),
    '/s',
    '--coding-agent',
    'claude',
    '--coding-agents-dir',
    '/a',
    '--out-root',
    '/o',
    '--superpowers-root',
    '/srv/sp',
  ]);
  expect(buildChildRunArgs({ ...base, noSuperpowers: true })).toEqual([
    expect.any(String),
    '/s',
    '--coding-agent',
    'claude',
    '--coding-agents-dir',
    '/a',
    '--out-root',
    '/o',
    '--no-superpowers',
  ]);
  expect(buildChildRunArgs({ ...base, noSuperpowers: false })).toEqual(
    buildChildRunArgs(base),
  );
});

// The internal run-all child parser is a separate flag surface: the explicit
// modes must parse (and stay mutually exclusive) there too, or the campaign's
// child argv would die on an unknown option.
test('run-child parser: mutual exclusion is a usage error', () => {
  const r = spawnQuorumRun(
    [RUN_CHILD, '--credentials-file', REPO_CREDENTIALS],
    ['--superpowers-root', '/tmp/x', '--no-superpowers'],
  );
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(
    /mutually exclusive|cannot be used with|conflict/i,
  );
});

test('run-child parser: --superpowers-root threads the explicit root', () => {
  const { dir, sha } = tmpGitRepo();
  const r = spawnQuorumRun(
    [RUN_CHILD, '--credentials-file', REPO_CREDENTIALS],
    ['--superpowers-root', dir],
    { SUPERPOWERS_ROOT: '' },
  );
  expect(r.status).toBe(0);
  expect(readSoleVerdict(r.outRoot).provenance.superpowers_rev).toBe(sha);
});

// Decision D-5's hostile test: a child spawned through a DIFFERENT checkout's
// entrypoint must execute that checkout's content, not the originating one —
// the instrument-snapshot mechanism rests on it. Uses a real git worktree of
// this repo at an older SHA (no quorum run; a repoRoot probe is enough).
test('D-5: a child executing another checkout reports THAT checkout as root', () => {
  const repo = resolve(import.meta.dir, '..');
  const wt = mkdtempSync(join(tmpdir(), 'reentry-'));
  const sha = spawnSync('git', ['rev-parse', 'HEAD~20'], {
    cwd: repo,
    encoding: 'utf8',
  }).stdout?.trim();
  expect(sha).toBeTruthy();
  const add = spawnSync('git', ['worktree', 'add', '--detach', wt, sha ?? ''], {
    cwd: repo,
    encoding: 'utf8',
  });
  try {
    expect(add.status).toBe(0);
    spawnSync('bun', ['install', '--frozen-lockfile'], {
      cwd: wt,
      encoding: 'utf8',
    });
    const probe = spawnSync(
      'bun',
      [
        '-e',
        'import { repoRoot } from "./src/paths.ts"; console.log(repoRoot());',
      ],
      { cwd: wt, encoding: 'utf8' },
    );
    expect(probe.status).toBe(0);
    // macOS tmpdir is a symlink (/var → /private/var) and repoRoot() may or may
    // not carry a trailing slash — compare realpath-normalized, slash-trimmed.
    const norm = (p: string) => realpathSync(p.replace(/\/+$/, ''));
    expect(norm(probe.stdout.trim())).toBe(norm(wt));
    expect(norm(probe.stdout.trim())).not.toBe(norm(repo));
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo });
    spawnSync('git', ['worktree', 'prune'], { cwd: repo });
  }
});
