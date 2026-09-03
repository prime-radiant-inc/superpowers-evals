import { afterAll, expect, test } from 'bun:test';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishAttempt } from '../src/campaign/attempt-publish.ts';
import { AttemptContainerSpawnError } from '../src/campaign/container-spawner.ts';
import {
  type DispatchRunArgs,
  type DispatchSamplerHooks,
  type DispatchSamplerSeam,
  runCampaignDispatch,
} from '../src/campaign/dispatcher.ts';
import {
  electWriter,
  initJournalDb,
  openJournalRead,
} from '../src/campaign/journal.ts';
import type {
  CampaignChildSpec,
  ChildExitInfo,
  SpawnedCampaignChild,
} from '../src/campaign/spawn.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import { campaignDigest } from '../src/contracts/campaign/digest.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { deleteProcessEnv, getEnv, setProcessEnv } from '../src/env.ts';
import { writeAttemptManifest } from '../src/runner/manifest.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

const IDENTITY = {
  exists: () => 'alive' as const,
  startTimeMs: () => 1,
};
const FIXTURE_ENV_KEYS = ['KEY_A', 'KEY_B', 'KEY_G'] as const;
const PRIOR_ENV = new Map<string, string | undefined>(
  FIXTURE_ENV_KEYS.map((key) => [key, getEnv(key)]),
);
setProcessEnv('KEY_A', 'fixture-key-a');
setProcessEnv('KEY_B', 'fixture-key-b');
setProcessEnv('KEY_G', 'fixture-key-g');
afterAll(() => {
  for (const [key, prior] of PRIOR_ENV) {
    if (prior === undefined) deleteProcessEnv(key);
    else setProcessEnv(key, prior);
  }
});

class RecordingContainerSpawner {
  readonly kind = 'container' as const;
  readonly specs: CampaignChildSpec[] = [];
  readonly stopped: { containerId: string; graceSeconds: number }[] = [];
  readonly spawnedContainerIds: string[] = [];
  readonly spawnedContainerNames: string[] = [];
  failSpawns = false;
  failSpawnOnce = false;
  spawnFailureCleanup: 'verified-absent' | 'unverified' | undefined;
  stopResult: 'dead' | 'alive' = 'dead';
  stopThrows = false;
  readonly failedAttemptIds: string[] = [];
  private readonly exitCallbacks: ((info: ChildExitInfo) => void)[][] = [];
  private readonly stdoutCallbacks: ((line: string) => void)[][] = [];
  readonly attempts = new Map<
    string,
    { attemptDir: string; homeDir: string; stagingDir: string }
  >();

  prepareAttempt(args: { attemptId: string }): {
    attemptId: string;
    attemptDir: string;
    stageDir: string;
    subjectEnvFile: string;
    graderEnvFile: string;
    homeDir: string;
    stdoutLog: string;
    stderrLog: string;
    stagingDir: string;
    passwdFile: string;
    groupFile: string;
  } {
    const attemptDir = join(this.root, args.attemptId);
    const homeDir = join(attemptDir, 'home');
    const stagingDir = join(attemptDir, 'staging');
    const stageDir = join(attemptDir, '.stage');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(stageDir, { recursive: true });
    chmodSync(attemptDir, 0o700);
    chmodSync(homeDir, 0o700);
    chmodSync(stagingDir, 0o700);
    chmodSync(stageDir, 0o700);
    for (const path of [
      join(stageDir, 'subject.env'),
      join(stageDir, 'grader.env'),
      join(stageDir, 'passwd'),
      join(stageDir, 'group'),
      join(attemptDir, 'stdout.log'),
      join(attemptDir, 'stderr.log'),
    ])
      writeFileSync(path, '', { mode: 0o400 });
    const prepared = {
      attemptId: args.attemptId,
      attemptDir,
      stageDir,
      subjectEnvFile: join(stageDir, 'subject.env'),
      graderEnvFile: join(stageDir, 'grader.env'),
      homeDir,
      stdoutLog: join(attemptDir, 'stdout.log'),
      stderrLog: join(attemptDir, 'stderr.log'),
      stagingDir,
      passwdFile: join(stageDir, 'passwd'),
      groupFile: join(stageDir, 'group'),
    };
    this.attempts.set(args.attemptId, { attemptDir, homeDir, stagingDir });
    return prepared;
  }

  private root = '';
  setRoot(root: string): void {
    this.root = root;
  }

  spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
    if (this.failSpawns) {
      const attemptId = spec.attempt?.attemptId ?? '<missing>';
      this.failedAttemptIds.push(attemptId);
      if (this.failSpawnOnce) this.failSpawns = false;
      if (this.spawnFailureCleanup !== undefined) {
        throw new AttemptContainerSpawnError(
          'fixture post-create spawn failure',
          'a'.repeat(64),
          this.spawnFailureCleanup,
        );
      }
      throw new Error('fixture spawn failure');
    }
    this.specs.push(spec);
    const ordinal = this.specs.length - 1;
    const containerId = (ordinal === 0 ? 'a' : 'b').repeat(64);
    const containerName =
      ordinal === 0
        ? 'quorum-attempt-test'
        : `quorum-attempt-test-${ordinal + 1}`;
    this.spawnedContainerIds.push(containerId);
    this.spawnedContainerNames.push(containerName);
    const exits: ((info: ChildExitInfo) => void)[] = [];
    const stdout: ((line: string) => void)[] = [];
    this.exitCallbacks.push(exits);
    this.stdoutCallbacks.push(stdout);
    return {
      handle: {
        kind: 'container',
        containerName,
        containerId,
        imageDigest: `sha256:${'b'.repeat(64)}`,
      },
      stdoutLines: [],
      stderrLines: [],
      onStdoutLine: (cb) => stdout.push(cb),
      onStderrLine: () => {},
      onExit: (cb) => exits.push(cb),
    };
  }

  emitAllocated(index: number, runId: string): void {
    for (const cb of this.stdoutCallbacks[index] ?? [])
      cb(`run_allocated: ${runId}`);
  }

  settleExit(index: number, info: ChildExitInfo): void {
    for (const cb of this.exitCallbacks[index] ?? []) cb(info);
  }

  async stopContainer(
    containerId: string,
    graceSeconds: number,
  ): Promise<'dead' | 'alive'> {
    this.stopped.push({ containerId, graceSeconds });
    if (this.stopThrows) throw new Error('fixture exact-ID stop failure');
    return this.stopResult;
  }
}

function campaignDocument(): Campaign {
  const doc = {
    schema_version: 1,
    campaign_id: '',
    suite: {
      schema_version: 1,
      name: 'testsuite',
      kind: 'gating',
      budget_usd: 50,
      profile: 'release_gate_v1',
      reserve: 1,
      max_exposure_skew: 60,
      profile_params: {
        alpha: 0.05,
        determinate_n_floor: 1,
        completion_divergence_max: 0.5,
        mde_by_scenario: {},
      },
      comparisons: [
        { baseline: 'arm_a', treatment: 'arm_b', scenarios: ['scn'], n: 1 },
      ],
    },
    refs: {
      superpowers_by_arm: { arm_a: null, arm_b: null },
      evals: 'e'.repeat(40),
      gauntlet: '9'.repeat(40),
    },
    grader: { credential: 'grader_cred', model: 'grader-model' },
    cells: [
      {
        scenario: 'scn',
        comparison_id: 'c1',
        arms: ['arm_a', 'arm_b'],
        n: 1,
        class: 'confirmatory',
        coupling: 'arm-independent',
        estimates_by_arm: {
          arm_a: { duration_s: 1, cost_usd: 1, confidence: 'high' },
          arm_b: { duration_s: 1, cost_usd: 1, confidence: 'high' },
        },
      },
    ],
    excluded_cells: [],
    samples: [
      {
        sample_id: 'c1:scn:arm_a:r1',
        cell: 'c1:scn',
        arm: 'arm_a',
        replicate: 1,
      },
      {
        sample_id: 'c1:scn:arm_b:r1',
        cell: 'c1:scn',
        arm: 'arm_b',
        replicate: 1,
      },
      {
        sample_id: 'c1:scn:arm_a:x1',
        cell: 'c1:scn',
        arm: 'arm_a',
        replicate: 1,
      },
      {
        sample_id: 'c1:scn:arm_b:x1',
        cell: 'c1:scn',
        arm: 'arm_b',
        replicate: 1,
      },
    ],
    comparisons: [
      { comparison_id: 'c1', baseline: 'arm_a', treatment: 'arm_b' },
    ],
    blocks: [
      {
        block_id: 'c1:scn:b1',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'],
      },
      {
        block_id: 'c1:scn:x1',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:x1', 'c1:scn:arm_b:x1'],
        slot: 'reserve',
      },
    ],
    budget: {
      usd_all_in: 50,
      surcharge_applied: 0,
      priced_coverage: 1,
      surcharge_formula_version: 1,
    },
    registered_at: '2026-08-26T00:00:00Z',
    registered_by: 'test',
    digest: '',
    contention: {
      host_fingerprint: {
        cpu_model: 'test',
        cpu_cores: 4,
        mem_bytes: 16 * 2 ** 30,
        disk_total_bytes: 100 * 2 ** 30,
      },
      global_run_cap: 2,
      thresholds: [
        { metric: 'load1_per_core', source: 'host', op: 'gt', value: 2 },
      ],
      cadence_ms: 10_000,
      sustain_k: 3,
      coverage_n: 4,
      mem_tolerance_pct: 10,
      disk_tolerance_pct: 10,
    },
    execution_surface: [
      {
        name: 'arm_a',
        agent: 'claude',
        credential: 'cred_a',
        auth: 'api-key',
        api: 'anthropic',
        model: 'm',
        key_env_names: ['KEY_A'],
      },
      {
        name: 'arm_b',
        agent: 'claude',
        credential: 'cred_b',
        auth: 'api-key',
        api: 'anthropic',
        model: 'm',
        key_env_names: ['KEY_B'],
      },
    ],
  } as unknown as Campaign;
  const digest = campaignDigest(doc);
  return { ...doc, campaign_id: digest, digest };
}

function credentials(): Record<string, Credential> {
  const cred = (env: string): Credential => ({
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    api_key_env: env,
    compat: {},
    max_concurrency: 2,
  });
  return {
    cred_a: cred('KEY_A'),
    cred_b: cred('KEY_B'),
    grader_cred: cred('KEY_G'),
  };
}

function harness(
  opts: {
    traceJournal?: boolean;
    publishAttempt?: DispatchRunArgs['publishAttempt'];
    failContentionAppend?: boolean;
    pauseOnBlockReplacement?: boolean;
    pauseOnContentionResolution?: boolean;
  } = {},
): {
  args: DispatchRunArgs;
  campaignDir: string;
  spawner: RecordingContainerSpawner;
  terminalAppendStages: boolean[];
} {
  const campaignDir = realpathSync(
    mkdtempSync(join(tmpdir(), 'container-disp-')),
  );
  initJournalDb(campaignDir);
  writeFileSync(join(campaignDir, '.ballast'), 'x');
  writeFileSync(join(campaignDir, 'contention-telemetry.jsonl'), '');
  mkdirSync(join(campaignDir, 'results'));
  const doc = campaignDocument();
  writeFileSync(join(campaignDir, 'campaign.json'), JSON.stringify(doc));
  const writer = electWriter({
    campaignDir,
    clock: new FakeClock(0),
    identity: IDENTITY,
    campaign: doc,
  });
  writer.appendEvent({
    type: 'campaign_opened',
    payload: { campaign_id: doc.campaign_id, digest: doc.digest },
  });
  if (
    opts.traceJournal !== true &&
    opts.failContentionAppend !== true &&
    opts.pauseOnBlockReplacement !== true &&
    opts.pauseOnContentionResolution !== true
  )
    writer.release();
  const spawner = new RecordingContainerSpawner();
  spawner.setRoot(join(campaignDir, 'attempts'));
  const terminalAppendStages: boolean[] = [];
  let pausedBlockReplacement = false;
  const journal = {
    appendEvent: writer.appendEvent.bind(writer),
    appendEvents: (inputs: Parameters<typeof writer.appendEvents>[0]) => {
      if (
        opts.failContentionAppend === true &&
        inputs.some((input) => input.type === 'block_replaced')
      ) {
        throw new Error('simulated contention terminal append failure');
      }
      if (
        opts.pauseOnBlockReplacement === true &&
        !pausedBlockReplacement &&
        inputs.some((input) => input.type === 'block_replaced')
      ) {
        pausedBlockReplacement = true;
        throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
      }
      if (
        opts.pauseOnContentionResolution === true &&
        !pausedBlockReplacement &&
        inputs.some((input) => input.type === 'block_replaced')
      ) {
        pausedBlockReplacement = true;
        throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
      }
      if (opts.traceJournal === true) {
        for (const input of inputs) {
          if (input.type !== 'run_completed') continue;
          const attemptId = (input.payload as { attempt_id?: string })[
            'attempt_id'
          ];
          const attempt =
            attemptId === undefined
              ? undefined
              : spawner.attempts.get(attemptId);
          terminalAppendStages.push(
            attempt === undefined
              ? false
              : existsSync(join(attempt.attemptDir, '.stage')),
          );
        }
      }
      return writer.appendEvents(inputs);
    },
    readEvents: writer.readEvents.bind(writer),
    readBudgetPosition: writer.readBudgetPosition.bind(writer),
    release: writer.release.bind(writer),
  };
  const args: DispatchRunArgs = {
    campaignDir,
    spawner,
    clock: new FakeClock(1),
    identity: IDENTITY,
    credentials: credentials(),
    resultsRoot: join(campaignDir, 'results'),
    ...(opts.publishAttempt === undefined
      ? {}
      : { publishAttempt: opts.publishAttempt }),
    snapshotVerify: () => {},
    sampler: 'disabled',
    observeExposure: () => 1_000,
    stream: { write: () => {} },
    ...(opts.traceJournal === true ||
    opts.failContentionAppend === true ||
    opts.pauseOnBlockReplacement === true ||
    opts.pauseOnContentionResolution === true
      ? { journal }
      : {}),
    installSignals: () => () => {},
    signalGroup: () => 'ok',
    subjectHost: { find: () => null, kill: () => {} },
  };
  return { args, campaignDir, spawner, terminalAppendStages };
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 128; i += 1) await Promise.resolve();
}

test('dispatcher calls readiness after signal installation and before admission', async () => {
  const h = harness();
  const order: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    installSignals: () => {
      order.push('signals-installed');
      return () => {};
    },
    onReady: () => {
      order.push('ready');
      expect(h.spawner.specs).toHaveLength(0);
    },
  };
  const run = runCampaignDispatch(args);
  await settleMicrotasks();
  expect(order).toEqual(['signals-installed', 'ready']);
  expect(h.spawner.specs).toHaveLength(2);
  h.spawner.settleExit(0, { code: 0, signal: null });
  h.spawner.settleExit(1, { code: 0, signal: null });
  await run;
});

function events(
  campaignDir: string,
): { type: string; payload: Record<string, unknown> }[] {
  const reader = openJournalRead(campaignDir);
  try {
    return reader.readEvents() as {
      type: string;
      payload: Record<string, unknown>;
    }[];
  } finally {
    reader.close();
  }
}

function stageManifest(
  h: ReturnType<typeof harness>,
  sampleSuffix: string,
  runId: string,
  files: { path: string; body: string }[] = [
    { path: 'verdict.json', body: '{}' },
  ],
): { attemptDir: string; stagingDir: string; attemptId: string } {
  const entry = [...h.spawner.attempts.entries()].find(([, value]) =>
    value.attemptDir.includes(sampleSuffix),
  );
  if (entry === undefined)
    throw new Error(`missing fixture attempt ${sampleSuffix}`);
  const [attemptId, attempt] = entry;
  const runDir = join(attempt.stagingDir, runId);
  mkdirSync(runDir, { recursive: true });
  for (const file of files) {
    const path = join(runDir, file.path);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, file.body);
  }
  writeAttemptManifest(runDir, {
    campaign_id: campaignDocument().campaign_id,
    comparison_id: 'c1',
    block_id: 'c1:scn:b1',
    sample_id: 'c1:scn:arm_a:r1',
    execution_attempt_id: attemptId,
  });
  return {
    attemptDir: attempt.attemptDir,
    stagingDir: attempt.stagingDir,
    attemptId,
  };
}

function writeContentionSidecar(campaignDir: string): void {
  writeFileSync(
    join(campaignDir, 'contention-telemetry.jsonl'),
    `${[2000, 2010, 2020]
      .map((ts_ms) =>
        JSON.stringify({
          ts_ms,
          load1: 9,
          mem_available_bytes: 8 * 2 ** 30,
          swap_used_bytes: 0,
          process_count: 100,
          disk_free_bytes: 90 * 2 ** 30,
          breach: [],
        }),
      )
      .concat(
        [2040, 2050, 2060].map((ts_ms) =>
          JSON.stringify({
            ts_ms,
            load1: 0,
            mem_available_bytes: 8 * 2 ** 30,
            swap_used_bytes: 0,
            process_count: 100,
            disk_free_bytes: 90 * 2 ** 30,
            breach: [],
          }),
        ),
      )
      .join('\n')}\n`,
  );
}

test('container dispatch routes staging out-root and journals container allocation without pgid', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  expect(h.spawner.specs).toHaveLength(2);
  const spec = h.spawner.specs[0]!;
  const attempt = [...h.spawner.attempts.values()].find((value) =>
    value.attemptDir.includes('arm_a:r1'),
  )!;
  expect(spec.args[spec.args.indexOf('--out-root') + 1]).toBe(
    attempt.stagingDir,
  );
  expect(spec.attempt?.homeDir).toBe(attempt.homeDir);
  expect(spec.attempt?.homeDir.startsWith(attempt.stagingDir)).toBe(false);
  h.spawner.emitAllocated(0, 'run-container-a');
  h.spawner.emitAllocated(1, 'run-container-b');
  await settleMicrotasks();
  const allocated = events(h.campaignDir).filter(
    (e) => e.type === 'run_allocated',
  );
  expect(allocated).toHaveLength(2);
  expect(allocated.map((event) => event.payload)).toEqual([
    {
      attempt_id: h.spawner.specs[0]?.attempt?.attemptId,
      run_id: 'run-container-a',
      container_name: h.spawner.spawnedContainerNames[0],
      container_id: h.spawner.spawnedContainerIds[0],
      image_digest: `sha256:${'b'.repeat(64)}`,
      key_grants: [
        { role: 'subject', env: 'KEY_A' },
        { role: 'grader', env: 'KEY_G' },
      ],
    },
    {
      attempt_id: h.spawner.specs[1]?.attempt?.attemptId,
      run_id: 'run-container-b',
      container_name: h.spawner.spawnedContainerNames[1],
      container_id: h.spawner.spawnedContainerIds[1],
      image_digest: `sha256:${'b'.repeat(64)}`,
      key_grants: [
        { role: 'subject', env: 'KEY_B' },
        { role: 'grader', env: 'KEY_G' },
      ],
    },
  ]);
  expect(new Set(h.spawner.spawnedContainerIds).size).toBe(2);
  expect(new Set(h.spawner.spawnedContainerNames).size).toBe(2);
  expect(allocated.every((event) => !('pgid' in event.payload))).toBe(true);
  expect(Object.values(spec.env).join(' ')).not.toContain('fixture-key');
  expect(spec.args.join(' ')).not.toContain('fixture-key');
  h.spawner.settleExit(0, { code: 0, signal: null });
  h.spawner.settleExit(1, { code: 0, signal: null });
  await run;
});

test('container exit publishes the verified manifest before run_completed and excludes home', async () => {
  const h = harness({ traceJournal: true });
  const run = runCampaignDispatch(h.args);
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  const attemptEntry = [...h.spawner.attempts.entries()].find(([, value]) =>
    value.attemptDir.includes('arm_a:r1'),
  )!;
  const attemptId = attemptEntry[0];
  const attempt = attemptEntry[1];
  h.spawner.emitAllocated(0, 'run-container-a');
  h.spawner.emitAllocated(1, 'run-container-b');
  await settleMicrotasks();
  const runDir = join(attempt.stagingDir, 'run-container-a');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'verdict.json'), '{}');
  writeAttemptManifest(runDir, {
    campaign_id: campaignDocument().campaign_id,
    comparison_id: 'c1',
    block_id: 'c1:scn:b1',
    sample_id: 'c1:scn:arm_a:r1',
    execution_attempt_id: attemptId,
  });
  expect(existsSync(join(attempt.attemptDir, '.stage'))).toBe(true);
  h.spawner.settleExit(0, { code: 0, signal: null });
  await settleMicrotasks();
  expect(
    existsSync(join(h.args.resultsRoot!, 'run-container-a', 'verdict.json')),
  ).toBe(true);
  expect(existsSync(join(attempt.stagingDir, 'run-container-a'))).toBe(false);
  expect(existsSync(join(attempt.attemptDir, '.stage'))).toBe(false);
  expect(h.terminalAppendStages).toEqual([true]);
  expect(events(h.campaignDir).some((e) => e.type === 'run_completed')).toBe(
    true,
  );
  expect(existsSync(attempt.homeDir)).toBe(true);
  expect(
    readFileSync(
      join(h.args.resultsRoot!, 'run-container-a', 'manifest.json'),
      'utf8',
    ),
  ).not.toContain('home');
  h.spawner.settleExit(1, { code: 0, signal: null });
  await run;
});

test('container exit without a manifest journals instrument_failure and retains attempt logs', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  const attempt = [...h.spawner.attempts.values()].find((value) =>
    value.attemptDir.includes('arm_a:r1'),
  )!;
  h.spawner.emitAllocated(0, 'run-container-a');
  h.spawner.emitAllocated(1, 'run-container-b');
  await settleMicrotasks();
  h.spawner.settleExit(0, { code: 0, signal: null });
  await settleMicrotasks();
  const journal = events(h.campaignDir);
  expect(journal.some((event) => event.type === 'instrument_failure')).toBe(
    true,
  );
  expect(journal.some((event) => event.type === 'exposure_started')).toBe(
    false,
  );
  expect(journal.some((event) => event.type === 'run_completed')).toBe(false);
  expect(existsSync(attempt.attemptDir)).toBe(true);
  expect(existsSync(join(attempt.attemptDir, 'stdout.log'))).toBe(true);
  expect(existsSync(join(h.args.resultsRoot!, 'run-container-a'))).toBe(false);
  h.spawner.settleExit(1, { code: 0, signal: null });
  await run;
});

test('container publication mismatch refuses stale run evidence and cost', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  const attemptEntry = [...h.spawner.attempts.entries()].find(([, value]) =>
    value.attemptDir.includes('arm_a:r1'),
  )!;
  const attemptId = attemptEntry[0];
  const attempt = attemptEntry[1];
  const staleRunDir = join(h.args.resultsRoot!, 'run-container-a');
  mkdirSync(staleRunDir, { recursive: true });
  writeFileSync(
    join(staleRunDir, 'verdict.json'),
    JSON.stringify({
      final: 'pass',
      economics: { total_est_cost_usd: 99 },
    }),
  );
  h.spawner.emitAllocated(0, 'run-container-a');
  h.spawner.emitAllocated(1, 'run-container-b');
  await settleMicrotasks();
  const runDir = join(attempt.stagingDir, 'run-container-b');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'verdict.json'), '{}');
  writeAttemptManifest(runDir, {
    campaign_id: campaignDocument().campaign_id,
    comparison_id: 'c1',
    block_id: 'c1:scn:b1',
    sample_id: 'c1:scn:arm_a:r1',
    execution_attempt_id: attemptId,
  });
  h.spawner.settleExit(0, { code: 0, signal: null });
  await settleMicrotasks();
  const journal = events(h.campaignDir);
  expect(existsSync(join(attempt.stagingDir, 'run-container-b'))).toBe(true);
  expect(journal.some((event) => event.type === 'run_completed')).toBe(false);
  expect(journal.some((event) => event.type === 'instrument_failure')).toBe(
    true,
  );
  expect(journal.some((event) => event.type === 'exposure_started')).toBe(
    false,
  );
  expect(
    journal.some(
      (event) =>
        event.type === 'budget_event' && event.payload['kind'] === 'spend',
    ),
  ).toBe(false);
  h.spawner.settleExit(1, { code: 0, signal: null });
  await run;
});

test('container publication collision refuses stale same-run evidence and cost', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  const attempt = stageManifest(h, 'arm_a:r1', 'run-container-a');
  const destination = join(h.args.resultsRoot!, 'run-container-a');
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    join(destination, 'verdict.json'),
    JSON.stringify({ final: 'pass', economics: { total_est_cost_usd: 99 } }),
  );
  h.spawner.emitAllocated(0, 'run-container-a');
  h.spawner.emitAllocated(1, 'run-container-b');
  await settleMicrotasks();
  h.spawner.settleExit(0, { code: 0, signal: null });
  await settleMicrotasks();
  const journal = events(h.campaignDir);
  expect(existsSync(join(attempt.stagingDir, 'run-container-a'))).toBe(true);
  expect(readFileSync(join(destination, 'verdict.json'), 'utf8')).toContain(
    '99',
  );
  expect(journal.some((event) => event.type === 'run_completed')).toBe(false);
  expect(journal.some((event) => event.type === 'instrument_failure')).toBe(
    true,
  );
  expect(journal.some((event) => event.type === 'exposure_started')).toBe(
    false,
  );
  expect(
    journal.some(
      (event) =>
        event.type === 'budget_event' && event.payload['kind'] === 'spend',
    ),
  ).toBe(false);
  h.spawner.settleExit(1, { code: 0, signal: null });
  await run;
});

test('dispatcher refuses all evidence and spend after post-rename fsync ambiguity', async () => {
  let renameCount = 0;
  const h = harness({
    publishAttempt: (args) =>
      publishAttempt({
        ...args,
        fsOps: {
          renameSync: (oldPath, newPath) => {
            renameCount += 1;
            renameSync(oldPath, newPath);
          },
          openSync,
          fsyncSync: () => {
            throw new Error('simulated post-rename fsync cut');
          },
          closeSync,
        },
      }),
  });
  const run = runCampaignDispatch(h.args);
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  stageManifest(h, 'arm_a:r1', 'run-container-fsync', [
    {
      path: 'verdict.json',
      body: JSON.stringify({
        final: 'pass',
        final_reason: 'stale verdict evidence',
        economics: { total_est_cost_usd: 42 },
      }),
    },
    {
      path: 'gauntlet-agent/results/stale/result.json',
      body: JSON.stringify({
        summary: 'stale grader evidence',
        reasoning: 'must not be consumed',
      }),
    },
  ]);
  h.spawner.emitAllocated(0, 'run-container-fsync');
  h.spawner.emitAllocated(1, 'run-container-other');
  await settleMicrotasks();
  h.spawner.settleExit(0, { code: 0, signal: null });
  await settleMicrotasks();
  const journal = events(h.campaignDir);
  expect(renameCount).toBe(1);
  expect(
    existsSync(
      join(h.args.resultsRoot!, 'run-container-fsync', 'verdict.json'),
    ),
  ).toBe(true);
  expect(journal.some((event) => event.type === 'instrument_failure')).toBe(
    true,
  );
  expect(journal.some((event) => event.type === 'run_completed')).toBe(false);
  expect(journal.some((event) => event.type === 'exposure_started')).toBe(
    false,
  );
  expect(
    journal.some(
      (event) =>
        event.type === 'budget_event' && event.payload['kind'] === 'spend',
    ),
  ).toBe(false);
  h.spawner.settleExit(1, { code: 0, signal: null });
  await run;
});

test('container spawn failure cleans a prepared stage after its disposition lands', async () => {
  const h = harness();
  h.spawner.failSpawns = true;
  h.spawner.spawnFailureCleanup = 'verified-absent';
  const run = runCampaignDispatch(h.args);
  (h.args.clock as FakeClock).advance(1);
  for (let i = 0; i < 32; i += 1) {
    (h.args.clock as FakeClock).advance(1_000);
    await settleMicrotasks();
  }
  await run;
  expect(h.spawner.attempts.size).toBeGreaterThan(0);
  expect(
    h.spawner.failedAttemptIds.every((attemptId) => {
      const attempt = h.spawner.attempts.get(attemptId);
      return (
        attempt !== undefined && !existsSync(join(attempt.attemptDir, '.stage'))
      );
    }),
  ).toBe(true);
});

test('spawn replacement retains stage when ENOSPC pauses after a successful resolution retry', async () => {
  const h = harness({ pauseOnBlockReplacement: true });
  const written: string[] = [];
  h.spawner.failSpawns = true;
  h.spawner.spawnFailureCleanup = 'verified-absent';
  const run = runCampaignDispatch({
    ...h.args,
    stream: { write: (text: string) => written.push(text) },
  });
  (h.args.clock as FakeClock).advance(1);
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  expect(
    events(h.campaignDir).some((event) => event.type === 'block_replaced'),
  ).toBe(true);
  expect(
    events(h.campaignDir).some((event) => event.type === 'storage_paused'),
  ).toBe(true);
  expect(h.spawner.failedAttemptIds.length).toBeGreaterThan(0);
  expect(
    h.spawner.failedAttemptIds.every((attemptId) => {
      const attempt = h.spawner.attempts.get(attemptId);
      return (
        attempt !== undefined && existsSync(join(attempt.attemptDir, '.stage'))
      );
    }),
  ).toBe(true);
  expect(
    written.some(
      (text) =>
        text.includes('replacement minted') ||
        text.includes('reserve exhausted') ||
        text.includes('replacement suppressed'),
    ),
  ).toBe(false);
  expect(written.some((text) => text.includes('admission resumed'))).toBe(
    false,
  );
});

test('ambiguous container spawn failure verifies the exact id before refusing release', async () => {
  const h = harness();
  h.spawner.failSpawns = true;
  h.spawner.spawnFailureCleanup = 'unverified';
  h.spawner.stopResult = 'alive';
  const run = runCampaignDispatch(h.args);
  (h.args.clock as FakeClock).advance(1);
  await expect(run).rejects.toThrow(
    /unknown cleanup certainty|refusing release/,
  );
  expect(h.spawner.stopped).toEqual([
    { containerId: 'a'.repeat(64), graceSeconds: 5 },
  ]);
  expect(h.spawner.failedAttemptIds).not.toHaveLength(0);
  expect(
    h.spawner.failedAttemptIds.every((attemptId) => {
      const attempt = h.spawner.attempts.get(attemptId);
      return (
        attempt !== undefined && existsSync(join(attempt.attemptDir, '.stage'))
      );
    }),
  ).toBe(true);
  expect(
    events(h.campaignDir).some((event) => event.type === 'block_replaced'),
  ).toBe(false);
});

test('ambiguous container spawn failure retains the stage when exact-ID verification throws', async () => {
  const h = harness();
  h.spawner.failSpawns = true;
  h.spawner.spawnFailureCleanup = 'unverified';
  h.spawner.stopThrows = true;
  const run = runCampaignDispatch(h.args);
  (h.args.clock as FakeClock).advance(1);
  await expect(run).rejects.toThrow(/exact-ID verification threw/);
  expect(h.spawner.stopped).toEqual([
    { containerId: 'a'.repeat(64), graceSeconds: 5 },
  ]);
  expect(
    h.spawner.failedAttemptIds.every((attemptId) => {
      const attempt = h.spawner.attempts.get(attemptId);
      return (
        attempt !== undefined && existsSync(join(attempt.attemptDir, '.stage'))
      );
    }),
  ).toBe(true);
  expect(
    events(h.campaignDir).some((event) => event.type === 'block_replaced'),
  ).toBe(false);
});

test('ambiguous spawn failure may disposition after exact-ID death is verified', async () => {
  const h = harness();
  h.spawner.failSpawns = true;
  h.spawner.failSpawnOnce = true;
  h.spawner.spawnFailureCleanup = 'unverified';
  h.spawner.stopResult = 'dead';
  let signal: ((signal?: NodeJS.Signals) => void) | undefined;
  const run = runCampaignDispatch({
    ...h.args,
    installSignals: (handler) => {
      signal = handler;
      return () => {};
    },
  });
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  expect(h.spawner.stopped).toEqual([
    { containerId: 'a'.repeat(64), graceSeconds: 5 },
  ]);
  expect(h.spawner.failedAttemptIds).toHaveLength(1);
  expect(h.spawner.specs.length).toBeGreaterThan(0);
  const failed = h.spawner.attempts.get(h.spawner.failedAttemptIds[0]!);
  expect(failed).toBeDefined();
  signal?.('SIGTERM');
  await run;
  expect(existsSync(join(failed!.attemptDir, '.stage'))).toBe(false);
});

test('contention verified container death cleans the stage after durable resolution', async () => {
  const h = harness();
  let signal: ((signal?: NodeJS.Signals) => void) | undefined;
  writeContentionSidecar(h.campaignDir);
  let hooks: DispatchSamplerHooks | null = null;
  const run = runCampaignDispatch({
    ...h.args,
    installSignals: (handler) => {
      signal = handler;
      return () => {};
    },
    sampler: {
      start(captured: DispatchSamplerHooks): () => void {
        hooks = captured;
        return () => {};
      },
    } satisfies DispatchSamplerSeam,
  });
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  expect(hooks).not.toBeNull();
  hooks!.onBreachEntry(['load1_per_core']);
  hooks!.onBreachExit({
    startTsMs: 2020,
    endTsMs: 2060,
    metrics: ['load1_per_core'],
  });
  await settleMicrotasks();
  (h.args.clock as FakeClock).advance(301);
  await settleMicrotasks();
  expect(h.spawner.stopped).toHaveLength(2);
  expect(
    h.spawner.stopped.every(
      ({ containerId }, index) =>
        containerId === h.spawner.spawnedContainerIds[index],
    ),
  ).toBe(true);
  const initialAttempts = [...h.spawner.attempts.values()].filter((attempt) =>
    attempt.attemptDir.includes(':r1'),
  );
  expect(initialAttempts.length).toBe(2);
  expect(
    initialAttempts.every(
      (attempt) => !existsSync(join(attempt.attemptDir, '.stage')),
    ),
  ).toBe(true);
  expect(
    events(h.campaignDir).some((event) => event.type === 'block_replaced'),
  ).toBe(true);
  signal?.('SIGTERM');
  await run;
});

test('contention resolution retains stage when ENOSPC retry lands while paused', async () => {
  const h = harness({ pauseOnContentionResolution: true });
  const written: string[] = [];
  writeContentionSidecar(h.campaignDir);
  let hooks: DispatchSamplerHooks | null = null;
  const run = runCampaignDispatch({
    ...h.args,
    stream: { write: (text: string) => written.push(text) },
    sampler: {
      start(captured: DispatchSamplerHooks): () => void {
        hooks = captured;
        return () => {};
      },
    } satisfies DispatchSamplerSeam,
  });
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  hooks!.onBreachEntry(['load1_per_core']);
  hooks!.onBreachExit({
    startTsMs: 2020,
    endTsMs: 2060,
    metrics: ['load1_per_core'],
  });
  await settleMicrotasks();
  (h.args.clock as FakeClock).advance(301);
  await settleMicrotasks();
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  expect(
    events(h.campaignDir).some((event) => event.type === 'storage_paused'),
  ).toBe(true);
  expect(
    events(h.campaignDir).some((event) => event.type === 'block_replaced'),
  ).toBe(true);
  const initialAttempts = [...h.spawner.attempts.values()].filter((attempt) =>
    attempt.attemptDir.includes(':r1'),
  );
  expect(initialAttempts).toHaveLength(2);
  expect(
    initialAttempts.every((attempt) =>
      existsSync(join(attempt.attemptDir, '.stage')),
    ),
  ).toBe(true);
  expect(written.some((text) => text.includes('contention resolution:'))).toBe(
    false,
  );
  expect(written.some((text) => text.includes('admission resumed'))).toBe(
    false,
  );
});

test('contention retains stages when the durable resolution append fails', async () => {
  const h = harness({ failContentionAppend: true });
  writeContentionSidecar(h.campaignDir);
  let hooks: DispatchSamplerHooks | null = null;
  const run = runCampaignDispatch({
    ...h.args,
    sampler: {
      start(captured: DispatchSamplerHooks): () => void {
        hooks = captured;
        return () => {};
      },
    } satisfies DispatchSamplerSeam,
  });
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  hooks!.onBreachEntry(['load1_per_core']);
  hooks!.onBreachExit({
    startTsMs: 2020,
    endTsMs: 2060,
    metrics: ['load1_per_core'],
  });
  await settleMicrotasks();
  (h.args.clock as FakeClock).advance(301);
  await settleMicrotasks();
  await expect(run).rejects.toThrow(
    'simulated contention terminal append failure',
  );
  expect(h.spawner.stopped).toHaveLength(2);
  const initialAttempts = [...h.spawner.attempts.values()].filter((attempt) =>
    attempt.attemptDir.includes(':r1'),
  );
  expect(initialAttempts).toHaveLength(2);
  expect(
    initialAttempts.every((attempt) =>
      existsSync(join(attempt.attemptDir, '.stage')),
    ),
  ).toBe(true);
  expect(
    events(h.campaignDir).some((event) => event.type === 'block_replaced'),
  ).toBe(false);
});

test('contention retains stages when container death is unverified', async () => {
  const h = harness();
  h.spawner.stopResult = 'alive';
  writeContentionSidecar(h.campaignDir);
  let hooks: DispatchSamplerHooks | null = null;
  let signal: ((signal?: NodeJS.Signals) => void) | undefined;
  const run = runCampaignDispatch({
    ...h.args,
    installSignals: (handler) => {
      signal = handler;
      return () => {};
    },
    sampler: {
      start(captured: DispatchSamplerHooks): () => void {
        hooks = captured;
        return () => {};
      },
    } satisfies DispatchSamplerSeam,
  });
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  hooks!.onBreachEntry(['load1_per_core']);
  hooks!.onBreachExit({
    startTsMs: 2020,
    endTsMs: 2060,
    metrics: ['load1_per_core'],
  });
  await settleMicrotasks();
  (h.args.clock as FakeClock).advance(301);
  await settleMicrotasks();
  expect(h.spawner.stopped).toHaveLength(2);
  const initialAttempts = [...h.spawner.attempts.values()].filter((attempt) =>
    attempt.attemptDir.includes(':r1'),
  );
  expect(
    initialAttempts.every((attempt) =>
      existsSync(join(attempt.attemptDir, '.stage')),
    ),
  ).toBe(true);
  expect(
    events(h.campaignDir).some((event) => event.type === 'block_replaced'),
  ).toBe(false);
  h.spawner.stopResult = 'dead';
  signal!('SIGTERM');
  await run;
});

test('container cancellation stops exact container id without process-group or subject-host probes', async () => {
  const h = harness();
  const finds: string[] = [];
  let signalCalls = 0;
  let handler: ((signal?: NodeJS.Signals) => void) | undefined;
  const run = runCampaignDispatch({
    ...h.args,
    subjectHost: {
      find: (dir) => {
        finds.push(dir);
        return null;
      },
      kill: () => {},
    },
    signalGroup: () => {
      signalCalls += 1;
      return 'ok';
    },
    installSignals: (cb) => {
      handler = cb;
      return () => {};
    },
  });
  (h.args.clock as FakeClock).advance(1);
  await settleMicrotasks();
  writeFileSync(join(h.campaignDir, 'cancel-request'), '1000\nstop\n', {
    flag: 'wx',
  });
  handler?.('SIGTERM');
  await settleMicrotasks();
  expect(h.spawner.stopped).toHaveLength(2);
  expect(
    h.spawner.stopped.every(
      (entry) =>
        h.spawner.spawnedContainerIds.includes(entry.containerId) &&
        entry.graceSeconds === 5,
    ),
  ).toBe(true);
  expect(signalCalls).toBe(0);
  expect(finds).toHaveLength(0);
  expect(
    [...h.spawner.attempts.values()].every(
      (attempt) => !existsSync(join(attempt.attemptDir, '.stage')),
    ),
  ).toBe(true);
  await run;
});
