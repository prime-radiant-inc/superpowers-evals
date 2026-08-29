// test/campaign-lock-threading.test.ts — R-LCK-2 surface (a), per C12c: the
// three spender entrypoints (direct `quorum run`, `run-all`, `campaign run`)
// are SUBPROCESS-LAUNCHED and must each refuse while a live holder holds the
// one host-wide live-spend lock, naming the holder. Calling acquireLiveSpendLock
// directly proves nothing about the verb wiring, so only the HOLDER uses the
// library call. The full-batch test proves the other half: run-all's own
// children are covered by its lock (the explicit marker channel) and run to
// completion under it. Hermetic — tmp git fixtures, the mock-gauntlet harness,
// no network, no credentials, no live evals.
import { expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readLiveSpendHolder } from '../src/campaign/locks.ts';
import { envSnapshot } from '../src/env.ts';
import { publishedCampaign } from './campaign-recovery-fixtures.ts';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');
// run (and run-all children) require an explicit --credentials-file; the
// repo's canonical registry carries claude's default_credential (same pattern
// as test/campaign-identity-intake.test.ts).
const REPO_CREDENTIALS = resolve(import.meta.dir, '..', 'credentials.yaml');
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');
const LOCKS_TS = resolve(import.meta.dir, '..', 'src', 'campaign', 'locks.ts');
const CLOCK_TS = resolve(import.meta.dir, '..', 'src', 'scheduler', 'clock.ts');
const LOCK = join(mkdtempSync(join(tmpdir(), 'lock-')), 'live.lock.d');

function sleep(ms: number): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, ms);
  return promise;
}

// Real-subprocess readiness: the holder is a separate OS process, so no
// in-process fake timer can advance the condition — poll the lock's owner
// token (the same readiness gate the cli-run-sigint pattern uses).
async function pollFor<T>(
  predicate: () => T | undefined,
  deadlineMs: number,
  stepMs = 50,
): Promise<T | undefined> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = predicate();
    if (v !== undefined) return v;
    if (Date.now() >= end) return undefined;
    await sleep(stepMs);
  }
}

/** A holder subprocess that acquires the lock at LOCK and sleeps. The holder
 * is the ONE place a direct library call is used — the contention behavior
 * under test is what the entrypoints do about it. */
function startHolder(): { child: ChildProcess; holderPid: () => number } {
  const script = `
    import { acquireLiveSpendLock, realProcessIdentityProbe } from '${LOCKS_TS}';
    import { RealClock } from '${CLOCK_TS}';
    const lock = acquireLiveSpendLock({
      lockPath: '${LOCK}',
      campaignId: 'holder',
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
    });
    console.log('held');
    await Bun.sleep(60_000);
    lock.release();
  `;
  const child = spawn('bun', ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...envSnapshot(), QUORUM_LIVE_SPEND_LOCK: LOCK },
  });
  return { child, holderPid: () => readLiveSpendHolder(LOCK)?.pid ?? -1 };
}

function scenario(): string {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(
    join(scn, 'story.md'),
    '---\nquorum_tier: full\nquorum_max_time: 1m\n---\nDo the thing.',
  );
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scn;
}

/** A published campaign dir + snapshot credentials: enough for the run verb
 * to reach (and refuse at) live-spend acquisition. */
function campaignFixture(): string {
  const fx = publishedCampaign({ inFlight: false });
  mkdirSync(join(fx.dir, 'evals'), { recursive: true });
  writeFileSync(
    join(fx.dir, 'evals', 'credentials.yaml'),
    [
      'grader_cred:',
      '  model: grader-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: KEY_G',
      '',
    ].join('\n'),
  );
  return fx.dir;
}

function git(dir: string, args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function gauntletRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), 'gauntlet fixture\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'fixture']);
  return dir;
}

const GAUNTLET_ROOT = gauntletRepo();
const SUPERPOWERS_ROOT = mkdtempSync(join(tmpdir(), 'sproot-'));

/** The spender env: hermetic lock path, resolved checkout seams, mock
 * gauntlet on PATH, fixture keys (the mock never makes a real call), and
 * the passing host-stats fixture — the preflight itself is never skipped
 * (R-LCK-2: production uses the real Linux probe; portable tests inject a
 * passing probe through the fixture seam). */
const HOST_STATS_FIXTURE = resolve(
  import.meta.dir,
  'fixtures',
  'host-stats.json',
);

function spenderEnv(
  lock: string,
  opts: { hostStatsFixture?: string } = {},
): Record<string, string | undefined> {
  const snapshot = envSnapshot();
  return {
    ...snapshot,
    QUORUM_LIVE_SPEND_LOCK: lock,
    QUORUM_HOST_STATS_PROBE_FIXTURE:
      opts.hostStatsFixture ?? HOST_STATS_FIXTURE,
    GAUNTLET_ROOT,
    SUPERPOWERS_ROOT,
    PATH: `${mockGauntletDir('pass')}:${MOCK}:${snapshot['PATH'] ?? ''}`,
    ANTHROPIC_API_KEY: 'sk-test',
    AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
  };
}

/** A below-floors host-stats fixture (disk free 1 byte): acquisition
 * succeeds, the floors preflight must refuse. */
function belowFloorsFixture(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'hs-')), 'below.json');
  writeFileSync(
    path,
    JSON.stringify({
      load1: 0.1,
      mem_available_bytes: 8589934592,
      mem_total_bytes: 17179869184,
      swap_used_bytes: 0,
      swap_total_bytes: 4294967296,
      process_count: 200,
      pid_max: 1000000,
      disk_free_bytes: 1,
      disk_total_bytes: 107374182400,
    }),
  );
  return path;
}

interface BatchRow {
  run_id?: string | null;
}

test('the three spender entrypoints all refuse while a live holder holds, naming it (R-LCK-2, C12c)', async () => {
  const { child, holderPid } = startHolder();
  try {
    const pid = await pollFor(
      () => (readLiveSpendHolder(LOCK) !== null ? holderPid() : undefined),
      15_000,
    );
    expect(pid).toBeDefined();
    expect(pid).toBeGreaterThan(0);
    const refusal = new RegExp(`held by pid ${pid}`);

    // 1. Direct `quorum run`.
    const direct = spawnSync(
      'bun',
      [
        CLI,
        'run',
        scenario(),
        '--coding-agent',
        'claude',
        '--coding-agents-dir',
        REAL_CODING_AGENTS,
        '--out-root',
        mkdtempSync(join(tmpdir(), 'out-')),
        '--credentials-file',
        REPO_CREDENTIALS,
      ],
      { encoding: 'utf8', env: spenderEnv(LOCK), timeout: 60_000 },
    );
    expect(direct.status).not.toBe(0);
    expect(direct.stderr).toMatch(refusal);

    // 2. `run-all` (empty matrix — acquisition precedes scheduling).
    const emptyRoot = mkdtempSync(join(tmpdir(), 'scnroot-'));
    const batch = spawnSync(
      'bun',
      [
        CLI,
        'run-all',
        '--scenarios-root',
        emptyRoot,
        '--coding-agents-dir',
        REAL_CODING_AGENTS,
        '--out-root',
        mkdtempSync(join(tmpdir(), 'out-')),
        '--jobs',
        '1',
      ],
      { encoding: 'utf8', env: spenderEnv(LOCK), timeout: 60_000 },
    );
    expect(batch.status).not.toBe(0);
    expect(batch.stderr).toMatch(refusal);

    // 3. `campaign run` (published fixture; refuses at acquisition,
    //    before any reconcile/preflight work).
    const campaign = spawnSync(
      'bun',
      [CLI, 'campaign', 'run', campaignFixture()],
      { encoding: 'utf8', env: spenderEnv(LOCK), timeout: 60_000 },
    );
    expect(campaign.status).not.toBe(0);
    expect(campaign.stderr).toMatch(refusal);
  } finally {
    child.kill('SIGKILL');
  }
}, 120_000);

test('run-all drives a full batch whose children are covered by its lock (children never acquire)', () => {
  // One runnable cell through the mock gauntlet. run-all holds the
  // live-spend lock for the whole drive; its children carry the
  // children-never-acquire marker, so the child completes instead of
  // refusing against its own parent. Without the marker the child would
  // die on the lock and no run dir would appear. The canonical (no-flag)
  // credentials route snapshots the repo registry without the strict
  // campaign-credential check an explicit --credentials-file triggers.
  const lock = join(mkdtempSync(join(tmpdir(), 'lock-')), 'live.lock.d');
  const scenariosRoot = mkdtempSync(join(tmpdir(), 'scnroot-'));
  spawnSync('cp', ['-R', scenario(), join(scenariosRoot, 'scn-a')]);
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  const res = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--scenarios-root',
      scenariosRoot,
      '--coding-agents',
      'claude',
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      outRoot,
      '--jobs',
      '1',
    ],
    { encoding: 'utf8', env: spenderEnv(lock), timeout: 120_000 },
  );
  expect(res.status).toBe(0);
  // The batch record carries the child's run-id (parsed from the child's
  // `run-id:` line) and the run dir holds a terminal verdict.
  const batchDir = readdirSync(join(outRoot, 'batches'))
    .filter((d) => d.startsWith('batch-'))
    .map((d) => join(outRoot, 'batches', d))[0];
  expect(batchDir).toBeDefined();
  const rows: BatchRow[] = readFileSync(
    join(batchDir!, 'results.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as BatchRow);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.run_id ?? '').toMatch(/scn-a-claude/);
  const runDir = join(outRoot, rows[0]?.run_id ?? '');
  const verdict: { final?: string } = JSON.parse(
    readFileSync(join(runDir, 'verdict.json'), 'utf8'),
  ) as { final?: string };
  expect(verdict.final).toBe('pass');
}, 150_000);

test('a floors refusal refuses the direct-run launch AND releases the acquired lock (R-LCK-2)', () => {
  // The acquire -> preflight -> run order with release in the finally: a
  // below-floors host must never launch a paid run, and the refusal must
  // not strand the host-wide lock until heartbeat staleness.
  const lock = join(mkdtempSync(join(tmpdir(), 'lock-')), 'live.lock.d');
  const direct = spawnSync(
    'bun',
    [
      CLI,
      'run',
      scenario(),
      '--coding-agent',
      'claude',
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      mkdtempSync(join(tmpdir(), 'out-')),
      '--credentials-file',
      REPO_CREDENTIALS,
    ],
    {
      encoding: 'utf8',
      env: spenderEnv(lock, { hostStatsFixture: belowFloorsFixture() }),
      timeout: 60_000,
    },
  );
  expect(direct.status).not.toBe(0);
  expect(direct.stderr).toContain('resource-floor preflight failed');
  expect(readLiveSpendHolder(lock)).toBeNull();
}, 120_000);

test('a floors refusal refuses the run-all launch AND releases the acquired lock (R-LCK-2)', () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'lock-')), 'live.lock.d');
  const emptyRoot = mkdtempSync(join(tmpdir(), 'scnroot-'));
  const batch = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--scenarios-root',
      emptyRoot,
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      mkdtempSync(join(tmpdir(), 'out-')),
      '--jobs',
      '1',
    ],
    {
      encoding: 'utf8',
      env: spenderEnv(lock, { hostStatsFixture: belowFloorsFixture() }),
      timeout: 60_000,
    },
  );
  expect(batch.status).toBe(1);
  expect(batch.stderr).toContain('resource-floor preflight failed');
  expect(readLiveSpendHolder(lock)).toBeNull();
}, 120_000);
