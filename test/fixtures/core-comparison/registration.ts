import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  defaultCommandRunner,
} from '../../../src/agents/command-runner.ts';
import type {
  HostStats,
  HostStatsProbe,
} from '../../../src/campaign/host-stats.ts';
import type { ProcessIdentityProbe } from '../../../src/campaign/locks.ts';
import type { RegisterArgs as ExperimentRegisterArgs } from '../../../src/campaign/registration.ts';
import { FakeClock } from '../../../src/scheduler/clock.ts';

const GiB = 2 ** 30;

const LOCAL_IDENTITY: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 1,
};
const FAKE_STATS: HostStats = {
  ts_ms: 0,
  load1: 0.1,
  pid_max: 1_000_000,
  mem_available_bytes: 8 * GiB,
  mem_total_bytes: 16 * GiB,
  swap_used_bytes: 0,
  swap_total_bytes: 4 * GiB,
  process_count: 200,
  disk_free_bytes: 50 * GiB,
  disk_total_bytes: 100 * GiB,
};
const FAKE_PROBE: HostStatsProbe = {
  sample: (nowMs) => ({ ...FAKE_STATS, ts_ms: nowMs }),
};

function git(dir: string, args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** A real tmp evals checkout at one commit: arms/, credentials.yaml,
 *  coding-agents/claude.yaml, scenarios/scn-a, and a stub CLI entrypoint. */
function evalsRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'evals-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(
    join(dir, 'credentials.yaml'),
    [
      'cred_a:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_KEY',
      '  max_concurrency: 8',
      'cred_g:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_GRADER',
      '  max_concurrency: 8',
      'cred_b:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_KEY_B',
      '  max_concurrency: 8',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'arms'), { recursive: true });
  writeFileSync(
    join(dir, 'arms', 'arm_a.yaml'),
    [
      'schema_version: 1',
      'name: arm_a',
      'agent: claude',
      'credential: cred_a',
      'superpowers: none',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'arms', 'arm_b.yaml'),
    [
      'schema_version: 1',
      'name: arm_b',
      'agent: claude',
      'credential: cred_b',
      'superpowers: none',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'coding-agents'), { recursive: true });
  writeFileSync(
    join(dir, 'coding-agents', 'claude.yaml'),
    [
      'name: claude',
      'runtime_family: claude',
      'binary: claude',
      'model: claude-test',
      'home_config_subdir: .claude',
      'session_log_dir: .claude/projects',
      "session_log_glob: '**/*.jsonl'",
      'normalizer: claude',
      'default_credential: cred_a',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'scenarios', 'scn-a'), { recursive: true });
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'story.md'),
    '---\nquorum_tier: full\n---\nDo the thing.\n',
  );
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'setup.sh'),
    '#!/usr/bin/env bash\n:\n',
  );
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'checks.sh'),
    'pre() { :; }\npost() { :; }\n',
  );
  mkdirSync(join(dir, 'src', 'cli'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'cli', 'index.ts'),
    "if (process.argv.includes('--version')) console.log('quorum-test 0.0.0');\n",
  );
  commitWithLockfile(dir); // the snapshot's bun install --frozen-lockfile needs a committed lockfile
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

const EXPERIMENT_SUITE_RAW = [
  'schema_version: 2',
  'name: finite_comparison',
  'reserve: 1',
  'max_exposure_skew: 30',
  'attempt_bounds: { max_attempts: 2, max_time_s: 300 }',
  'grader: { credential: cred_g, model: test-model }',
  'comparisons:',
  '  - baseline: arm_a',
  '    treatment: arm_b',
  '    scenarios: [scn-a]',
  '    n: 1',
  '',
].join('\n');

function experimentRegisterArgs(
  overrides: Partial<ExperimentRegisterArgs> = {},
): ExperimentRegisterArgs {
  const evals = evalsRepo();
  const gauntlet = gauntletRepo();
  return {
    suitePath: 'suites/finite_comparison.yaml',
    suiteRaw: EXPERIMENT_SUITE_RAW,
    campaignsRoot: mkdtempSync(join(tmpdir(), 'experiment-campaigns-')),
    globalCap: 8,
    evalsCheckout: evals.dir,
    evalsRef: evals.sha,
    gauntletCheckout: gauntlet.dir,
    gauntletRef: gauntlet.sha,
    superpowersCheckout: mkdtempSync(join(tmpdir(), 'sp-')),
    runner: probeRunner(0),
    clock: new FakeClock(1),
    identity: LOCAL_IDENTITY,
    probe: FAKE_PROBE,
    registeredBy: 'test',
    nowMs: Date.parse('2026-09-04T12:00:00Z'),
    ...overrides,
  };
}

/** Give a fixture repo a dependency-less package.json + lockfile and commit
 *  everything — materializeEvalsSnapshot runs `bun install
 *  --frozen-lockfile` in every checked-out tree. */
function commitWithLockfile(dir: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
  );
  const installed = spawnSync('bun', ['install'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (installed.status !== 0)
    throw new Error(`fixture bun install failed: ${installed.stderr}`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'fixture']);
}

function gauntletRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), 'gauntlet fixture\n');
  commitWithLockfile(dir);
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

/** Real runner everywhere EXCEPT the merge-base child-contract check, which
 *  the fixture repo cannot contain (the real D2 merge SHA). The fake answers
 *  that one call; everything else runs for real. */
function probeRunner(mergeBaseStatus: 0 | 1): CommandRunner {
  return {
    run(
      command: string,
      args: readonly string[],
      options?: CommandOptions,
    ): CommandResult {
      if (command === 'git' && args.includes('merge-base')) {
        return {
          status: mergeBaseStatus,
          stdout: '',
          stderr: mergeBaseStatus === 0 ? '' : 'not an ancestor\n',
        };
      }
      return defaultCommandRunner.run(command, args, options);
    },
  };
}

export {
  EXPERIMENT_SUITE_RAW,
  experimentRegisterArgs,
  FAKE_PROBE,
  probeRunner,
};
