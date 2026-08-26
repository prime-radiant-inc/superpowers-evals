import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildChildRunArgs, invokeChild } from '../src/run-all/index.ts';
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
  // QUORUM_SUPERPOWERS_REV is host-exported by the evals-container wrapper,
  // and an explicit superpowers mode makes it a hard run-start error — a
  // polluted host env would fail every explicit-mode case (and flip the legacy
  // provenance probe) for a reason no test chose. Strip it from the inherited
  // env (never from process.env itself); envExtra reintroduces it only where a
  // test means to.
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv['QUORUM_SUPERPOWERS_REV'];
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
        ...childEnv,
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
  // for provenance nor for the required-env gate.
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
  expect(launcher).toContain(`--plugin-dir '${dir}'`);
});

test('--no-superpowers: provenance null, launcher elides plugin flags, no ambient demanded', () => {
  const r = runCli(['--no-superpowers'], { SUPERPOWERS_ROOT: '' });
  // SUPERPOWERS_ROOT='' in envExtra overrides the harness seed with an empty
  // value, proving none mode does not demand the ambient var.
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
// exactly its flag pair. The internal entrypoint is pinned exactly — it is
// the contract the D-5 re-entry test exercises across checkouts.
test('buildChildRunArgs: legacy argv unchanged; superpowers flags forwarded when set', () => {
  const base = {
    scenarioDir: '/s',
    codingAgent: 'claude',
    codingAgentsDir: '/a',
    outRoot: '/o',
  };
  // macOS paths may differ by symlink or trailing slash — compare normalized.
  // The `?? ''` mirrors the sole-verdict reader: a missing element fails the
  // pinned-entry assertion below rather than escaping as undefined.
  const norm = (p: string) => realpathSync(p.replace(/\/+$/, ''));
  const legacy = buildChildRunArgs(base);
  const entry = legacy[0] ?? '';
  expect(norm(entry)).toBe(norm(RUN_CHILD));
  expect(legacy).toEqual([
    entry,
    '/s',
    '--coding-agent',
    'claude',
    '--coding-agents-dir',
    '/a',
    '--out-root',
    '/o',
  ]);
  expect(buildChildRunArgs({ ...base, superpowersRoot: '/srv/sp' })).toEqual([
    entry,
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
    entry,
    '/s',
    '--coding-agent',
    'claude',
    '--coding-agents-dir',
    '/a',
    '--out-root',
    '/o',
    '--no-superpowers',
  ]);
  expect(buildChildRunArgs({ ...base, noSuperpowers: false })).toEqual(legacy);
  // SnapshotHandle.gauntletBin forwards as --gauntlet-bin, ahead of the
  // superpowers flags — without it a snapshot-driven child would silently
  // fall back to the PATH gauntlet while verifySnapshot stays green.
  expect(
    buildChildRunArgs({ ...base, gauntletBin: '/snap/bin/gauntlet' }),
  ).toEqual([
    entry,
    '/s',
    '--coding-agent',
    'claude',
    '--coding-agents-dir',
    '/a',
    '--out-root',
    '/o',
    '--gauntlet-bin',
    '/snap/bin/gauntlet',
  ]);
  expect(
    buildChildRunArgs({
      ...base,
      gauntletBin: '/snap/bin/gauntlet',
      superpowersRoot: '/srv/sp',
    }),
  ).toEqual([
    entry,
    '/s',
    '--coding-agent',
    'claude',
    '--coding-agents-dir',
    '/a',
    '--out-root',
    '/o',
    '--gauntlet-bin',
    '/snap/bin/gauntlet',
    '--superpowers-root',
    '/srv/sp',
  ]);
});

// The end-to-end half of the forwarding contract: an invoked child (the real
// builder + spawn path) must drive the forwarded wrapper, never the bare
// `gauntlet` name — a decoy first on PATH would otherwise run a healthy-
// looking eval on the wrong instrument.
test('invokeChild forwards gauntletBin: the child runs the wrapper, never the PATH gauntlet', async () => {
  const mockDir = mockGauntletDir('pass');
  const bin = mkdtempSync(join(tmpdir(), 'snapbin-'));
  const wrapperMarker = join(bin, 'wrapper-ran');
  const decoyMarker = join(bin, 'decoy-ran');
  // Snapshot-style wrapper: marks itself, then execs the mock gauntlet.
  const wrapper = join(bin, 'gauntlet-snapshot');
  writeFileSync(
    wrapper,
    `#!/bin/sh\necho ran > '${wrapperMarker}'\nexec '${join(mockDir, 'gauntlet')}' "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  // Decoy under the bare name, FIRST on PATH — also a working mock, so a
  // fallback run would complete green while running the wrong instrument.
  const decoyDir = mkdtempSync(join(tmpdir(), 'decoy-'));
  writeFileSync(
    join(decoyDir, 'gauntlet'),
    `#!/bin/sh\necho ran > '${decoyMarker}'\nexec '${join(mockDir, 'gauntlet')}' "$@"\n`,
  );
  chmodSync(join(decoyDir, 'gauntlet'), 0o755);
  const result = await invokeChild({
    scenarioDir: scenario(),
    codingAgent: 'claude',
    codingAgentsDir: REAL_CODING_AGENTS,
    outRoot: mkdtempSync(join(tmpdir(), 'out-')),
    credentialsPath: REPO_CREDENTIALS,
    gauntletBin: wrapper,
    extraEnv: {
      PATH: `${decoyDir}:${MOCK}:${process.env['PATH'] ?? ''}`,
      ANTHROPIC_API_KEY: 'sk-test',
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
      SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
    },
  });
  expect(result.error).toBeNull();
  expect(existsSync(wrapperMarker)).toBe(true);
  expect(existsSync(decoyMarker)).toBe(false);
}, 60000);

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
// the instrument-snapshot mechanism rests on it. The second checkout is a
// detached worktree at HEAD carrying a startup marker injected locally by
// this test (content, not history, is the discriminator — no ancestor-count
// or repo-depth dependency). Proven at both layers: the worktree's own
// buildChildRunArgs must name the worktree's run-child (the entry derives
// from the executing module's URL, never from the spawner's checkout), and
// spawning that generated entrypoint must exhibit the marker only the
// worktree's copy prints.
test('D-5: a child executing another checkout reports THAT checkout as root', () => {
  const repo = resolve(import.meta.dir, '..');
  const wt = mkdtempSync(join(tmpdir(), 'reentry-'));
  const marker = `d5-child-marker-${randomUUID()}`;
  // macOS tmpdir is a symlink (/var → /private/var) and derived paths may or
  // may not carry a trailing slash — compare realpath-normalized, slash-
  // trimmed.
  const norm = (p: string) => realpathSync(p.replace(/\/+$/, ''));
  let removeStatus: number | null = null;
  let registered = false;
  try {
    // Detached at HEAD: always available, no history-depth requirement. The
    // worktree's content differs from the originating checkout exactly by the
    // marker injected below.
    const add = spawnSync('git', ['worktree', 'add', '--detach', wt], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(add.status).toBe(0);
    registered = add.status === 0;
    // buildChildRunArgs imports commander/zod, so the worktree needs its own
    // install; asserting it keeps a broken install from masquerading as a
    // re-entry failure. Inside the try: a failed install still cleans up the
    // registered worktree in the finally below.
    const install = spawnSync('bun', ['install', '--frozen-lockfile'], {
      cwd: wt,
      encoding: 'utf8',
    });
    expect(install.status).toBe(0);
    // The discriminator: a startup line that exists ONLY in the worktree's
    // copy of the internal parser. The parse line is the file's stable tail;
    // the count assertion fails loud if that shape ever drifts.
    const runChildPath = join(wt, 'src', 'cli', 'run-child.ts');
    const parseLine = 'await program.parseAsync(process.argv);';
    const source = readFileSync(runChildPath, 'utf8');
    expect(source.split(parseLine).length - 1).toBe(1);
    writeFileSync(
      runChildPath,
      source.replace(parseLine, `console.error('${marker}');\n${parseLine}`),
    );
    // Layer 1 (module): the worktree's own argv builder names the worktree's
    // run-child — never the originating checkout's.
    const entry = spawnSync(
      'bun',
      [
        '-e',
        'import { buildChildRunArgs } from "./src/run-all/index.ts"; ' +
          'console.log(buildChildRunArgs({ scenarioDir: "/s", codingAgent: "claude", codingAgentsDir: "/a", outRoot: "/o" })[0]);',
      ],
      { cwd: wt, encoding: 'utf8' },
    );
    expect(entry.status).toBe(0);
    expect(norm(entry.stdout.trim())).toBe(norm(runChildPath));
    expect(norm(entry.stdout.trim())).not.toBe(norm(RUN_CHILD));
    // Layer 2 (execution): spawning the generated entrypoint runs THAT
    // checkout's parser — the marker appears in its stderr output only if the
    // worktree's (modified) copy executed; the originating checkout's parser
    // never prints it.
    const child = spawnSync(
      'bun',
      [
        entry.stdout.trim(),
        'missing-scenario',
        '--coding-agent',
        'claude',
        '--coding-agents-dir',
        '/nonexistent-coding-agents',
        '--out-root',
        mkdtempSync(join(tmpdir(), 'out-')),
        '--credentials-file',
        REPO_CREDENTIALS,
      ],
      { cwd: wt, encoding: 'utf8' },
    );
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(marker);
  } finally {
    // Cleanup runs on every exit path (setup failure included, tracked by
    // `registered`) and removes exactly this test's worktree — never a
    // repository-wide prune. A failed removal is surfaced on stderr here, so
    // it is visible even when the body already threw, and recorded for the
    // assertion below.
    if (registered) {
      const remove = spawnSync('git', ['worktree', 'remove', '--force', wt], {
        cwd: repo,
      });
      removeStatus = remove.status;
      if (removeStatus !== 0) {
        process.stderr.write(
          `D-5 cleanup failed: git worktree remove exited ${removeStatus} (${wt})\n`,
        );
      }
    }
  }
  expect(removeStatus).toBe(0);
});
