import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { newFilesSince, snapshotDir } from '../src/capture/index.ts';
import { envSnapshot } from '../src/env.ts';
import {
  collectHistory,
  type DiscoveryHarness,
  type HistoryInstall,
  installHistory,
} from '../src/experiments/session-discovery-fixtures.ts';

const CLI = resolve(
  import.meta.dir,
  '..',
  'src',
  'cli',
  'session-discovery-fixtures.ts',
);

const STORE_ROOTS: Record<DiscoveryHarness, string> = {
  claude: '.claude/projects',
  codex: '.codex/sessions',
  pi: '.pi/agent/sessions',
};

const LOG_GLOBS: Record<DiscoveryHarness, string> = {
  claude: '**/*.jsonl',
  codex: '**/rollout-*.jsonl',
  pi: '**/*.jsonl',
};

const AUTH_PATHS: Record<DiscoveryHarness, string> = {
  claude: '.claude/.credentials.json',
  codex: '.codex/auth.json',
  pi: '.pi/agent/auth.json',
};

const NATIVE_PATHS: Record<DiscoveryHarness, readonly string[]> = {
  claude: [
    '-tmp-project/target-session.jsonl',
    '-tmp-project/decoy-a.jsonl',
    '-tmp-other/decoy-b.jsonl',
  ],
  codex: [
    '2026/09/09/rollout-target-session.jsonl',
    '2026/09/08/rollout-decoy-a.jsonl',
    '2026/09/07/rollout-decoy-b.jsonl',
  ],
  pi: [
    '--tmp-project--/2026-09-09_target-session.jsonl',
    '--tmp-project--/2026-09-08_decoy-a.jsonl',
    '--tmp-other--/2026-09-07_decoy-b.jsonl',
  ],
};

const FIRST_HISTORY_SHA256: Record<DiscoveryHarness, string> = {
  claude: 'a65645a97fff7658a1148303fc24c9d73896e99e556bda83cc583f2bbe7d5cd7',
  codex: 'aeefb5f08102ca350b010e1a1c5680fe74d9a4f684f2f9ba10a5e4e9e7da59ee',
  pi: '791cff280ee9258777a0a7b6491d276fe8d4b78c83d3e68d003daa4f21eefdd7',
};

interface InstallFixture {
  root: string;
  args: HistoryInstall;
  authPath: string;
  logDir: string;
  paths: readonly string[];
}

function makeInstallFixture(agent: DiscoveryHarness): InstallFixture {
  const root = mkdtempSync(join(tmpdir(), `session-discovery-${agent}-`));
  const home = join(root, 'home');
  const workdir = join(root, 'workdir');
  const sourceDir = join(root, 'neutral-corpus');
  const authPath = join(home, AUTH_PATHS[agent]);
  const paths = NATIVE_PATHS[agent];
  mkdirSync(workdir, { recursive: true });
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, 'auth-sentinel');
  for (const [index, relativePath] of paths.entries()) {
    const path = join(sourceDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ synthetic: true, agent, session: index + 1 })}\n`,
    );
  }
  return {
    root,
    args: { agent, home, workdir, sourceDir },
    authPath,
    logDir: join(home, STORE_ROOTS[agent]),
    paths,
  };
}

function readTree(root: string, relativePaths: readonly string[]): string[] {
  return relativePaths.map((relativePath) =>
    readFileSync(join(root, relativePath), 'utf8'),
  );
}

test.each([
  'claude',
  'codex',
  'pi',
] as const)('%s preserves provisioned files and installs three histories', (agent) => {
  const f = makeInstallFixture(agent);
  try {
    const files = installHistory(f.args);
    expect(files).toHaveLength(3);
    expect(files.map((file) => file.relativePath)).toEqual([...f.paths].sort());
    expect(files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(
      true,
    );
    expect(files.find((file) => file.relativePath === f.paths[0])?.sha256).toBe(
      FIRST_HISTORY_SHA256[agent],
    );
    expect(readTree(f.logDir, f.paths)).toEqual(
      readTree(f.args.sourceDir, f.paths),
    );
    expect(readFileSync(f.authPath, 'utf8')).toBe('auth-sentinel');
    expect(readdirSync(f.args.workdir)).toEqual([]);
    const snapshot = snapshotDir(f.logDir, LOG_GLOBS[agent]);
    expect(snapshot.size).toBe(3);
    expect(newFilesSince(f.logDir, LOG_GLOBS[agent], snapshot)).toEqual([]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.each([
  'claude',
  'codex',
  'pi',
] as const)('%s snapshot excludes installed histories and collection excludes the new run', (agent) => {
  const f = makeInstallFixture(agent);
  try {
    const installed = installHistory(f.args);
    const snapshot = snapshotDir(f.logDir, LOG_GLOBS[agent]);
    const evaluationName =
      agent === 'codex' ? 'rollout-evaluation.jsonl' : 'evaluation.jsonl';
    const evaluationPath = join(f.logDir, 'new-run', evaluationName);
    mkdirSync(dirname(evaluationPath), { recursive: true });
    writeFileSync(evaluationPath, 'synthetic-new-evaluation-log\n');

    expect(newFilesSince(f.logDir, LOG_GLOBS[agent], snapshot)).toEqual([
      evaluationPath,
    ]);

    const outputDir = join(f.args.workdir, 'retained-history');
    expect(collectHistory({ ...f.args, outputDir })).toEqual(installed);
    expect(readTree(outputDir, f.paths)).toEqual(
      readTree(f.args.sourceDir, f.paths),
    );
    expect(snapshotDir(outputDir, '**/*.jsonl').size).toBe(3);
    expect(
      snapshotDir(outputDir, '**/*.jsonl').has('new-run/evaluation.jsonl'),
    ).toBe(false);
    expect(readFileSync(f.authPath, 'utf8')).toBe('auth-sentinel');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('collection fails before publishing when installed history bytes changed', () => {
  const f = makeInstallFixture('codex');
  try {
    installHistory(f.args);
    writeFileSync(join(f.logDir, f.paths[0]!), 'tampered\n');
    const outputDir = join(f.args.workdir, 'retained-history');

    expect(() => collectHistory({ ...f.args, outputDir })).toThrow(
      /changed bytes/,
    );
    expect(() => readdirSync(outputDir)).toThrow();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('installer rejects a corpus symlink instead of copying a file outside sourceDir', () => {
  const f = makeInstallFixture('claude');
  try {
    const outside = join(f.root, 'outside.jsonl');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(f.args.sourceDir, 'escaped.jsonl'));

    expect(() => installHistory(f.args)).toThrow(
      /regular files and directories/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('installer rejects a destination symlink instead of copying outside home', () => {
  const f = makeInstallFixture('claude');
  try {
    const outside = join(f.root, 'outside-store');
    mkdirSync(outside);
    mkdirSync(join(f.args.home, '.claude'), { recursive: true });
    symlinkSync(outside, f.logDir);

    expect(() => installHistory(f.args)).toThrow(
      /destination path contains a symbolic link/,
    );
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('collection rejects an output directory outside the workdir', () => {
  const f = makeInstallFixture('pi');
  try {
    installHistory(f.args);
    expect(() =>
      collectHistory({ ...f.args, outputDir: join(f.root, 'outside-output') }),
    ).toThrow(/outputDir must be beneath workdir/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.each([
  'claude',
  'codex',
  'pi',
] as const)('%s CLI install and collect use the setup and post-check environment seams', (agent) => {
  const f = makeInstallFixture(agent);
  try {
    const install = spawnSync('bun', [CLI, 'install', f.args.sourceDir], {
      env: {
        ...envSnapshot(),
        HOME: join(f.root, 'operator-home-must-not-be-used'),
        QUORUM_CODING_AGENT: f.args.agent,
        QUORUM_CODING_AGENT_HOME: f.args.home,
        QUORUM_WORKDIR: f.args.workdir,
      },
      encoding: 'utf8',
    });
    expect({ status: install.status, stderr: install.stderr }).toEqual({
      status: 0,
      stderr: '',
    });

    const outputDir = join(f.args.workdir, 'collected');
    const collect = spawnSync(
      'bun',
      [CLI, 'collect', f.args.sourceDir, outputDir],
      {
        env: {
          ...envSnapshot(),
          HOME: join(f.root, 'operator-home-must-not-be-used'),
          QUORUM_CODING_AGENT: f.args.agent,
          QUORUM_AGENT_CONFIG_DIR: join(
            f.args.home,
            ...(agent === 'pi' ? ['.pi', 'agent'] : [`.${agent}`]),
          ),
          QUORUM_WORKDIR: f.args.workdir,
        },
        encoding: 'utf8',
      },
    );
    expect({ status: collect.status, stderr: collect.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    expect(readTree(outputDir, f.paths)).toEqual(
      readTree(f.args.sourceDir, f.paths),
    );
    expect(readFileSync(f.authPath, 'utf8')).toBe('auth-sentinel');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
