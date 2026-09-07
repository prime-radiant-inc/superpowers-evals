import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');
// Direct `quorum run` is a live-spend spender: pin the lock to a per-file
// tmp path so parallel test processes never contend for the $HOME default.
const SPEND_LOCK = join(mkdtempSync(join(tmpdir(), 'qlock-')), 'live.lock.d');
const HOST_STATS_FIXTURE = resolve(
  import.meta.dir,
  'fixtures',
  'host-stats.json',
);

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

function runCli(codingAgent: string, args: string[]) {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv['QUORUM_SUPERPOWERS_REV'];
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run',
      scenario(),
      '--coding-agent',
      codingAgent,
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      outRoot,
      ...args,
    ],
    {
      env: {
        ...childEnv,
        QUORUM_LIVE_SPEND_LOCK: SPEND_LOCK,
        QUORUM_HOST_STATS_PROBE_FIXTURE: HOST_STATS_FIXTURE,
        PATH: `${mockGauntletDir('pass')}:${MOCK}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
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

function soleRunDir(outRoot: string): string {
  const runs = readdirSync(outRoot).filter((d) => !d.startsWith('.'));
  expect(runs.length).toBe(1);
  return join(outRoot, runs[0] ?? '');
}

function readVerdict(runDir: string): { provenance: { effort: unknown } } {
  return JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8'));
}

test('--effort xhigh on claude stamps the requested level into provenance and reaches the run env file', () => {
  const r = runCli('claude', ['--effort', 'xhigh']);
  expect(r.status).toBe(0);
  const runDir = soleRunDir(r.outRoot);
  expect(readVerdict(runDir).provenance.effort).toBe('xhigh');
  // The runner -> RunHome seam: provisioning only sees the level through
  // RunHome.effort, so the env file proves the threading, not just the stamp.
  const envFile = readFileSync(
    join(runDir, 'home', '.claude', '.claude-env'),
    'utf8',
  );
  expect(envFile.endsWith("CLAUDE_CODE_EFFORT_LEVEL='xhigh'\n")).toBe(true);
});

test('no --effort leaves provenance effort null', () => {
  const r = runCli('claude', []);
  expect(r.status).toBe(0);
  expect(readVerdict(soleRunDir(r.outRoot)).provenance.effort).toBeNull();
});

test('--effort on a harness without an effort control is refused before any run dir exists', () => {
  const r = runCli('pi', ['--effort', 'high']);
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(
    /--effort high refused: harness pi has no effort control/,
  );
  expect(readdirSync(r.outRoot).filter((d) => !d.startsWith('.'))).toEqual([]);
});

test('--effort with a level the family rejects is refused with the accepted list', () => {
  const r = runCli('claude', ['--effort', 'minimal']);
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(
    /harness claude does not accept effort minimal \(accepts low, medium, high, xhigh, max\)/,
  );
});

test('--effort with the windows target is refused before any run dir exists', () => {
  const r = runCli('claude', ['--effort', 'xhigh', '--os', 'windows']);
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(
    /--effort is unsupported on the windows target/,
  );
  expect(readdirSync(r.outRoot).filter((d) => !d.startsWith('.'))).toEqual([]);
});
