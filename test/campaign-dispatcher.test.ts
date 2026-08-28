import { afterAll, expect, test } from 'bun:test';
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInstanceGraph,
  blockDemandVector,
  blockPrioritySeconds,
  compareAdmissionOrder,
  DispatcherError,
  type DispatchJournal,
  type DispatchRunArgs,
  type DispatchSamplerHooks,
  type DispatchSamplerSeam,
  estimateInflightTotal,
  type GroupSignaler,
  killGroupVerified,
  performStoragePause,
  realGroupSignaler,
  runCampaignDispatch,
  SPAWN_FAILURE_HALT_N,
} from '../src/campaign/dispatcher.ts';
import type { SnapshotHandle } from '../src/campaign/instrument-snapshot.ts';
import { SnapshotDriftError } from '../src/campaign/instrument-snapshot.ts';
import {
  electWriter,
  initJournalDb,
  openJournalRead,
} from '../src/campaign/journal.ts';
import {
  type ProcessIdentityProbe,
  realProcessIdentityProbe,
} from '../src/campaign/locks.ts';
import { GLOBAL_POOL } from '../src/campaign/simulate.ts';
import type {
  CampaignChildSpec,
  ChildExitInfo,
  ChildSpawner,
  SpawnedCampaignChild,
} from '../src/campaign/spawn.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import {
  type JournalEvent,
  normalizeBlockReplaced,
} from '../src/contracts/campaign/journal-events.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { deleteProcessEnv, getEnv, setProcessEnv } from '../src/env.ts';
import { FakeClock, RealClock } from '../src/scheduler/clock.ts';

// ---------------------------------------------------------------------------
// Task 8a pure-cores tests (unchanged)
// ---------------------------------------------------------------------------

const block = (sample_ids: string[]) => ({
  block_id: 'b',
  comparison_id: 'c1',
  sample_ids,
});

test('demand vector: per-sample subject pool + REAL grader pool + global (R-DSP-1, R-DSP-8)', () => {
  const demand = blockDemandVector({
    block: block(['s1', 's2']),
    sampleArmCredentialPool: () => 'poolA',
    graderPool: 'the-registered-grader-poolKey',
  });
  expect(demand.get('poolA')).toBe(2); // two samples on one subject pool
  // The grader demand lands under the REAL registered grader pool key
  // (R-DSP-8), never under the simulator-reserved '__grader__' constant.
  expect(demand.get('the-registered-grader-poolKey')).toBe(2);
  expect(demand.has('__grader__')).toBe(false);
  expect(demand.get(GLOBAL_POOL)).toBe(2); // per-sample global slots (Decision D-1)
});

test('demand vector aggregates mixed subject pools per sample', () => {
  const demand = blockDemandVector({
    block: block(['s1', 's2', 's3']),
    sampleArmCredentialPool: (s) => (s === 's1' ? 'poolA' : 'poolB'),
    graderPool: 'grader',
  });
  expect(demand.get('poolA')).toBe(1);
  expect(demand.get('poolB')).toBe(2);
  expect(demand.get('grader')).toBe(3);
  expect(demand.get(GLOBAL_POOL)).toBe(3);
});

test('priority = max sample estimate (REV sol #15); zero is valid, invalid is not', () => {
  expect(
    blockPrioritySeconds({
      block: block(['s1', 's2']),
      sampleEstimateSeconds: (s) => (s === 's1' ? 100 : 300),
    }),
  ).toBe(300);
  expect(
    blockPrioritySeconds({
      block: block(['s1']),
      sampleEstimateSeconds: () => 0,
    }),
  ).toBe(0);
});

test('admission tie-break is total and deterministic over all valid block ids', () => {
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b2' }, { block_id: 'c1:a:b1' }),
  ).toBeGreaterThan(0);
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b1' }, { block_id: 'c2:a:b1' }),
  ).toBeLessThan(0);
  // kind marker separates primary from reserve at the same replicate ordinal
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b1' }, { block_id: 'c1:a:x1' }),
  ).toBeLessThan(0);
  // lineage suffix separates a rerun instance from its root and orders instances
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b1' }, { block_id: 'c1:a:b1:i1' }),
  ).toBeLessThan(0);
  expect(
    compareAdmissionOrder(
      { block_id: 'c1:a:b1:i1' },
      { block_id: 'c1:a:b1:i2' },
    ),
  ).toBeLessThan(0);
  // reflexivity + unparsable ids sort last, ordered by raw id
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b1' }, { block_id: 'c1:a:b1' }),
  ).toBe(0);
  expect(
    compareAdmissionOrder(
      { block_id: 'c1:a:b1' },
      { block_id: 'not-a-block-id' },
    ),
  ).toBeLessThan(0);
  expect(
    compareAdmissionOrder({ block_id: 'zzz' }, { block_id: 'aaa' }),
  ).toBeGreaterThan(0);
  const shuffled = [
    'c1:a:b1:i2',
    'c1:a:x1',
    'c1:a:b2',
    'c2:z:b1',
    'c1:a:b1:i1',
    'c1:a:b1',
    'c2:a:b1',
  ];
  const ordered = shuffled
    .map((block_id) => ({ block_id }))
    .sort(compareAdmissionOrder)
    .map((b) => b.block_id);
  expect(ordered).toEqual([
    'c1:a:b1',
    'c1:a:b1:i1',
    'c1:a:b1:i2',
    'c1:a:x1',
    'c1:a:b2',
    'c2:a:b1',
    'c2:z:b1',
  ]);
});

test('estimateInflightTotal sums the exposure set (E7.7)', () => {
  expect(
    estimateInflightTotal({
      exposureSamples: [{ sampleId: 'a' }, { sampleId: 'b' }],
      estimateCostUsd: () => 1.5,
    }),
  ).toBe(3);
  expect(
    estimateInflightTotal({ exposureSamples: [], estimateCostUsd: () => 1.5 }),
  ).toBe(0); // no in-flight exposure is a legitimate zero
});

test('pure cores fail closed on invalid numerics (typed error)', () => {
  expect(() =>
    blockPrioritySeconds({
      block: block(['s1']),
      sampleEstimateSeconds: () => Number.NaN,
    }),
  ).toThrow(DispatcherError);
  expect(() =>
    blockPrioritySeconds({
      block: block(['s1']),
      sampleEstimateSeconds: () => -1,
    }),
  ).toThrow(DispatcherError);
  expect(() =>
    blockPrioritySeconds({
      block: block(['s1']),
      sampleEstimateSeconds: () => Number.POSITIVE_INFINITY,
    }),
  ).toThrow(DispatcherError);
  expect(() =>
    blockPrioritySeconds({ block: block([]), sampleEstimateSeconds: () => 1 }),
  ).toThrow(DispatcherError);
  expect(() =>
    estimateInflightTotal({
      exposureSamples: [{ sampleId: 'a' }],
      estimateCostUsd: () => -0.5,
    }),
  ).toThrow(DispatcherError);
  expect(() =>
    estimateInflightTotal({
      exposureSamples: [{ sampleId: 'a' }],
      estimateCostUsd: () => Number.NaN,
    }),
  ).toThrow(DispatcherError);
  expect(() =>
    estimateInflightTotal({
      exposureSamples: [{ sampleId: 'a' }],
      estimateCostUsd: () => Number.POSITIVE_INFINITY,
    }),
  ).toThrow(DispatcherError);
});

// ---------------------------------------------------------------------------
// Task 8b orchestrator fixture machinery
// ---------------------------------------------------------------------------

const IDENTITY: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 1,
};

// The 6a env composition resolves selected key VALUES through src/env.ts and
// fails loud when unset (R-SPN-7) — seed the fixture credentials' env names,
// preserving any prior values for suite hermeticity (restored in afterAll).
const FIXTURE_ENV_KEYS = ['KEY_A', 'KEY_B', 'KEY_G'] as const;
const PRIOR_ENV = new Map<string, string | undefined>(
  FIXTURE_ENV_KEYS.map((k) => [k, getEnv(k)]),
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

// --- Fake spawner: scripted children --------------------------------------
class FakeChild {
  readonly pid: number;
  stdout: string[] = [];
  stderr: string[] = [];
  get stdoutLines(): readonly string[] {
    return this.stdout;
  }
  get stderrLines(): readonly string[] {
    return this.stderr;
  }
  exitInfo: ChildExitInfo | null = null;
  private stdoutCbs: ((l: string) => void)[] = [];
  private stderrCbs: ((l: string) => void)[] = [];
  private exitCbs: ((i: ChildExitInfo) => void)[] = [];
  constructor(pid: number) {
    this.pid = pid;
  }
  emitLine(line: string): void {
    this.stdout.push(line);
    for (const cb of this.stdoutCbs) cb(line);
  }
  emitStderr(line: string): void {
    this.stderr.push(line);
    for (const cb of this.stderrCbs) cb(line);
  }
  exit(info: ChildExitInfo): void {
    this.exitInfo = info;
    for (const cb of this.exitCbs) cb(info);
  }
  onStdoutLine(cb: (l: string) => void): void {
    this.stdoutCbs.push(cb);
  }
  onStderrLine(cb: (l: string) => void): void {
    this.stderrCbs.push(cb);
  }
  onExit(cb: (i: ChildExitInfo) => void): void {
    this.exitCbs.push(cb);
  }
}
class FakeSpawner implements ChildSpawner {
  readonly spawned: { spec: CampaignChildSpec; child: FakeChild }[] = [];
  failNext = 0; // spawn-failure injection count
  private nextPid = 1000;
  spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('injected spawn failure');
    }
    const child = new FakeChild(this.nextPid++);
    this.spawned.push({ spec, child });
    return child;
  }
}

/** C10 kill seam fake: the first TERM/KILL marks the group dead; probes
 *  (signal 0) report 'esrch' afterwards. Fake pids must NEVER reach a real
 *  process.kill — the seam carries the fiction. */
function fakeGroupSignaler(): GroupSignaler {
  const dead = new Set<number>();
  return (pgid, signal) => {
    if (signal === 0) return dead.has(pgid) ? 'esrch' : 'ok';
    dead.add(pgid);
    return 'ok';
  };
}

// --- Campaign document fixture --------------------------------------------
function campaignDoc(overrides: Record<string, unknown> = {}): Campaign {
  return {
    schema_version: 1,
    campaign_id: 'c'.repeat(64),
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
          arm_a: { duration_s: 100, cost_usd: 1, confidence: 'high' },
          arm_b: { duration_s: 200, cost_usd: 2, confidence: 'high' },
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
    digest: 'c'.repeat(64),
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
    ...overrides,
    // Fixture-literal cast, justified: this is a full valid document already
    // exercised against CampaignSchema in the task 5 registration tests; the
    // cast only bridges the untyped `overrides` spread. The dispatcher
    // re-parses it through CampaignSchema at startup (fail-closed).
  } as unknown as Campaign;
}

interface HarnessArgs {
  campaignDir: string;
  spawner: FakeSpawner;
  clock: FakeClock;
  credentials: Record<string, Credential>;
}
function harness(
  overrides: Record<string, unknown> = {},
): HarnessArgs & { args: DispatchRunArgs } {
  const campaignDir = mkdtempSync(join(tmpdir(), 'disp-'));
  initJournalDb(campaignDir);
  writeFileSync(join(campaignDir, '.ballast'), 'x'); // ballast presence satisfied
  writeFileSync(join(campaignDir, 'contention-telemetry.jsonl'), '');
  const doc = campaignDoc(overrides);
  writeFileSync(
    join(campaignDir, 'campaign.json'),
    JSON.stringify(doc, null, 2),
  );
  const writer = electWriter({
    campaignDir,
    clock: new FakeClock(0),
    identity: IDENTITY,
  });
  writer.appendEvent({
    type: 'campaign_opened',
    payload: { campaign_id: doc.campaign_id, digest: doc.digest },
  });
  writer.release();
  const spawner = new FakeSpawner();
  const clock = new FakeClock(1);
  const cred = (env: string) =>
    ({
      model: 'm',
      harnesses: ['claude'],
      api: 'anthropic',
      auth: 'api-key',
      api_key_env: env,
      compat: {},
      max_concurrency: 2,
    }) as Credential;
  const credentials = {
    cred_a: cred('KEY_A'),
    cred_b: cred('KEY_B'),
    grader_cred: cred('KEY_G'),
  };
  const args: DispatchRunArgs = {
    campaignDir,
    spawner,
    clock,
    identity: IDENTITY,
    credentials,
    resultsRoot: join(campaignDir, 'results'),
    snapshotVerify: () => {}, // task 4 seam: inject clean verify by default
    sampler: 'disabled', // contention sampler off unless a test enables it
    observeExposure: () => 1_000, // uniform exposure -> zero skew unless a test overrides
    stream: { write: () => {} },
    installSignals: () => () => {}, // signal seam: no-op by default
    signalGroup: fakeGroupSignaler(), // C10 seam: fake pids never reach process.kill
  };
  return { campaignDir, spawner, clock, credentials, args };
}

async function tick(clock: FakeClock, seconds: number): Promise<void> {
  clock.advance(seconds);
  // The dispatcher's serialized control section (C11) chains promises, so a
  // single microtask turn is not enough for a full wave to settle; drain a
  // deterministic batch of turns instead of guessing the exact depth.
  for (let i = 0; i < 128; i += 1) await Promise.resolve();
}

// Read-only journal views (openJournalRead): a live dispatcher HOLDS the
// journal lease for its whole run, so a mid-run electWriter here would
// refuse against the live holder. Readers never write, never take the lease.
function journalTypes(campaignDir: string): string[] {
  const r = openJournalRead(campaignDir);
  try {
    return r.readEvents().map((e) => e.type);
  } finally {
    r.close();
  }
}
function journalEvents(campaignDir: string): JournalEvent[] {
  const r = openJournalRead(campaignDir);
  try {
    return r.readEvents();
  } finally {
    r.close();
  }
}
/** Type-narrowing view: the events of one type, payload narrowed. */
function eventsOf<T extends JournalEvent['type']>(
  campaignDir: string,
  type: T,
): Extract<JournalEvent, { type: T }>[] {
  return journalEvents(campaignDir).filter(
    (e): e is Extract<JournalEvent, { type: T }> => e.type === type,
  );
}
/** block_replaced payloads normalized (the payload is the E7.2 legacy|fresh
 *  union — direct property access does not typecheck across the arms). */
function mintRecords(campaignDir: string) {
  return eventsOf(campaignDir, 'block_replaced').map((e) => ({
    seq: e.seq,
    ...normalizeBlockReplaced(e.payload),
  }));
}

// ---------------------------------------------------------------------------
// Task 8b orchestrator tests
// ---------------------------------------------------------------------------

test('admission is atomic per block and capped by the per-sample global cap; release at SERVICE END', async () => {
  const h = harness(); // global_run_cap = 2 -> exactly one two-sample block in flight
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  expect(h.spawner.spawned.length).toBe(2); // both samples of b1 spawned
  // Allocate run ids, then hold the children alive: nothing else admits.
  for (const { child } of h.spawner.spawned) {
    child.emitLine(`run_allocated: run-${child.pid}`);
  }
  await tick(h.clock, 1);
  expect(h.spawner.spawned.length).toBe(2); // cap 2 holds the reserve out
  // Service end: children exit -> slots release -> the reserve block can admit
  // ONLY after replacement obligation (reserve is frozen; no primary remains)
  for (const { child } of h.spawner.spawned)
    child.exit({ code: 0, signal: null });
  const outcome = await run;
  expect(outcome.status).toBe('completed');
  const events = journalEvents(h.campaignDir);
  expect(events.filter((e) => e.type === 'block_admitted').length).toBe(1); // primary only; reserve untouched without obligation
  expect(
    events.some(
      (e) =>
        e.type === 'budget_event' && e.payload.kind === 'estimate_inflight',
    ),
  ).toBe(true);
});

test('longest-expected-first ordering admits the longer block first when the cap forces a choice', async () => {
  // Two primary blocks; global cap 2 admits exactly one two-sample block.
  const h = harness({
    blocks: [
      {
        block_id: 'c1:scn:b1',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'],
      },
      {
        block_id: 'c1:scn:b2',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r2', 'c1:scn:arm_b:r2'],
      },
    ],
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
        sample_id: 'c1:scn:arm_a:r2',
        cell: 'c1:scn',
        arm: 'arm_a',
        replicate: 2,
      },
      {
        sample_id: 'c1:scn:arm_b:r2',
        cell: 'c1:scn',
        arm: 'arm_b',
        replicate: 2,
      },
    ],
  });
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  // b1's arm_b estimate (200s) > nothing else distinguishes — blocks tie by
  // estimates; the fixture arms give b1 == b2 priority, so the tie-break is
  // replicate ordinal: b1 first.
  const admitted = eventsOf(h.campaignDir, 'block_admitted');
  expect(admitted[0]?.payload.block_id).toBe('c1:scn:b1');
  for (const { child } of h.spawner.spawned) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await tick(h.clock, 1); // b1's slots release -> b2 admits + spawns
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await run;
});

test('429 cooldown: classified stderr pools the block, waits the clamped cooldown, then resumes', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  const [first] = h.spawner.spawned;
  first!.child.emitStderr('{"type":"rate_limit_error"} retry-after: 30');
  first!.child.emitLine(`run_allocated: run-${first!.child.pid}`);
  first!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  // pool_blocked journaled for the subject pool, until = now + 30s.
  const blocked = eventsOf(h.campaignDir, 'pool_blocked')[0];
  expect(blocked).toBeDefined();
  expect(blocked!.payload.pool_key).toBe('cred_a|anthropic|m'); // poolKey(cred, name): base_url ?? name | api | model
  for (const { child } of h.spawner.spawned.slice(1)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  // The crash-classified first child minted the reserve; its block waits out
  // the pool cooldown, then admits and spawns.
  await tick(h.clock, 31); // past the cooldown
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await run;
});

test('instrument replacement: typed failure mints the reserve (block_replaced FIRST, then dispositions), conservation intact', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  const [childA, childB] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  childB!.child.emitLine(`run_allocated: run-${childB!.child.pid}`);
  // arm_a fails with a typed instrument cause.
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  childB!.child.exit({ code: 0, signal: null });
  await tick(h.clock, 1);
  const events = journalEvents(h.campaignDir);
  const replaced = mintRecords(h.campaignDir)[0];
  expect(replaced).toBeDefined();
  expect(replaced).toMatchObject({
    block_id: 'c1:scn:b1',
    replacement_block_id: 'c1:scn:x1',
    reason: expect.any(String),
    kind: 'replacement',
    reserve_activation: true,
  });
  // Mint order: block_replaced precedes the disposition rows (E7.1 bundle).
  const replacedSeq = replaced!.seq;
  const dispositions = events.filter((e) => e.type === 'sample_disposition');
  expect(dispositions.length).toBeGreaterThanOrEqual(1);
  for (const d of dispositions) expect(d.seq).toBeGreaterThan(replacedSeq);
  // instrument_failure journaled for the failed attempt.
  expect(events.some((e) => e.type === 'instrument_failure')).toBe(true);
  // The minted reserve admits once slots free; finish its children.
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await run;
});

test('budget stop terminalizes the DENIED samples only; a raise admits later blocks while stopped samples stay stopped (E3/E7.6)', async () => {
  // Three primary blocks, budget 4: session 1 admits b1 (exposure 3); the
  // stop fires at b2 (3 + 3 > 4) selecting exactly b2's samples; b3 is
  // denied by the in-force stop but never SELECTED — it stays planned. A
  // raise appended between sessions then admits b3 against the raised
  // ceiling while b2's stopped samples never resurrect (E7.6).
  const overrides = {
    budget: {
      usd_all_in: 4,
      surcharge_applied: 0,
      priced_coverage: 1,
      surcharge_formula_version: 1,
    },
    blocks: [
      {
        block_id: 'c1:scn:b1',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'],
      },
      {
        block_id: 'c1:scn:b2',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r2', 'c1:scn:arm_b:r2'],
      },
      {
        block_id: 'c1:scn:b3',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r3', 'c1:scn:arm_b:r3'],
      },
    ],
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
        sample_id: 'c1:scn:arm_a:r2',
        cell: 'c1:scn',
        arm: 'arm_a',
        replicate: 2,
      },
      {
        sample_id: 'c1:scn:arm_b:r2',
        cell: 'c1:scn',
        arm: 'arm_b',
        replicate: 2,
      },
      {
        sample_id: 'c1:scn:arm_a:r3',
        cell: 'c1:scn',
        arm: 'arm_a',
        replicate: 3,
      },
      {
        sample_id: 'c1:scn:arm_b:r3',
        cell: 'c1:scn',
        arm: 'arm_b',
        replicate: 3,
      },
    ],
  };
  const h = harness(overrides);
  const run1 = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await run1;
  const stop = eventsOf(h.campaignDir, 'budget_stopped')[0];
  expect(stop).toBeDefined();
  // E3 selection: the DENIED block's samples (b2 — the overshoot work the
  // stop prevents); b3's samples stay planned, never selected.
  expect([...stop!.payload.sample_ids].sort()).toEqual([
    'c1:scn:arm_a:r2',
    'c1:scn:arm_b:r2',
  ]);
  expect(eventsOf(h.campaignDir, 'run_allocated').length).toBe(2);
  // R-DSP-10: the raise lands append-only between sessions (a live
  // dispatcher holds the writer).
  const raiser = electWriter({
    campaignDir: h.campaignDir,
    clock: new FakeClock(100),
    identity: IDENTITY,
  });
  raiser.appendEvent({
    type: 'amendment',
    payload: { kind: 'budget_raise', amount_usd: 10, ts: 100_000 },
  });
  raiser.release();
  // Session 2: a fresh dispatcher folds stop + raise — b3 admits against
  // the raised ceiling; b2 never resurrects (E7.6).
  const spawner2 = new FakeSpawner();
  const clock2 = new FakeClock(200);
  const run2 = runCampaignDispatch({
    ...h.args,
    spawner: spawner2,
    clock: clock2,
  });
  await tick(clock2, 1);
  expect(spawner2.spawned.length).toBe(2); // b3's pair; nothing for b2
  for (const { child } of spawner2.spawned) {
    child.emitLine(`run_allocated: s2-run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome2 = await run2;
  expect(outcome2.status).toBe('completed');
  const admitted = eventsOf(h.campaignDir, 'block_admitted').map(
    (e) => e.payload.block_id,
  );
  expect(admitted).toEqual(['c1:scn:b1', 'c1:scn:b3']);
  expect(eventsOf(h.campaignDir, 'run_allocated').length).toBe(4);
});

test('spawn failure: excluded siblings never spawn, one mint + one exhausted adjudication, pool halt at N=3, operator resume readmits', async () => {
  // Both arms on ONE credential so consecutive failures attribute to one
  // pool (REV fable I-14). failNext=3: b1.s1 fails (1) -> mints x1 with
  // dispositions for BOTH b1 samples; the excluded sibling b1.s2 never
  // spawns (Important 1). b2.s1 fails (2) -> reserve exhausted (x1 already
  // activated) -> ONE adjudication; b2 is not superseded, so b2.s2 still
  // spawns and fails (3) -> pool halt; the duplicate obligation resolves
  // nothing. Operator resume then admits x1, whose spawns succeed.
  const h = harness({
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
        credential: 'cred_a',
        auth: 'api-key',
        api: 'anthropic',
        model: 'm',
        key_env_names: ['KEY_A'],
      },
    ],
    blocks: [
      {
        block_id: 'c1:scn:b1',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'],
      },
      {
        block_id: 'c1:scn:b2',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r2', 'c1:scn:arm_b:r2'],
      },
      {
        block_id: 'c1:scn:x1',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:x1', 'c1:scn:arm_b:x1'],
        slot: 'reserve',
      },
    ],
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
        sample_id: 'c1:scn:arm_a:r2',
        cell: 'c1:scn',
        arm: 'arm_a',
        replicate: 2,
      },
      {
        sample_id: 'c1:scn:arm_b:r2',
        cell: 'c1:scn',
        arm: 'arm_b',
        replicate: 2,
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
  });
  h.spawner.failNext = SPAWN_FAILURE_HALT_N;
  const written: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1); // wave 1: b1 + b2 admit; 3 spawn failures; halt
  expect(written.join('')).toMatch(/halt: spawn-failure pool halt/);
  const midEvents = journalEvents(h.campaignDir);
  // A spawn-failed sample was never allocated (state 'admitted'), so the
  // frozen sample machine has NO legal instrument_failure edge for it
  // (replay REJECT from 'admitted'; and a mint-first ordering would break
  // seal clause 3). The typed record is classifier row 6 as the MINT
  // REASON, and the sample resolves via the E7.1 roster disposition from
  // 'admitted' — slots release either way, never a silently wedged cap.
  expect(midEvents.filter((e) => e.type === 'instrument_failure').length).toBe(
    0,
  );
  const mints = mintRecords(h.campaignDir);
  expect(mints.length).toBe(1);
  expect(mints[0]).toMatchObject({
    block_id: 'c1:scn:b1',
    replacement_block_id: 'c1:scn:x1',
    reason: 'subject_spawn_failed',
    kind: 'replacement',
    reserve_activation: true,
  });
  // Both b1 samples resolve through the mint's dispositions; the excluded
  // sibling NEVER spawned (Important 1: no stranded allocation possible).
  expect(midEvents.filter((e) => e.type === 'sample_disposition').length).toBe(
    2,
  );
  expect(h.spawner.spawned.length).toBe(0);
  // b2's obligation resolves EXACTLY once (idempotent per predecessor): one
  // reserve_exhausted adjudication despite two failed spawns on b2.
  expect(
    midEvents.filter(
      (e) =>
        e.type === 'adjudication' &&
        e.payload.disposition === 'reserve_exhausted',
    ).length,
  ).toBe(1);
  // Operator resume (the seam routes through the serialized control
  // section, Minor 2) — x1 then admits and its spawns succeed.
  args.resumeAdmission?.('spawn failures cleared');
  await tick(h.clock, 1);
  expect(written.join('')).toMatch(/resume: admission resumed/);
  expect(h.spawner.spawned.length).toBe(2); // x1's pair
  for (const { child } of h.spawner.spawned) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

test('closed-window contention: breach halts admission, resolution batch mints reason=contention in frozen order, counts print before admission resumed', async () => {
  const h = harness();
  const written: string[] = [];
  // Sidecar fixture through the REAL parseSidecar/evaluateContention path: a
  // sustain_k=3 crossing run (load1 9 -> 9/4 cores = 2.25 > threshold 2;
  // load1_per_core normalizes by the REGISTERED cpu_cores) closed by 3
  // in-bounds samples — the evaluator derives breach window [2020, 2060]
  // from these exact lines, overlapping the block admitted at ~2000ms (the
  // first tick advances the FakeClock to 2s before the first wave runs) ->
  // 'invalid'.
  const telemetry = (ts_ms: number, load1: number) =>
    JSON.stringify({
      ts_ms,
      load1,
      mem_available_bytes: 8 * 2 ** 30,
      swap_used_bytes: 0,
      process_count: 100,
      disk_free_bytes: 90 * 2 ** 30,
      breach: [],
    });
  writeFileSync(
    join(h.campaignDir, 'contention-telemetry.jsonl'),
    `${[2000, 2010, 2020]
      .map((t) => telemetry(t, 9))
      .concat([2040, 2050, 2060].map((t) => telemetry(t, 0)))
      .join('\n')}\n`,
  );
  // Scripted sampler seam — TYPED, no casts: capture the dispatcher's hooks
  // at start(), then drive onBreachExit by hand. This is the same entry
  // point the real ContentionSampler notifies after fsyncing the exit
  // sample; there is no other closed-window path into the dispatcher.
  let hooks: DispatchSamplerHooks | null = null;
  const scripted: DispatchSamplerSeam = {
    start(captured) {
      hooks = captured;
      return () => {};
    },
  };
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
    sampler: scripted,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.emitLine(`run_allocated: run-${child.pid}`);
  expect(hooks).not.toBeNull();
  // The closed window the sampler would hand over (derived from the same
  // sidecar lines above; exit sample already durable).
  hooks!.onBreachExit({
    startTsMs: 2020,
    endTsMs: 2060,
    metrics: ['load1_per_core'],
  });
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.exit({ code: 0, signal: null });
  await tick(h.clock, 1); // released slots -> the minted reserve admits + spawns
  expect(h.spawner.spawned.length).toBe(4);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
  const contentionMints = mintRecords(h.campaignDir).filter(
    (m) => m.reason === 'contention',
  );
  expect(contentionMints.length).toBe(1);
  expect(contentionMints[0]!.kind).toBe('replacement'); // never rerun kind
  const text = written.join('');
  expect(text).toMatch(
    /contention resolution: affected=1 refilled=1 exhausted=0 suppressed=0/,
  );
  expect(text.indexOf('contention resolution')).toBeLessThan(
    text.indexOf('admission resumed'),
  );
});

test('signal handling: SIGINT stops admission, kills groups, journals aborted, exits resumable', async () => {
  const h = harness();
  let signalHandler: ((signal?: NodeJS.Signals) => void) | null = null;
  const args: DispatchRunArgs = {
    ...h.args,
    installSignals: (handler) => {
      signalHandler = handler;
      return () => {};
    },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.emitLine(`run_allocated: run-${child.pid}`);
  expect(signalHandler).not.toBeNull();
  signalHandler!('SIGINT');
  const outcome = await run;
  expect(outcome.status).toBe('signalled');
  const events = journalEvents(h.campaignDir);
  expect(events.some((e) => e.type === 'aborted')).toBe(true);
  expect(events.some((e) => e.type === 'campaign_cancelled')).toBe(false); // resumable, not cancelled
});

test('exposure journals once at terminal; gating skew breach excludes the block and refills via skew_refill with NO dispositions', async () => {
  const h = harness();
  // Per-run exposure through the seam (production reads trajectory.json):
  // b1's two samples land 499s apart — over the registered 60s bound.
  const args: DispatchRunArgs = {
    ...h.args,
    observeExposure: (runDir) =>
      runDir.endsWith('run-1000') ? 1_000 : 500_000,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.emitLine(`run_allocated: run-${child.pid}`);
  for (const { child } of h.spawner.spawned)
    child.exit({ code: 0, signal: null });
  await tick(h.clock, 1); // skew decided at block terminal -> the refill admits
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
  const events = journalEvents(h.campaignDir);
  // R-SNS-5: exposure_started { sample_id, ts } — once per terminaled
  // sample (monotonic single emission), payload field `ts`.
  const expo = events.filter((e) => e.type === 'exposure_started');
  expect(expo.length).toBe(4); // b1 pair + refill pair
  expect(expo[0]!.payload).toMatchObject({
    sample_id: 'c1:scn:arm_a:r1',
    ts: 1_000,
  });
  // R-DSP-9: gating exclusion fans out over the block; the refill is
  // reason 'skew_refill', kind 'replacement'.
  expect(
    events.some(
      (e) => e.type === 'skew_excluded' && e.payload.block_id === 'c1:scn:b1',
    ),
  ).toBe(true);
  const refill = mintRecords(h.campaignDir).find(
    (m) => m.reason === 'skew_refill',
  );
  expect(refill!.kind).toBe('replacement');
  // E7.2: NO excluded_block_replaced dispositions for a skew refill — the
  // excluded samples keep their skew_excluded terminal.
  expect(events.filter((e) => e.type === 'sample_disposition').length).toBe(0);
});

test('operator cancel: the signalled dispatcher journals aborted then campaign_cancelled LAST and exits cancelled (D-12 live path)', async () => {
  const h = harness();
  let signalHandler: ((signal?: NodeJS.Signals) => void) | null = null;
  const args: DispatchRunArgs = {
    ...h.args,
    installSignals: (handler) => {
      signalHandler = handler;
      return () => {};
    },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.emitLine(`run_allocated: run-${child.pid}`);
  // `quorum campaign cancel` lands the marker FIRST (O_EXCL, D-12), then
  // signals; the marker's second line carries the operator's reason.
  writeFileSync(
    join(h.campaignDir, 'cancel-request'),
    '1000\noperator said stop\n',
    { flag: 'wx' },
  );
  signalHandler!('SIGTERM');
  const outcome = await run;
  expect(outcome.status).toBe('cancelled');
  const types = journalTypes(h.campaignDir);
  expect(types[types.length - 1]).toBe('campaign_cancelled'); // LAST — the cancel verb polls for exactly this
  expect(types.indexOf('aborted')).toBeLessThan(
    types.indexOf('campaign_cancelled'),
  );
  const cancelled = eventsOf(h.campaignDir, 'campaign_cancelled')[0];
  expect(cancelled!.payload.reason).toBe('operator said stop'); // reason rides the marker body
});

test('snapshot drift at a wave: D-11 in order — halt, kill+abort affected, authorized repair, clean re-verify, rerun re-entry, admission resumes', async () => {
  const h = harness();
  const written: string[] = [];
  // Verify seam: clean on the first wave, DRIFT on the second, clean once
  // the authorized repair has run.
  let verifies = 0;
  let repaired = false;
  const repairedHandle: SnapshotHandle = {
    evalsRoot: join(h.campaignDir, 'evals'),
    gauntletRoot: join(h.campaignDir, 'gauntlet'),
    gauntletBin: join(h.campaignDir, 'bin', 'gauntlet'),
    superpowersWorktrees: [],
    evalsSha: 'e'.repeat(40),
    gauntletSha: '9'.repeat(40),
  };
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
    snapshotVerify: () => {
      verifies += 1;
      if (verifies >= 2 && !repaired)
        throw new SnapshotDriftError('worktree HEAD moved');
    },
    repairSnapshot: () => {
      repaired = true;
      return repairedHandle;
    },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.emitLine(`run_allocated: run-${child.pid}`);
  await tick(h.clock, 1); // wave 2: drift -> the full D-11 sequence runs
  expect(repaired).toBe(true);
  const events = journalEvents(h.campaignDir);
  // (3) affected in-flight block killed + aborted.
  expect(
    events.some(
      (e) => e.type === 'aborted' && e.payload.block_id === 'c1:scn:b1',
    ),
  ).toBe(true);
  // (6) rerun re-entry: reserve- and count-neutral fresh instance.
  const rerun = mintRecords(h.campaignDir).find((m) => m.kind === 'rerun');
  expect(rerun).toMatchObject({
    block_id: 'c1:scn:b1',
    replacement_block_id: 'c1:scn:b1:i1',
    reason: 'snapshot_drift',
    reserve_activation: false,
  });
  // The successor re-admits from aborted via rerun_of (E7.1 edge).
  const readmit = eventsOf(h.campaignDir, 'block_admitted').find(
    (e) => e.payload.block_id === 'c1:scn:b1:i1',
  );
  expect(readmit!.payload.rerun_of).toBe('c1:scn:b1');
  // (5)+(banner) admission resumed only after the clean re-verify.
  expect(written.join('')).toMatch(
    /resume: admission resumed \(snapshot repaired/,
  );
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

test('sidecar ENOSPC enters the D-13 storage pause: ballast released, storage_paused journaled, outcome storage_paused', async () => {
  const h = harness();
  // A live sampler seam needs a fresh sidecar sample for the liveness guard.
  writeFileSync(
    join(h.campaignDir, 'contention-telemetry.jsonl'),
    `${JSON.stringify({ ts_ms: 1000, load1: 0, mem_available_bytes: 8 * 2 ** 30, swap_used_bytes: 0, process_count: 100, disk_free_bytes: 90 * 2 ** 30, breach: [] })}\n`,
  );
  let hooks: DispatchSamplerHooks | null = null;
  const scripted: DispatchSamplerSeam = {
    start(captured) {
      hooks = captured;
      return () => {};
    },
  };
  const args: DispatchRunArgs = { ...h.args, sampler: scripted };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  expect(existsSync(join(h.campaignDir, '.ballast'))).toBe(true);
  // D-13 step 1, second detector: the sampler hits the full volume first.
  hooks!.onSampleError(
    Object.assign(new Error('write failed'), { code: 'ENOSPC' }),
  );
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  expect(existsSync(join(h.campaignDir, '.ballast'))).toBe(false); // step 3: ballast released
  const types = journalTypes(h.campaignDir);
  expect(types).toContain('storage_paused'); // step 4 landed (space exists here)
  expect(existsSync(join(h.campaignDir, '.storage-paused'))).toBe(false); // marker only when step 4 cannot land
});

// ---------------------------------------------------------------------------
// Defect-addendum coverage (C5 / C9 / C10)
// ---------------------------------------------------------------------------

test('terminal spend journals the ACTUAL run cost from run artifacts, not the registration estimate (C9)', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  const [childA, childB] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  childB!.child.emitLine(`run_allocated: run-${childB!.child.pid}`);
  await tick(h.clock, 1);
  // arm_a's run composed a verdict carrying actual economics; arm_b's run
  // dir is absent, so its terminal spend falls back to the registration
  // estimate (the honest available number).
  const runDir = join(h.campaignDir, 'results', `run-${childA!.child.pid}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'verdict.json'),
    JSON.stringify({
      final: 'pass',
      final_reason: 'ok',
      economics: { total_est_cost_usd: 7.25 },
    }),
  );
  childA!.child.exit({ code: 0, signal: null });
  childB!.child.exit({ code: 0, signal: null });
  const outcome = await run;
  expect(outcome.status).toBe('completed');
  const spends = eventsOf(h.campaignDir, 'budget_event')
    .filter((e) => e.payload.kind === 'spend')
    .map((e) => e.payload.amount_usd);
  expect(spends).toEqual([7.25, 2]); // actual artifact cost, then arm_b's estimate fallback
});

test('instance-graph validator (C5): double reserve selection, duplicate predecessors, cross-arm links, and mint-into-replaced cycles refuse', () => {
  const campaign = campaignDoc({
    blocks: [
      {
        block_id: 'c1:scn:b1',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'],
      },
      {
        block_id: 'c1:scn:b2',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r2', 'c1:scn:arm_b:r2'],
      },
      {
        block_id: 'c1:scn:x1',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:x1', 'c1:scn:arm_b:x1'],
        slot: 'reserve',
      },
    ],
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
        sample_id: 'c1:scn:arm_a:r2',
        cell: 'c1:scn',
        arm: 'arm_a',
        replicate: 2,
      },
      {
        sample_id: 'c1:scn:arm_b:r2',
        cell: 'c1:scn',
        arm: 'arm_b',
        replicate: 2,
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
  });
  const roster = [
    {
      sample_id: 'c1:scn:arm_a:x1',
      arm: 'arm_a',
      supersedes: 'c1:scn:arm_a:r1',
    },
    {
      sample_id: 'c1:scn:arm_b:x1',
      arm: 'arm_b',
      supersedes: 'c1:scn:arm_b:r1',
    },
  ];
  const mint = {
    block_id: 'c1:scn:b1',
    replacement_block_id: 'c1:scn:x1',
    reason: 'subject_crashed' as const,
    kind: 'replacement' as const,
    reserve_activation: true,
    roster,
  };
  expect(() => assertInstanceGraph({ campaign, mints: [mint] })).not.toThrow();
  // The same reserve activated twice — double selection within a cell (C6).
  const secondSelection = {
    ...mint,
    block_id: 'c1:scn:b2',
    roster: [
      {
        sample_id: 'c1:scn:arm_a:x1',
        arm: 'arm_a',
        supersedes: 'c1:scn:arm_a:r2',
      },
      {
        sample_id: 'c1:scn:arm_b:x1',
        arm: 'arm_b',
        supersedes: 'c1:scn:arm_b:r2',
      },
    ],
  };
  expect(() =>
    assertInstanceGraph({ campaign, mints: [mint, secondSelection] }),
  ).toThrow(DispatcherError);
  // Duplicate predecessor: one block replaced twice.
  expect(() => assertInstanceGraph({ campaign, mints: [mint, mint] })).toThrow(
    DispatcherError,
  );
  // Cross-arm link: a roster entry superseding the OTHER arm's sample.
  const crossArm = {
    ...mint,
    roster: [
      {
        sample_id: 'c1:scn:arm_a:x1',
        arm: 'arm_a',
        supersedes: 'c1:scn:arm_b:r1',
      },
      {
        sample_id: 'c1:scn:arm_b:x1',
        arm: 'arm_b',
        supersedes: 'c1:scn:arm_a:r1',
      },
    ],
  };
  expect(() => assertInstanceGraph({ campaign, mints: [crossArm] })).toThrow(
    DispatcherError,
  );
  // Mint into an already-replaced block: a cycle in the instance graph.
  const mintBack = {
    block_id: 'c1:scn:x1',
    replacement_block_id: 'c1:scn:b1',
    reason: 'snapshot_drift' as const,
    kind: 'rerun' as const,
    reserve_activation: false,
    roster: [
      { sample_id: 'c1:scn:arm_a:x1', arm: 'arm_a' },
      { sample_id: 'c1:scn:arm_b:x1', arm: 'arm_b' },
    ],
  };
  expect(() =>
    assertInstanceGraph({ campaign, mints: [mint, mintBack] }),
  ).toThrow(DispatcherError);
});

test('killGroupVerified (C10): TERMs a REAL detached process group, awaits verified death', async () => {
  const child = spawnProcess('sleep', ['300'], {
    detached: true,
    stdio: 'ignore',
  });
  expect(child.pid).toBeDefined();
  const pid = child.pid!;
  child.unref();
  const written: string[] = [];
  const result = await killGroupVerified({
    pgid: pid,
    birthTsMs: realProcessIdentityProbe.startTimeMs(pid),
    identity: realProcessIdentityProbe,
    signal: realGroupSignaler,
    clock: new RealClock(),
    stream: { write: (s: string) => written.push(s) },
    graceSeconds: 5,
  });
  expect(result).toBe('dead');
  expect(realGroupSignaler(pid, 0)).toBe('esrch');
});

// ---------------------------------------------------------------------------
// Fix round 1: verified-death hard precondition, stranded allocations,
// evidence arbitration, D-13 storage-fatal, C9 failed admission append.
// ---------------------------------------------------------------------------

test('killGroupVerified refuses identity-unknown without signaling, and reports a group that survives TERM+KILL (C10)', async () => {
  // Identity unknown (unreadable start time): NOTHING is ever signaled.
  const calls: (NodeJS.Signals | 0)[] = [];
  const recorder: GroupSignaler = (_pgid, sig) => {
    calls.push(sig);
    return 'ok';
  };
  const unknownIdentity: ProcessIdentityProbe = {
    exists: () => 'alive',
    startTimeMs: () => null,
  };
  const silent = { write: () => {} };
  expect(
    await killGroupVerified({
      pgid: 424242,
      birthTsMs: 999,
      identity: unknownIdentity,
      signal: recorder,
      clock: new FakeClock(0),
      stream: silent,
      graceSeconds: 5,
    }),
  ).toBe('unknown');
  // A missing birth capture is identity-unknown too (fail-closed).
  expect(
    await killGroupVerified({
      pgid: 424242,
      birthTsMs: null,
      identity: IDENTITY,
      signal: recorder,
      clock: new FakeClock(0),
      stream: silent,
      graceSeconds: 5,
    }),
  ).toBe('unknown');
  expect(calls.length).toBe(0); // never signaled blind
  // A group that survives TERM AND KILL past both graces reports 'alive'.
  const alwaysAlive: GroupSignaler = () => 'ok';
  expect(
    await killGroupVerified({
      pgid: 424242,
      birthTsMs: 1,
      identity: IDENTITY,
      signal: alwaysAlive,
      clock: new RealClock(),
      stream: silent,
      graceSeconds: 0.05,
    }),
  ).toBe('alive');
});

test('killGroupVerified escalates TERM->KILL on a REAL TERM-ignoring group (C10 uncooperative child)', async () => {
  // bash traps TERM and respawns its sleep children forever; only the KILL
  // escalation can end the group.
  const child = spawnProcess(
    'bash',
    ['-c', 'trap "" TERM; while true; do sleep 60; done'],
    { detached: true, stdio: 'ignore' },
  );
  expect(child.pid).toBeDefined();
  const pid = child.pid!;
  child.unref();
  // Let the trap install before signaling.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = await killGroupVerified({
    pgid: pid,
    birthTsMs: realProcessIdentityProbe.startTimeMs(pid),
    identity: realProcessIdentityProbe,
    signal: realGroupSignaler,
    clock: new RealClock(),
    stream: { write: () => {} },
    graceSeconds: 0.3,
  });
  expect(result).toBe('dead');
  expect(realGroupSignaler(pid, 0)).toBe('esrch');
});

test('an unkillable group aborts the cancel sequence: no aborted, no campaign_cancelled, loud operator action (C10 hard precondition)', async () => {
  const h = harness();
  const written: string[] = [];
  let signalHandler: ((signal?: NodeJS.Signals) => void) | null = null;
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
    installSignals: (handler) => {
      signalHandler = handler;
      return () => {};
    },
    signalGroup: () => 'ok', // the group NEVER dies
    killGraceSeconds: 0.05,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) {
    child.emitLine(`run_allocated: run-${child.pid}`);
  }
  // Operator cancel: marker first, then the signal (D-12).
  writeFileSync(join(h.campaignDir, 'cancel-request'), '1000\nstop\n', {
    flag: 'wx',
  });
  expect(signalHandler).not.toBeNull();
  signalHandler!('SIGTERM');
  // Drive the TERM->wait->KILL->wait escalations for both children.
  for (let i = 0; i < 8; i += 1) await tick(h.clock, 1);
  const outcome = await run;
  // Cancel INCOMPLETE: verified death is a hard precondition — nothing was
  // journaled for the unverified blocks and the exit stays resumable.
  expect(outcome.status).toBe('signalled');
  const types = journalTypes(h.campaignDir);
  expect(types).not.toContain('aborted');
  expect(types).not.toContain('campaign_cancelled');
  expect(written.join('')).toMatch(/operator action/);
});

test('a latched sibling allocation is drained and journaled BEFORE the mint dispositions (Important 1, R-JRN-8)', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  const [childA, childB] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  // childB's allocation line is LATCHED but its callback section has not
  // run (buffered child output): push directly into the latch.
  childB!.child.stdout.push(`run_allocated: run-${childB!.child.pid}`);
  // arm_a fails typed -> the mint must drain childB's allocation first.
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  const allocs = eventsOf(h.campaignDir, 'run_allocated');
  expect(allocs.map((a) => a.payload.run_id)).toContain(
    `run-${childB!.child.pid}`,
  );
  const drained = allocs.find(
    (a) => a.payload.run_id === `run-${childB!.child.pid}`,
  );
  const minted = mintRecords(h.campaignDir)[0];
  expect(minted).toBeDefined();
  // The allocation landed BEFORE the mint (and its dispositions) — the
  // disposition then applied from 'spawned', still a legal source.
  expect(drained!.seq).toBeLessThan(minted!.seq);
  const dispositions = eventsOf(h.campaignDir, 'sample_disposition');
  expect(
    dispositions.some((d) => d.payload.sample_id === 'c1:scn:arm_b:r1'),
  ).toBe(true);
  // Finish: childB (excluded, retained evidence) exits; the minted reserve
  // runs to completion.
  childB!.child.exit({ code: 0, signal: null });
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

test('evidence arbitration: terminal grader billing exhaustion outranks an earlier live subject 429 (Important 4)', async () => {
  const h = harness();
  // Distinct provider families so the live line matches ONLY the subject:
  // the grader credential is openai-chat.
  const graderOpenAi = {
    model: 'm',
    harnesses: ['claude'],
    api: 'openai-chat',
    auth: 'api-key',
    api_key_env: 'KEY_G',
    compat: {},
    max_concurrency: 2,
  } as Credential;
  const args: DispatchRunArgs = {
    ...h.args,
    credentials: { ...h.credentials, grader_cred: graderOpenAi },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  const [childA, childB] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  childB!.child.emitLine(`run_allocated: run-${childB!.child.pid}`);
  // Live: an anthropic-shaped 429 -> subject evidence (rank 4), pool block.
  childA!.child.emitStderr('{"type":"rate_limit_error"} retry-after: 30');
  // Terminal: the newest gauntlet result carries OpenAI billing exhaustion
  // (grader context, rank 2) — it must OVERRIDE the live subject match.
  const runDir = join(h.campaignDir, 'results', `run-${childA!.child.pid}`);
  mkdirSync(join(runDir, 'gauntlet-agent', 'results', 'r1'), {
    recursive: true,
  });
  writeFileSync(
    join(runDir, 'gauntlet-agent', 'results', 'r1', 'result.json'),
    JSON.stringify({
      summary: 'grader died: {"error":{"code":"insufficient_quota"}}',
    }),
  );
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  const failures = eventsOf(h.campaignDir, 'instrument_failure');
  expect(failures.length).toBe(1);
  expect(failures[0]!.payload.cause).toBe('grader_billing_exhausted');
  // Finish the innocent arm + the minted reserve (the subject pool cooldown
  // from the live 429 must expire first).
  childB!.child.exit({ code: 0, signal: null });
  await tick(h.clock, 31);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

test('performStoragePause: BOTH durable carriers failing is a thrown storage-fatal, and the kill still ran first (Important 5, D-13)', async () => {
  const campaignDir = mkdtempSync(join(tmpdir(), 'disp-fatal-'));
  initJournalDb(campaignDir);
  writeFileSync(join(campaignDir, '.ballast'), 'x');
  // A deposed writer: every journal append fails (the fence refuses).
  const writer = electWriter({
    campaignDir,
    clock: new FakeClock(0),
    identity: IDENTITY,
  });
  writer.abandonLease();
  const successor = electWriter({
    campaignDir,
    clock: new FakeClock(0),
    identity: IDENTITY,
  });
  successor.release();
  // The marker path is already occupied: the O_EXCL create fails too.
  writeFileSync(join(campaignDir, '.storage-paused'), 'occupied');
  let killed = false;
  const written: string[] = [];
  await expect(
    performStoragePause({
      campaignDir,
      writer,
      killAll: async () => {
        killed = true;
        return [];
      },
      stream: { write: (s: string) => written.push(s) },
    }),
  ).rejects.toThrow(/storage pause FATAL/);
  // Pinned step order: the kill (step 5) ran before the fatal surfaced.
  expect(killed).toBe(true);
  expect(existsSync(join(campaignDir, '.ballast'))).toBe(false);
});

test('a failed admission append aborts the admission transaction BEFORE any spawn (Important 6 / C9)', async () => {
  const h = harness();
  const real = electWriter({
    campaignDir: h.campaignDir,
    clock: h.clock,
    identity: IDENTITY,
    campaign: campaignDoc(),
  });
  // The admission bundle fails ENOSPC-shaped, including the D-13 retry;
  // everything else (the storage_paused event) passes through.
  const journal: DispatchJournal = {
    appendEvent: (input) => real.appendEvent(input),
    appendEvents: (inputs) => {
      if (inputs.some((i) => i.type === 'block_admitted')) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return real.appendEvents(inputs);
    },
    readEvents: (afterSeq) => real.readEvents(afterSeq),
    readBudgetPosition: () => real.readBudgetPosition(),
    release: () => real.release(),
  };
  const run = runCampaignDispatch({ ...h.args, journal });
  await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  // C9: the failed append aborted the admission transaction — zero spawn,
  // zero local allocation, nothing admission-shaped durable.
  expect(h.spawner.spawned.length).toBe(0);
  const types = journalTypes(h.campaignDir);
  expect(types).toContain('storage_paused');
  expect(types).not.toContain('block_admitted');
  expect(types).not.toContain('attempt_created');
  expect(types).not.toContain('run_allocated');
  expect(existsSync(join(h.campaignDir, '.ballast'))).toBe(false);
});
