import { afterAll, expect, test } from 'bun:test';
import { spawn as spawnProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  ALLOCATION_WAIT_BUDGET_SECONDS,
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
  type EventInput,
  electWriter,
  initJournalDb,
  type JournalFsOps,
  type JournalWriter,
  openJournalRead,
  replayEvents,
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
import { campaignDigest } from '../src/contracts/campaign/digest.ts';
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
  /** The `--out-root` the dispatcher gave this child. A real campaign child
   *  ALLOCATES its run dir before its first provider token — empty, unpriced
   *  — and only writes the composed verdict, with its economics, at
   *  composition. The fake follows that order: allocation creates the dir,
   *  exit composes. An allocated run whose dir never appears is corruption
   *  in production and the dispatcher fail-stops on it; a run dir with no
   *  composed verdict is the ordinary "child died before composing" case the
   *  terminal classifier documents, which `composes = false` models. */
  readonly outRoot: string | null;
  /** false = this child dies before composing: the run dir stays unpriced
   *  and the verdict read at terminal returns null. */
  composes = true;
  private allocatedRunId: string | null = null;
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
  constructor(pid: number, outRoot: string | null = null) {
    this.pid = pid;
    this.outRoot = outRoot;
  }
  emitLine(line: string): void {
    const allocated = /^run_allocated:\s*(\S+)$/.exec(line);
    if (allocated?.[1] !== undefined && this.outRoot !== null) {
      this.allocatedRunId = allocated[1];
      mkdirSync(join(this.outRoot, allocated[1]), { recursive: true });
    }
    this.stdout.push(line);
    for (const cb of this.stdoutCbs) cb(line);
  }
  emitStderr(line: string): void {
    this.stderr.push(line);
    for (const cb of this.stderrCbs) cb(line);
  }
  exit(info: ChildExitInfo): void {
    // Composition: the verdict and its economics appear now, not at
    // allocation. A test that seeded its own verdict keeps it.
    if (
      this.composes &&
      this.outRoot !== null &&
      this.allocatedRunId !== null &&
      !existsSync(join(this.outRoot, this.allocatedRunId, 'verdict.json'))
    ) {
      seedCompletedRunDir(this.outRoot, this.allocatedRunId, { costUsd: 0.25 });
    }
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
    const outRootIdx = spec.args.indexOf('--out-root');
    const child = new FakeChild(
      this.nextPid++,
      outRootIdx >= 0 ? (spec.args[outRootIdx + 1] ?? null) : null,
    );
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
  const doc = {
    schema_version: 1,
    campaign_id: 'c'.repeat(64), // placeholder: re-stamped below
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
    digest: 'c'.repeat(64), // placeholder: re-stamped below
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
    // AUTHENTICATES it at startup, so the identity is stamped from the
    // content's own digest rather than pinned to a literal.
  } as unknown as Campaign;
  const digest = campaignDigest(doc);
  return { ...doc, digest, campaign_id: digest };
}

interface HarnessArgs {
  campaignDir: string;
  spawner: FakeSpawner;
  clock: FakeClock;
  credentials: Record<string, Credential>;
}
/** A completed run dir as the composer would leave it: the verdict the
 *  terminal classification reads, the trajectory the exposure sensor reads,
 *  and (unless costUsd is null) the priced economics the terminal spend
 *  comes from. */
function seedCompletedRunDir(
  resultsRoot: string,
  runId: string,
  opts: { costUsd: number | null; final?: 'pass' | 'fail' | 'indeterminate' },
): void {
  const dir = join(resultsRoot, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({
      final: opts.final ?? 'pass',
      final_reason: 'fixture',
      economics:
        opts.costUsd === null ? null : { total_est_cost_usd: opts.costUsd },
    }),
  );
  writeFileSync(
    join(dir, 'trajectory.json'),
    JSON.stringify({ steps: [{ timestamp: '2026-08-29T00:00:00.000Z' }] }),
  );
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
/** Two primary blocks + one reserve in one cell, with caps wide enough for
 *  both primaries in flight at once (global 4, every credential 4). */
function twoBlockHarness(): ReturnType<typeof harness> & { doc: Campaign } {
  const base = campaignDoc();
  const sample = (id: string, arm: string, replicate: number) => ({
    sample_id: id,
    cell: 'c1:scn',
    arm,
    replicate,
  });
  const overrides = {
    contention: { ...base.contention, global_run_cap: 4 },
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
      sample('c1:scn:arm_a:r1', 'arm_a', 1),
      sample('c1:scn:arm_b:r1', 'arm_b', 1),
      sample('c1:scn:arm_a:r2', 'arm_a', 2),
      sample('c1:scn:arm_b:r2', 'arm_b', 2),
      sample('c1:scn:arm_a:x1', 'arm_a', 1),
      sample('c1:scn:arm_b:x1', 'arm_b', 1),
    ],
  };
  const h = harness(overrides);
  const credentials = Object.fromEntries(
    Object.entries(h.credentials).map(([name, cred]) => [
      name,
      { ...cred, max_concurrency: 4 },
    ]),
  );
  return {
    ...h,
    credentials,
    args: { ...h.args, credentials },
    doc: campaignDoc(overrides),
  };
}
/** The `kind` of a budget_event input (the writer types payloads as
 *  unknown until the schema parses them), or null for any other event. */
function budgetEventKind(input: EventInput | undefined): string | null {
  if (input === undefined || input.type !== 'budget_event') return null;
  const kind = (input.payload as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}
/** A journal whose volume is full for exactly the lone superseding
 *  estimate_inflight snapshot — the settle paths' E7.7 append — including
 *  its D-13 retry; everything else (the storage_paused record, any
 *  resolution bundle that wrongly follows) lands. */
function snapshotEnospcJournal(real: JournalWriter): DispatchJournal {
  return {
    appendEvent: (input) => real.appendEvent(input),
    appendEvents: (inputs) => {
      if (
        inputs.length === 1 &&
        budgetEventKind(inputs[0]) === 'estimate_inflight'
      ) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return real.appendEvents(inputs);
    },
    readEvents: (afterSeq) => real.readEvents(afterSeq),
    readBudgetPosition: () => real.readBudgetPosition(),
    release: () => real.release(),
  };
}
/** A sidecar through the REAL parseSidecar/evaluateContention path: a
 *  sustain_k=3 crossing run (load1 9 -> 9/4 cores = 2.25 > threshold 2;
 *  load1_per_core normalizes by the REGISTERED cpu_cores) closed by 3
 *  in-bounds samples — the evaluator derives breach window [2020, 2060]
 *  from these exact lines, overlapping every block admitted at ~2000ms
 *  (the first tick advances the FakeClock to 2s before the first wave
 *  runs) -> 'invalid'. */
function writeInvalidatingSidecar(campaignDir: string): void {
  const line = (ts_ms: number, load1: number) =>
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
    join(campaignDir, 'contention-telemetry.jsonl'),
    `${[2000, 2010, 2020]
      .map((t) => line(t, 9))
      .concat([2040, 2050, 2060].map((t) => line(t, 0)))
      .join('\n')}\n`,
  );
}
const BREACH_WINDOW = {
  startTsMs: 2020,
  endTsMs: 2060,
  metrics: ['load1_per_core'],
};

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

test('a mantle grader credential projects the grader-only alias env into every campaign child', async () => {
  const h = harness();
  h.credentials['grader_cred'] = {
    model: 'anthropic.claude-opus-4-8',
    harnesses: ['claude'],
    api: 'mantle',
    auth: 'bedrock-bearer',
    api_key_env: 'BEARER_G',
    region: 'us-east-1',
    compat: {},
    max_concurrency: 2,
  } as Credential;
  setProcessEnv('BEARER_G', 'fixture-bearer-g');
  try {
    const run = runCampaignDispatch(h.args);
    await tick(h.clock, 1);
    expect(h.spawner.spawned.length).toBe(2);
    for (const { spec } of h.spawner.spawned) {
      expect(spec.env['QUORUM_GRADER_SOURCE_MODE']).toBe('appliance-scoped');
      expect(spec.env['QUORUM_GRADER_ANTHROPIC_API_KEY']).toBe(
        'fixture-bearer-g',
      );
      expect(spec.env['QUORUM_GRADER_ANTHROPIC_BASE_URL']).toBe(
        'https://bedrock-mantle.us-east-1.api.aws/anthropic',
      );
      // The canonical SDK names stay out of the child env: they belong to
      // the agent under test there, and the bearer must not reach gauntlet
      // as an OAuth token.
      expect(spec.env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
      expect(spec.env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(spec.env['ANTHROPIC_BASE_URL']).toBeUndefined();
    }
    for (const { child } of h.spawner.spawned) {
      child.emitLine(`run_allocated: run-${child.pid}`);
    }
    await tick(h.clock, 1);
    for (const { child } of h.spawner.spawned)
      child.exit({ code: 0, signal: null });
    await run;
  } finally {
    deleteProcessEnv('BEARER_G');
  }
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

test('startup authenticates the frozen document: a tampered budget refuses before any admission', async () => {
  const h = harness();
  // A hand-edited ceiling: schema-valid, digest-invalid. Nothing may admit
  // against a document whose content no longer matches its identity.
  const doc = JSON.parse(
    readFileSync(join(h.campaignDir, 'campaign.json'), 'utf8'),
  ) as Campaign;
  writeFileSync(
    join(h.campaignDir, 'campaign.json'),
    JSON.stringify({
      ...doc,
      budget: { ...doc.budget, usd_all_in: 500_000 },
    }),
  );
  await expect(runCampaignDispatch(h.args)).rejects.toThrow(
    /not the digest of its content/,
  );
  expect(h.spawner.spawned).toHaveLength(0);
});

test('startup authenticates closure: a sample whose cell is not registered refuses instead of pricing it at zero', async () => {
  const h = harness();
  const doc = JSON.parse(
    readFileSync(join(h.campaignDir, 'campaign.json'), 'utf8'),
  ) as Campaign;
  const cells: Campaign['cells'] = [];
  const tampered = { ...doc, cells };
  writeFileSync(
    join(h.campaignDir, 'campaign.json'),
    JSON.stringify({
      ...tampered,
      digest: campaignDigest(tampered),
      campaign_id: campaignDigest(tampered),
    }),
  );
  await expect(runCampaignDispatch(h.args)).rejects.toThrow(
    /which is not a registered cell/,
  );
  expect(h.spawner.spawned).toHaveLength(0);
});

test('results root: controller and child resolve ONE absolute path, even when the operator names a relative one', async () => {
  const relativeResults = relative(
    process.cwd(),
    mkdtempSync(join(tmpdir(), 'rel-results-')),
  );
  const h = harness();
  const run = runCampaignDispatch({
    ...h.args,
    resultsRoot: relativeResults,
    // The child runs with cwd = the campaign's evals worktree, so a relative
    // --out-root would land its run dirs somewhere the controller never
    // looks. Absolute is the only path both sides agree on.
  });
  await tick(h.clock, 1);
  const [first] = h.spawner.spawned;
  const argv = first!.spec.args;
  const outRoot = argv[argv.indexOf('--out-root') + 1];
  expect(isAbsolute(outRoot!)).toBe(true);
  expect(outRoot).toBe(resolve(relativeResults));
  for (const { child } of h.spawner.spawned) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await run;
});

test('429 role attribution: an untagged child-stderr 429 cools the SUBJECT pool only, even when subject and grader share a provider', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  const [first] = h.spawner.spawned;
  // Same-provider subject and grader (the harness credentials are all
  // anthropic): the text is the subject child's own stderr, so nothing about
  // it is grader evidence.
  first!.child.emitStderr('{"type":"rate_limit_error"} retry-after: 30');
  first!.child.emitLine(`run_allocated: run-${first!.child.pid}`);
  first!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  const blocked = eventsOf(h.campaignDir, 'pool_blocked');
  expect(blocked.map((e) => e.payload.pool_key)).toEqual([
    'cred_a|anthropic|m',
  ]);
  expect(
    eventsOf(h.campaignDir, 'instrument_failure').map((e) => e.payload.cause),
  ).toEqual(['subject_rate_limited']);
  for (const { child } of h.spawner.spawned.slice(1)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await tick(h.clock, 31);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await run;
});

test("429 role attribution: a gauntlet-result 429 is the GRADER's evidence — it cools the grader pool and classifies grader_rate_limited", async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  const [first] = h.spawner.spawned;
  const runId = `run-${first!.child.pid}`;
  // The Gauntlet-Agent's own composed result carries the 429 body: grader
  // evidence by provenance, whatever the subject credential looks like.
  const resultDir = join(
    h.campaignDir,
    'results',
    runId,
    'gauntlet-agent',
    'results',
    'g1',
  );
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(
    join(resultDir, 'result.json'),
    JSON.stringify({ summary: '{"type":"rate_limit_error"} retry-after: 30' }),
  );
  first!.child.emitLine(`run_allocated: ${runId}`);
  first!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  const blocked = eventsOf(h.campaignDir, 'pool_blocked');
  expect(blocked.map((e) => e.payload.pool_key)).toEqual([
    'grader_cred|anthropic|m',
  ]);
  expect(
    eventsOf(h.campaignDir, 'instrument_failure').map((e) => e.payload.cause),
  ).toEqual(['grader_rate_limited']);
  // The clamped retry-after is journaled as the grader pool's cooldown.
  expect(blocked[0]!.payload.until_ts_ms).toBe(blocked[0]!.ts_ms + 30_000);
  for (const { child } of h.spawner.spawned.slice(1)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await tick(h.clock, 31); // past the cooldown: the replacement admits
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

test('an allocated child that dies BEFORE composing has no verdict: the exit-code heuristic classifies it and its cost is unknowable', async () => {
  // The production condition the terminal path documents — a child that
  // died before composing has no verdict, so classification falls to the
  // exit-code heuristic and there is no actual cost to journal.
  const h = harness();
  const written: string[] = [];
  const run = runCampaignDispatch({
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
  });
  await tick(h.clock, 1);
  const [first] = h.spawner.spawned;
  first!.child.composes = false; // dies before composition
  first!.child.emitLine(`run_allocated: run-${first!.child.pid}`);
  first!.child.exit({ code: 137, signal: 'SIGKILL' });
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(1)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await tick(h.clock, 1);
  const outcome = await run;
  // The run dir exists (it was allocated) but holds no composed verdict, so
  // the cost is unknowable and the campaign fail-stops rather than
  // continuing on a budget position that dropped it.
  expect(existsSync(join(h.args.resultsRoot!, `run-${first!.child.pid}`))).toBe(
    true,
  );
  expect(outcome.status).toBe('halted');
  expect(outcome.reason).toMatch(/accounting gap/);
  // Classified by the exit-code heuristic, not by a verdict.
  expect(
    eventsOf(h.campaignDir, 'instrument_failure').map((e) => e.payload.cause),
  ).toEqual(['subject_crashed']);
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
  // Terminal spend is the ACTUAL cost from the run artifacts, so b1's runs
  // must leave the artifacts that carry it: 1 + 2 spent, exactly the frozen
  // estimates the budget arithmetic below assumes.
  for (const [i, { child }] of h.spawner.spawned.entries()) {
    const runId = `run-${child.pid}`;
    seedCompletedRunDir(h.args.resultsRoot!, runId, {
      costUsd: i === 0 ? 1 : 2,
    });
    child.emitLine(`run_allocated: ${runId}`);
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
  writeInvalidatingSidecar(h.campaignDir);
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
  hooks!.onBreachExit(BREACH_WINDOW);
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
  // arm_a's run composed a verdict carrying 7.25 in actual economics; arm_b's
  // carries the fixture default. Both spends are ARTIFACT costs — the frozen
  // registration estimates (1 and 2) never reach a spend row.
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
  expect(spends).toEqual([7.25, 0.25]); // actuals only; never 1 or 2
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

test('killGroupVerified: a leaderless group is NOT a dead group — a gone or reused leader must be confirmed by an ESRCH on the GROUP (R-RCV-1)', async () => {
  const silent = { write: () => {} };
  const leaderGone: ProcessIdentityProbe = {
    exists: () => 'esrch',
    startTimeMs: () => null,
  };
  const reusedLeader: ProcessIdentityProbe = {
    exists: () => 'alive',
    startTimeMs: () => 99, // != the recorded birth below
  };
  const probes: (NodeJS.Signals | 0)[] = [];
  const liveGroup: GroupSignaler = (_pgid, sig) => {
    probes.push(sig);
    return 'ok';
  };
  const goneGroup: GroupSignaler = () => 'esrch';
  const call = (identity: ProcessIdentityProbe, signal: GroupSignaler) =>
    killGroupVerified({
      pgid: 424242,
      birthTsMs: 1,
      identity,
      signal,
      clock: new FakeClock(0),
      stream: silent,
      graceSeconds: 5,
    });
  // Leader ESRCH, group still answering: live descendants, identity unknown.
  expect(await call(leaderGone, liveGroup)).toBe('unknown');
  // Reused leader pid, group still answering: likewise never permitting.
  expect(await call(reusedLeader, liveGroup)).toBe('unknown');
  expect(probes).toEqual([0, 0]); // probed only; never signaled blind
  // Group ESRCH too: THEN the permitting results hold.
  expect(await call(leaderGone, goneGroup)).toBe('dead');
  expect(await call(reusedLeader, goneGroup)).toBe('stale');
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
  // run (buffered child output): push directly into the latch. The run dir
  // is seeded by hand because that bypass skips the fake child's own
  // allocation — a real child allocates the dir before its first token.
  seedCompletedRunDir(h.args.resultsRoot!, `run-${childB!.child.pid}`, {
    costUsd: 0.25,
  });
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

/** A campaign dir whose journal writer is DEPOSED: every append fails (the
 *  generation fence refuses), so step 4's storage_paused can never land and
 *  the marker is the only durable carrier left. */
function deposedPauseFixture(): { campaignDir: string; writer: JournalWriter } {
  const campaignDir = mkdtempSync(join(tmpdir(), 'disp-fatal-'));
  initJournalDb(campaignDir);
  writeFileSync(join(campaignDir, '.ballast'), 'x');
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
  return { campaignDir, writer };
}

/** A pass-through JournalFsOps that names every durable operation it
 *  performs, so a test can pin the fsync ORDER a marker write must follow. */
function markerFsRecorder(): { ops: JournalFsOps; calls: string[] } {
  const calls: string[] = [];
  const names = new Map<number, string>();
  const label = (fd: number) => names.get(fd) ?? String(fd);
  return {
    calls,
    ops: {
      openExclusive: (path) => {
        const fd = openSync(path, 'wx');
        names.set(fd, basename(path));
        calls.push(`open-wx:${basename(path)}`);
        return fd;
      },
      openRead: (path) => {
        const fd = openSync(path, 'r');
        names.set(fd, basename(path));
        calls.push(`open-r:${basename(path)}`);
        return fd;
      },
      close: (fd) => {
        calls.push(`close:${label(fd)}`);
        closeSync(fd);
      },
      write: (fd, data) => {
        calls.push(`write:${label(fd)}`);
        return writeSync(fd, data as string);
      },
      fsync: (fd) => {
        calls.push(`fsync:${label(fd)}`);
        fsyncSync(fd);
      },
      rename: (from, to) => {
        calls.push(`rename:${basename(from)}->${basename(to)}`);
        renameSync(from, to);
      },
      link: (from, to) => {
        calls.push(`link:${basename(from)}->${basename(to)}`);
        linkSync(from, to);
      },
      unlink: (path) => {
        calls.push(`unlink:${basename(path)}`);
        unlinkSync(path);
      },
      stat: () => {
        throw new Error('unexpected stat');
      },
      exists: (path) => {
        calls.push(`exists:${basename(path)}`);
        return existsSync(path);
      },
    },
  };
}

test('performStoragePause: the .storage-paused marker is fsynced with its directory — a crash cannot lose the pause record (D-13 step 6)', async () => {
  const { campaignDir, writer } = deposedPauseFixture();
  const { ops, calls } = markerFsRecorder();
  await performStoragePause({
    campaignDir,
    writer,
    killAll: async () => [],
    stream: { write: () => {} },
    fsOps: ops,
  });
  expect(existsSync(join(campaignDir, '.storage-paused'))).toBe(true);
  // The marker is STAGED, fsynced, then LINKED onto the final name: atomic
  // and exclusive, so the final name only ever appears complete and a
  // concurrent writer cannot be overwritten.
  const durable = calls.filter((c) => !c.startsWith('exists:'));
  const staged = durable[0]!.replace('open-wx:', '');
  expect(staged).toMatch(/^\.storage-paused\.stage\./);
  expect(durable).toEqual([
    `open-wx:${staged}`,
    // The pause marker's body is empty, so there are no bytes to write —
    // the fsync and the rename are what make it durable.
    `fsync:${staged}`,
    `close:${staged}`,
    `link:${staged}->.storage-paused`,
    `open-r:${basename(campaignDir)}`,
    `fsync:${basename(campaignDir)}`,
    `close:${basename(campaignDir)}`,
    `unlink:${staged}`,
  ]);
});

test('performStoragePause: a marker ALREADY present is the durable record — EEXIST is a success arm, never a fatal (D-13 step 6)', async () => {
  const { campaignDir, writer } = deposedPauseFixture();
  // The marker already exists (an earlier pause, or a racing writer): the
  // O_EXCL create reports EEXIST, but marker presence IS the durable record.
  writeFileSync(join(campaignDir, '.storage-paused'), 'earlier pause');
  const written: string[] = [];
  await performStoragePause({
    campaignDir,
    writer,
    killAll: async () => [],
    stream: { write: (s: string) => written.push(s) },
  });
  expect(existsSync(join(campaignDir, '.ballast'))).toBe(false);
  expect(written.join('')).toMatch(/marker already present/);
});

test('performStoragePause: BOTH durable carriers failing is a thrown storage-fatal that reports the kill state accurately, and the kill still ran first (Important 5, D-13)', async () => {
  const { campaignDir, writer } = deposedPauseFixture();
  // The marker path is occupied by something that is NOT a readable marker
  // file: the create fails and presence supplies no record either.
  mkdirSync(join(campaignDir, '.storage-paused'));
  let killed = false;
  const written: string[] = [];
  let thrown: unknown = null;
  try {
    await performStoragePause({
      campaignDir,
      writer,
      killAll: async () => {
        killed = true;
        return [];
      },
      stream: { write: (s: string) => written.push(s) },
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(DispatcherError);
  const message = (thrown as Error).message;
  expect(message).toMatch(/storage pause FATAL/);
  // The kill state is reported as it actually is — every group verified.
  expect(message).toMatch(/children verified killed/);
  // Pinned step order: the kill (step 5) ran before the fatal surfaced.
  expect(killed).toBe(true);
  expect(existsSync(join(campaignDir, '.ballast'))).toBe(false);
});

test('performStoragePause: an unverified kill is a thrown storage-fatal naming the survivors — the pause record still lands first (Critical remainder, D-13 step 5)', async () => {
  const campaignDir = mkdtempSync(join(tmpdir(), 'disp-survivor-'));
  initJournalDb(campaignDir);
  writeFileSync(join(campaignDir, '.ballast'), 'x');
  const writer = electWriter({
    campaignDir,
    clock: new FakeClock(0),
    identity: IDENTITY,
  });
  const written: string[] = [];
  let thrown: unknown = null;
  try {
    await performStoragePause({
      campaignDir,
      writer,
      killAll: async () => ['pgid 4242 (c1:scn:arm_a:r1#1: alive)'],
      stream: { write: (s: string) => written.push(s) },
    });
  } catch (err) {
    thrown = err;
  } finally {
    writer.release();
  }
  expect(thrown).toBeInstanceOf(DispatcherError);
  const message = (thrown as Error).message;
  expect(message).toMatch(/storage pause FATAL/);
  expect(message).toMatch(/pgid 4242/);
  expect(message).not.toMatch(/already killed/);
  expect(message).toMatch(/operator action/i);
  // The durable pause record landed BEFORE the fatal surfaced.
  expect(journalTypes(campaignDir)).toContain('storage_paused');
  expect(existsSync(join(campaignDir, '.ballast'))).toBe(false);
});

test('a PARTIALLY landed admission append aborts the admission transaction: no spawn, no live block, no local pool/exposure allocation, only the durable prefix in the journal (Important 6 / C9)', async () => {
  const h = harness();
  const real = electWriter({
    campaignDir: h.campaignDir,
    clock: h.clock,
    identity: IDENTITY,
    campaign: campaignDoc(),
  });
  // The journal lands one event per transaction: model the volume filling
  // mid-bundle — the first TWO admission events land (block_admitted + one
  // attempt_created), the third hits ENOSPC, and the D-13 retry of the
  // unlanded suffix hits ENOSPC again (the volume is still full). Single
  // appends (the storage_paused record) pass.
  let bundleCalls = 0;
  const journal: DispatchJournal = {
    appendEvent: (input) => real.appendEvent(input),
    appendEvents: (inputs) => {
      const admissionShaped = inputs.some(
        (i) => i.type === 'block_admitted' || i.type === 'attempt_created',
      );
      if (!admissionShaped) return real.appendEvents(inputs);
      bundleCalls += 1;
      if (bundleCalls === 1) real.appendEvents(inputs.slice(0, 2));
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    },
    readEvents: (afterSeq) => real.readEvents(afterSeq),
    readBudgetPosition: () => real.readBudgetPosition(),
    release: () => real.release(),
  };
  const args: DispatchRunArgs = { ...h.args, journal };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  expect(bundleCalls).toBe(2); // the bundle + its D-13 retry
  // C9 (mutate-after-append): the failed bundle aborted the admission
  // transaction — zero spawn, no live block, no local pool or exposure
  // allocation (the in-memory admission state is empty).
  expect(h.spawner.spawned.length).toBe(0);
  const inspection = args.inspect?.();
  expect(inspection).toBeDefined();
  expect(inspection!.liveBlockIds).toEqual([]);
  expect(inspection!.exposureSampleIds).toEqual([]);
  expect(Object.values(inspection!.poolBusy).every((n) => n === 0)).toBe(true);
  // The journal holds exactly the durable prefix (the one event that landed
  // before ENOSPC) plus the pause record — nothing from the retry, no
  // second attempt_created, no estimate snapshot, no run_allocated.
  expect(journalTypes(h.campaignDir)).toEqual([
    'campaign_opened',
    'block_admitted',
    'attempt_created',
    'storage_paused',
  ]);
  expect(existsSync(join(h.campaignDir, '.ballast'))).toBe(false);
});

test('the terminal bundle is atomic: run_completed and its spend + snapshot land in ONE critical section (D-13 fate table)', async () => {
  const h = harness();
  const real = electWriter({
    campaignDir: h.campaignDir,
    clock: h.clock,
    identity: IDENTITY,
    campaign: campaignDoc(),
  });
  // A crash between the terminal append and the spend append leaves a
  // terminal attempt recovery skips, after which startup re-snapshots
  // exposure without ever recording that run's spend. They must be one
  // append.
  const bundles: string[][] = [];
  const journal: DispatchJournal = {
    appendEvent: (input) => real.appendEvent(input),
    appendEvents: (inputs) => {
      bundles.push(inputs.map((i) => i.type));
      return real.appendEvents(inputs);
    },
    readEvents: (afterSeq) => real.readEvents(afterSeq),
    readBudgetPosition: () => real.readBudgetPosition(),
    release: () => real.release(),
  };
  const run = runCampaignDispatch({ ...h.args, journal });
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) {
    const runId = `run-${child.pid}`;
    seedCompletedRunDir(h.args.resultsRoot!, runId, { costUsd: 0.25 });
    child.emitLine(`run_allocated: ${runId}`);
    child.exit({ code: 0, signal: null });
  }
  await tick(h.clock, 1);
  await run;
  const terminalBundles = bundles.filter((b) => b.includes('run_completed'));
  expect(terminalBundles.length).toBe(2);
  for (const bundle of terminalBundles) {
    // terminal, the receipt naming the attempt, its spend, the superseding
    // snapshot — one critical section.
    expect(bundle).toEqual([
      'run_completed',
      'adjudication',
      'budget_event',
      'budget_event',
    ]);
  }
});

test('process death inside the terminal bundle leaves a durable PREFIX, not a whole bundle — the journal layer commits per event (R-JRN-4)', async () => {
  const h = harness();
  const real = electWriter({
    campaignDir: h.campaignDir,
    clock: h.clock,
    identity: IDENTITY,
    campaign: campaignDoc(),
  });
  // Crash injection at the journal layer: the first event of the terminal
  // bundle commits, then the process dies. R-JRN-4 pins one transaction per
  // event, so there is no rollback of the committed prefix — which is why
  // recovery, not the transaction, owes the missing suffix.
  const journal: DispatchJournal = {
    appendEvent: (input) => real.appendEvent(input),
    appendEvents: (inputs) => {
      if (inputs.some((i) => i.type === 'run_completed')) {
        real.appendEvents(inputs.slice(0, 1));
        throw new Error('process died mid-bundle');
      }
      return real.appendEvents(inputs);
    },
    readEvents: (afterSeq) => real.readEvents(afterSeq),
    readBudgetPosition: () => real.readBudgetPosition(),
    release: () => real.release(),
  };
  const run = runCampaignDispatch({ ...h.args, journal });
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) {
    const runId = `run-${child.pid}`;
    seedCompletedRunDir(h.args.resultsRoot!, runId, { costUsd: 0.25 });
    child.emitLine(`run_allocated: ${runId}`);
    child.exit({ code: 0, signal: null });
  }
  await tick(h.clock, 1);
  await expect(run).rejects.toThrow(/process died mid-bundle/);
  const types = journalTypes(h.campaignDir);
  // The durable prefix: the terminal landed, its accounting tail did not.
  expect(types).toContain('run_completed');
  expect(types[types.length - 1]).toBe('run_completed');
  expect(
    eventsOf(h.campaignDir, 'budget_event').filter(
      (e) => e.payload.kind === 'spend',
    ),
  ).toEqual([]);
});

test('terminal spend is the ACTUAL cost from the run artifacts, never the registration estimate', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) {
    const runId = `run-${child.pid}`;
    // The frozen estimates are 1 and 2 USD; the artifacts say 0.25.
    seedCompletedRunDir(h.args.resultsRoot!, runId, { costUsd: 0.25 });
    child.emitLine(`run_allocated: ${runId}`);
    child.exit({ code: 0, signal: null });
  }
  await tick(h.clock, 1);
  await run;
  const spends = eventsOf(h.campaignDir, 'budget_event')
    .filter((e) => e.payload.kind === 'spend')
    .map((e) => e.payload.amount_usd);
  expect(spends).toEqual([0.25, 0.25]);
});

test('an unreadable actual cost FAIL-STOPS: terminal + a durable accounting gap, no spend, no further admission (D-13 discipline)', async () => {
  const h = harness();
  const written: string[] = [];
  const run = runCampaignDispatch({
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
  });
  await tick(h.clock, 1);
  const [first] = h.spawner.spawned;
  const runId = `run-${first!.child.pid}`;
  // A composed verdict with no priced economics: the terminal is real, the
  // money is not knowable. Fabricating the registration estimate is what
  // R-JRN-12 forbids; continuing on a snapshot that silently drops the cost
  // understates the budget forever, so the campaign stops instead.
  seedCompletedRunDir(h.args.resultsRoot!, runId, { costUsd: null });
  first!.child.emitLine(`run_allocated: ${runId}`);
  first!.child.exit({ code: 0, signal: null });
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(1)) {
    const rid = `run-${child.pid}`;
    seedCompletedRunDir(h.args.resultsRoot!, rid, { costUsd: 0.25 });
    child.emitLine(`run_allocated: ${rid}`);
    child.exit({ code: 0, signal: null });
  }
  await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('halted');
  expect(outcome.reason).toMatch(/accounting gap/);
  // No fabricated money, and the gap is DURABLE — not just a stream line.
  expect(
    eventsOf(h.campaignDir, 'budget_event')
      .filter((e) => e.payload.kind === 'spend')
      .map((e) => e.payload.amount_usd),
  ).not.toContain(1);
  const gaps = eventsOf(h.campaignDir, 'adjudication').filter(
    (e) => e.payload.disposition === 'unpriced_terminal',
  );
  expect(gaps.length).toBe(1);
  expect(gaps[0]!.payload.rationale).toContain(runId);
  expect(journalTypes(h.campaignDir)).toContain('run_completed');
  // The gap terminal resolves nothing: no replacement is minted off it.
  expect(written.join('')).toMatch(/operator action/);
  // Nothing admitted after the halt.
  expect(eventsOf(h.campaignDir, 'block_admitted').length).toBe(1);
});

// --- R-SNS-4 exploratory caveat terminal (operator amendment 2026-08-27) ---

const EXPLORATORY_SUITE = {
  schema_version: 1,
  name: 'testsuite',
  kind: 'exploratory',
  budget_usd: 50,
  reserve: 1,
  max_exposure_skew: 60,
  comparisons: [
    { baseline: 'arm_a', treatment: 'arm_b', scenarios: ['scn'], n: 1 },
  ],
};

test('R-SNS-4 exploratory caveat terminal: an exposure-absent determinate exploratory sample journals run_completed WITH the caveat — never withheld, never nonterminal', async () => {
  const h = harness({ suite: EXPLORATORY_SUITE });
  const written: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    observeExposure: () => null, // neither runtime probe nor capture: exposure never establishes
    stream: { write: (s: string) => written.push(s) },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.emitLine(`run_allocated: run-${child.pid}`);
  for (const { child } of h.spawner.spawned)
    child.exit({ code: 0, signal: null });
  const outcome = await run;
  expect(outcome.status).toBe('completed');
  const events = journalEvents(h.campaignDir);
  // Absence stays absent: no exposure_started is ever fabricated.
  expect(events.filter((e) => e.type === 'exposure_started').length).toBe(0);
  // The terminal lands from spawned with the caveat recorded on the event.
  const completed = eventsOf(h.campaignDir, 'run_completed');
  expect(completed.length).toBe(2);
  for (const e of completed) {
    expect(e.payload).toMatchObject({
      outcome: 'pass',
      caveat: 'exploratory_exposure_unestablished',
    });
  }
  // Exploratory renders a caveat — never an exclusion, never a refill mint
  // (R-DSP-9).
  expect(events.some((e) => e.type === 'skew_excluded')).toBe(false);
  expect(mintRecords(h.campaignDir).length).toBe(0);
  // Replay folds both samples to a terminal state — nothing dangles.
  const doc = campaignDoc({ suite: EXPLORATORY_SUITE });
  const replayed = replayEvents(
    {
      samples: doc.samples,
      // E7.0: an absent frozen slot reads as primary (never `slot: undefined`).
      blocks: doc.blocks.map((b) =>
        b.slot === undefined
          ? { block_id: b.block_id, sample_ids: b.sample_ids }
          : { block_id: b.block_id, sample_ids: b.sample_ids, slot: b.slot },
      ),
    },
    events,
  );
  expect(replayed.sampleStates.get('c1:scn:arm_a:r1')).toBe('completed');
  expect(replayed.sampleStates.get('c1:scn:arm_b:r1')).toBe('completed');
  expect(written.some((l) => l.includes('withheld'))).toBe(false);
  expect(written.some((l) => l.includes('caveat'))).toBe(true);
});

test('R-SNS-4 gating arm untouched: an exposure-absent gating block carries NO caveat — run_completed withheld, skew_excluded + skew_refill', async () => {
  const h = harness();
  const written: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    // b1's pair (run-1000/run-1001) never establishes; the refill pair does.
    observeExposure: (runDir) =>
      runDir.endsWith('run-1000') || runDir.endsWith('run-1001') ? null : 1_000,
    stream: { write: (s: string) => written.push(s) },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.emitLine(`run_allocated: run-${child.pid}`);
  for (const { child } of h.spawner.spawned)
    child.exit({ code: 0, signal: null });
  await tick(h.clock, 1); // block terminal: skew decision -> refill admits
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
  const events = journalEvents(h.campaignDir);
  expect(
    events.some(
      (e) => e.type === 'skew_excluded' && e.payload.block_id === 'c1:scn:b1',
    ),
  ).toBe(true);
  expect(
    mintRecords(h.campaignDir).some((m) => m.reason === 'skew_refill'),
  ).toBe(true);
  // b1's attempts never complete (withheld; the exclusion is their
  // terminal) and no run_completed anywhere carries the exploratory caveat.
  const b1Attempts = new Set(
    eventsOf(h.campaignDir, 'attempt_created')
      .filter((e) =>
        ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'].includes(e.payload.sample_id),
      )
      .map((e) => e.payload.attempt_id),
  );
  const completed = eventsOf(h.campaignDir, 'run_completed');
  expect(completed.length).toBe(2); // the refill pair only
  for (const e of completed) {
    expect(b1Attempts.has(e.payload.attempt_id)).toBe(false);
    expect(e.payload.caveat).toBeUndefined();
  }
  expect(written.some((l) => l.includes('withheld'))).toBe(true);
});

// --- Fix round 2 ------------------------------------------------------------

test('storage pause with an unkillable live child is FATAL: the run rejects naming the survivor, after the pause record landed (Critical remainder, D-13 step 5)', async () => {
  const h = harness();
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
  const written: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    sampler: scripted,
    stream: { write: (s: string) => written.push(s) },
    signalGroup: () => 'ok', // the groups NEVER die
    killGraceSeconds: 0.05,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.emitLine(`run_allocated: run-${child.pid}`);
  hooks!.onSampleError(
    Object.assign(new Error('write failed'), { code: 'ENOSPC' }),
  );
  // Drive the TERM->wait->KILL->wait escalations for both children.
  for (let i = 0; i < 8; i += 1) await tick(h.clock, 1);
  let thrown: unknown = null;
  try {
    await run;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(DispatcherError);
  expect((thrown as Error).message).toMatch(/storage pause FATAL/);
  expect((thrown as Error).message).toMatch(/pgid 100[01]/);
  // The durable pause record and the ballast release still happened first.
  expect(journalTypes(h.campaignDir)).toContain('storage_paused');
  expect(existsSync(join(h.campaignDir, '.ballast'))).toBe(false);
});

test("the delayed-allocation race: a mint waits for a spawned sibling's run_allocated line, so the allocation lands BEFORE the dispositions (R-JRN-8 remainder)", async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  const [childA, childB] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  // arm_a fails typed while childB's allocation line has NOT arrived at all
  // (neither latched nor delivered): the mint must not disposition childB
  // from 'admitted' and strand the allocation that is about to arrive.
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  expect(mintRecords(h.campaignDir).length).toBe(0); // the mint is waiting
  expect(eventsOf(h.campaignDir, 'instrument_failure').length).toBe(1);
  // The line lands AFTER the sibling's terminal was processed.
  childB!.child.emitLine(`run_allocated: run-${childB!.child.pid}`);
  await tick(h.clock, 1);
  const allocs = eventsOf(h.campaignDir, 'run_allocated');
  const drained = allocs.filter(
    (a) => a.payload.run_id === `run-${childB!.child.pid}`,
  );
  expect(drained.length).toBe(1); // exactly once
  const minted = mintRecords(h.campaignDir)[0];
  expect(minted).toBeDefined();
  expect(drained[0]!.seq).toBeLessThan(minted!.seq);
  // The disposition applied from 'spawned' (a legal source) and replay
  // folds a clean journal.
  const dispositions = eventsOf(h.campaignDir, 'sample_disposition');
  expect(
    dispositions.some((d) => d.payload.sample_id === 'c1:scn:arm_b:r1'),
  ).toBe(true);
  childB!.child.exit({ code: 0, signal: null });
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
  const doc = campaignDoc();
  const replayed = replayEvents(
    {
      samples: doc.samples,
      blocks: doc.blocks.map((b) =>
        b.slot === undefined
          ? { block_id: b.block_id, sample_ids: b.sample_ids }
          : { block_id: b.block_id, sample_ids: b.sample_ids, slot: b.slot },
      ),
    },
    journalEvents(h.campaignDir),
  );
  expect(replayed.sampleStates.get('c1:scn:arm_b:r1')).toBe(
    'excluded_block_replaced',
  );
  // The early arrival cancelled the budget timer: once the run is over and
  // the loop's own 1s fallback sleep has elapsed, no parked 300s waiter
  // survives on the fake timeline.
  h.clock.advance(2);
  expect(h.clock.earliestWaiter()).toBeNull();
});

test('the allocation wait is BOUNDED: a sibling that never allocates within the budget is verified-KILLED before its disposition, so no allocation can follow a terminal (R-JRN-8 invariant)', async () => {
  const h = harness();
  const written: string[] = [];
  const signals: { pgid: number; signal: number | string }[] = [];
  const base = fakeGroupSignaler();
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
    signalGroup: (pgid, signal) => {
      if (signal !== 0) signals.push({ pgid, signal });
      return base(pgid, signal);
    },
    killGraceSeconds: 0.05,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  const [childA, childB] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  expect(mintRecords(h.campaignDir).length).toBe(0); // waiting for childB
  await tick(h.clock, ALLOCATION_WAIT_BUDGET_SECONDS + 1); // budget expires
  for (let i = 0; i < 4; i += 1) await tick(h.clock, 1); // kill escalation
  // The unallocated child was killed (verified) BEFORE its disposition.
  expect(signals.some((s) => s.pgid === childB!.child.pid)).toBe(true);
  expect(written.join('')).toMatch(/allocation wait .*expired/);
  expect(written.join('')).toMatch(/verified dead before its disposition/);
  expect(mintRecords(h.campaignDir).length).toBe(1);
  expect(
    eventsOf(h.campaignDir, 'sample_disposition').some(
      (d) => d.payload.sample_id === 'c1:scn:arm_b:r1',
    ),
  ).toBe(true);
  // The invariant: a dead child cannot allocate. A synthetic post-death
  // line (impossible in production) is suppressed by the abandoned guard —
  // nothing journaled, nothing fatal, nothing "retained in-memory".
  childB!.child.emitLine(`run_allocated: run-${childB!.child.pid}`);
  await tick(h.clock, 1);
  expect(
    eventsOf(h.campaignDir, 'run_allocated').some(
      (a) => a.payload.run_id === `run-${childB!.child.pid}`,
    ),
  ).toBe(false);
  expect(written.join('')).not.toMatch(/arrived after its terminal/);
  // The killed child's slot released -> the minted reserve admits.
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

test('an UNKILLABLE unallocated sibling refuses the mint loudly and halts admission — verified death is the precondition for its disposition (C10)', async () => {
  const h = harness();
  const written: string[] = [];
  const dead = new Set<number>();
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
    signalGroup: (pgid, signal) => {
      if (pgid === 1001) return 'ok'; // arm_b's group never dies
      if (signal === 0) return dead.has(pgid) ? 'esrch' : 'ok';
      dead.add(pgid);
      return 'ok';
    },
    killGraceSeconds: 0.05,
    installSignals: (handler) => {
      signalHandler = handler;
      return () => {};
    },
  };
  let signalHandler: ((signal?: NodeJS.Signals) => void) | null = null;
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  const [childA] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  await tick(h.clock, ALLOCATION_WAIT_BUDGET_SECONDS + 1);
  for (let i = 0; i < 8; i += 1) await tick(h.clock, 1); // TERM->KILL escalation
  // No mint, no disposition: the operation aborted loudly with a named
  // action and admission halted.
  expect(mintRecords(h.campaignDir).length).toBe(0);
  expect(eventsOf(h.campaignDir, 'sample_disposition').length).toBe(0);
  expect(written.join('')).toMatch(/operator action/);
  expect(written.join('')).toMatch(/halt: /);
  signalHandler!('SIGINT');
  for (let i = 0; i < 8; i += 1) await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('signalled');
});

test('the allocation wait does NOT hold the control section: a signal during the wait is handled at once (Important, D-12 latency)', async () => {
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
  const [childA] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  expect(mintRecords(h.campaignDir).length).toBe(0); // the mint is waiting on childB
  // A signal arrives mid-wait: it must run NOW, not after the 300s budget.
  signalHandler!('SIGINT');
  for (let i = 0; i < 4; i += 1) await tick(h.clock, 1);
  expect(journalTypes(h.campaignDir)).toContain('aborted');
  const outcome = await run;
  expect(outcome.status).toBe('signalled');
  // Teardown abandoned the wait: no parked budget timer survives once the
  // loop's own 1s fallback sleep has elapsed.
  h.clock.advance(2);
  expect(h.clock.earliestWaiter()).toBeNull();
});

test("allocation waits across blocks run concurrently: the second block's line resolves its mint while the first is still waiting", async () => {
  const h = twoBlockHarness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  expect(h.spawner.spawned.length).toBe(4); // b1 + b2 both in flight
  const [a1, b1, a2, b2] = h.spawner.spawned;
  // Both arm_a children allocate and fail typed; both arm_b siblings are
  // still unallocated -> two mints wait, concurrently.
  for (const c of [a1, a2]) {
    c!.child.emitLine(`run_allocated: run-${c!.child.pid}`);
    c!.child.exit({ code: 1, signal: null });
  }
  await tick(h.clock, 1);
  expect(mintRecords(h.campaignDir).length).toBe(0);
  // The SECOND block's sibling allocates first: its mint lands while the
  // first block's wait is still open — waits never serialize.
  b2!.child.emitLine(`run_allocated: run-${b2!.child.pid}`);
  await tick(h.clock, 1);
  const afterB2 = mintRecords(h.campaignDir);
  expect(afterB2.length).toBe(1);
  expect(afterB2[0]!.block_id).toBe('c1:scn:b2');
  // Then the first block's sibling allocates: its obligation resolves too
  // (the cell's only reserve is taken -> reserve_exhausted).
  b1!.child.emitLine(`run_allocated: run-${b1!.child.pid}`);
  await tick(h.clock, 1);
  expect(
    eventsOf(h.campaignDir, 'adjudication').filter(
      (e) => e.payload.disposition === 'reserve_exhausted',
    ).length,
  ).toBe(1);
  expect(
    eventsOf(h.campaignDir, 'run_allocated').map((e) => e.payload.run_id),
  ).toContain(`run-${b1!.child.pid}`);
  for (const c of [b1, b2]) c!.child.exit({ code: 0, signal: null });
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(4)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

// --- Fix round 4: the deferred re-entry's lifecycle -------------------------

test('a deferred re-entry queued behind an operator cancel is dropped AT EXECUTION: campaign_cancelled stays LAST (D-12; the control-epoch guard)', async () => {
  const h = twoBlockHarness();
  const written: string[] = [];
  let signalHandler: ((signal?: NodeJS.Signals) => void) | null = null;
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
    installSignals: (handler) => {
      signalHandler = handler;
      return () => {};
    },
    killGraceSeconds: 0.05,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  const [a1, , a2, b2] = h.spawner.spawned;
  // Two deferred mints, one tick apart: b1's wait expires first.
  a1!.child.emitLine(`run_allocated: run-${a1!.child.pid}`);
  a1!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  a2!.child.emitLine(`run_allocated: run-${a2!.child.pid}`);
  a2!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  expect(mintRecords(h.campaignDir).length).toBe(0);
  // b1's budget expires: its re-entry is RUNNING and parked on the kill's
  // grace sleep — the control section is busy.
  await tick(h.clock, ALLOCATION_WAIT_BUDGET_SECONDS - 0.5);
  // The operator cancel (marker first, D-12) queues behind that busy
  // section; then b2's sibling allocates, so b2's re-entry decides to queue
  // while `signalled` is STILL false — it lands behind the cancel.
  writeFileSync(join(h.campaignDir, 'cancel-request'), '1000\nstop\n', {
    flag: 'wx',
  });
  signalHandler!('SIGTERM');
  b2!.child.emitLine(`run_allocated: run-${b2!.child.pid}`);
  for (let i = 0; i < 10; i += 1) await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('cancelled');
  const types = journalTypes(h.campaignDir);
  // b1's mint landed before the cancel; b2's stale re-entry journaled
  // nothing after it — campaign_cancelled is LAST.
  expect(types[types.length - 1]).toBe('campaign_cancelled');
  expect(mintRecords(h.campaignDir).map((m) => m.block_id)).toEqual([
    'c1:scn:b1',
  ]);
  expect(
    eventsOf(h.campaignDir, 'adjudication').filter(
      (e) => e.payload.disposition === 'reserve_exhausted',
    ).length,
  ).toBe(0);
  expect(written.join('')).toMatch(/dropped: stale control epoch/);
});

test('settle-kill releases land in the budget position BEFORE the replacement reads it: a valid replacement is not falsely suppressed (E7.7 order: kills -> snapshot -> budget reads)', async () => {
  const doc = campaignDoc();
  // Budget 5: with the killed sibling's estimate (2) still counted, the
  // reserve's exposure (3) on top of the spend (1) reads 6 > 5 — a false
  // stop. With the release landed first it reads 4 <= 5.
  const h = harness({
    suite: { ...doc.suite, budget_usd: 5 },
    budget: { ...doc.budget, usd_all_in: 5 },
  });
  const args: DispatchRunArgs = { ...h.args, killGraceSeconds: 0.05 };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  const [childA] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  await tick(h.clock, ALLOCATION_WAIT_BUDGET_SECONDS + 1);
  for (let i = 0; i < 4; i += 1) await tick(h.clock, 1);
  const events = journalEvents(h.campaignDir);
  expect(events.some((e) => e.type === 'budget_stopped')).toBe(false);
  expect(
    eventsOf(h.campaignDir, 'adjudication').some(
      (e) => e.payload.disposition === 'replacement_suppressed',
    ),
  ).toBe(false);
  const mint = mintRecords(h.campaignDir)[0];
  expect(mint).toBeDefined();
  // The superseding snapshot (exposure now empty) precedes the mint.
  const emptySnapshot = events.find(
    (e) =>
      e.type === 'budget_event' &&
      e.payload.kind === 'estimate_inflight' &&
      e.payload.amount_usd === 0,
  );
  expect(emptySnapshot).toBeDefined();
  expect(emptySnapshot!.seq).toBeLessThan(mint!.seq);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

test('a partial settle-kill in the contention batch journals the superseding snapshot for the verified deaths BEFORE aborting (E7.7)', async () => {
  const h = twoBlockHarness();
  writeInvalidatingSidecar(h.campaignDir);
  let hooks: DispatchSamplerHooks | null = null;
  const scripted: DispatchSamplerSeam = {
    start(captured) {
      hooks = captured;
      return () => {};
    },
  };
  const written: string[] = [];
  const dead = new Set<number>();
  let signalHandler: ((signal?: NodeJS.Signals) => void) | null = null;
  const args: DispatchRunArgs = {
    ...h.args,
    sampler: scripted,
    stream: { write: (s: string) => written.push(s) },
    killGraceSeconds: 0.05,
    // pid 1003 (b2's arm_b) is immortal; every other group dies on TERM.
    signalGroup: (pgid, signal) => {
      if (pgid === 1003) return 'ok';
      if (signal === 0) return dead.has(pgid) ? 'esrch' : 'ok';
      dead.add(pgid);
      return 'ok';
    },
    installSignals: (handler) => {
      signalHandler = handler;
      return () => {};
    },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  expect(h.spawner.spawned.length).toBe(4);
  // No child has allocated when the window closes: the batch defers on all
  // four, then the budget expires and every child is settle-killed.
  hooks!.onBreachExit(BREACH_WINDOW);
  await tick(h.clock, 1);
  expect(written.join('')).toMatch(/contention resolution deferred/);
  await tick(h.clock, ALLOCATION_WAIT_BUDGET_SECONDS + 1);
  for (let i = 0; i < 12; i += 1) await tick(h.clock, 1);
  expect(written.join('')).toMatch(/contention resolution ABORTED/);
  expect(mintRecords(h.campaignDir).length).toBe(0);
  // Three verified deaths released their exposure; only the survivor
  // (arm_b:r2, estimate 2) remains — and that snapshot landed before the
  // abort returned.
  const snapshots = eventsOf(h.campaignDir, 'budget_event').filter(
    (e) => e.payload.kind === 'estimate_inflight',
  );
  expect(snapshots[snapshots.length - 1]!.payload.amount_usd).toBe(2);
  signalHandler!('SIGINT');
  for (let i = 0; i < 8; i += 1) await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('signalled');
});

test('an older deferred contention resolution never clears a NEWER live breach: admission stays halted until that breach resolves itself (generation ownership)', async () => {
  const h = harness();
  writeInvalidatingSidecar(h.campaignDir);
  let hooks: DispatchSamplerHooks | null = null;
  const scripted: DispatchSamplerSeam = {
    start(captured) {
      hooks = captured;
      return () => {};
    },
  };
  const written: string[] = [];
  const run = runCampaignDispatch({
    ...h.args,
    sampler: scripted,
    stream: { write: (s: string) => written.push(s) },
  });
  await tick(h.clock, 1);
  const [childA, childB] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`); // childB stays unallocated
  hooks!.onBreachEntry(['load1_per_core']); // generation 1
  hooks!.onBreachExit(BREACH_WINDOW); // generation 1 closes: deferred on childB
  await tick(h.clock, 1);
  expect(written.join('')).toMatch(/contention resolution deferred/);
  hooks!.onBreachEntry(['load1_per_core']); // a NEWER breach while the old resolution waits
  await tick(h.clock, 1);
  childB!.child.emitLine(`run_allocated: run-${childB!.child.pid}`); // the old resolution re-enters
  await tick(h.clock, 1);
  expect(
    mintRecords(h.campaignDir).filter((m) => m.reason === 'contention').length,
  ).toBe(1); // its batch still lands...
  // ...but the newer breach survives: admission stays halted, so the minted
  // reserve does NOT admit even once slots free up.
  for (const c of [childA, childB]) c!.child.exit({ code: 0, signal: null });
  for (let i = 0; i < 3; i += 1) await tick(h.clock, 1);
  expect(h.spawner.spawned.length).toBe(2);
  expect(written.join('')).not.toMatch(/admission resumed/);
  // The newer breach closes: its own resolution clears it.
  hooks!.onBreachExit(BREACH_WINDOW);
  await tick(h.clock, 1);
  expect(written.join('')).toMatch(/admission resumed/);
  expect(h.spawner.spawned.length).toBe(4);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

test('settle-killing the last child of a block reaches the pinned block-terminal verification (R-DSP-11 cadence point 2) that the abandoned exit callback would skip', async () => {
  const h = harness();
  const written: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
    killGraceSeconds: 0.05,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  const [childA] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  expect(mintRecords(h.campaignDir).length).toBe(0);
  await tick(h.clock, ALLOCATION_WAIT_BUDGET_SECONDS + 1);
  for (let i = 0; i < 4; i += 1) await tick(h.clock, 1);
  const text = written.join('');
  const killedAt = text.indexOf('verified dead before its disposition');
  expect(killedAt).toBeGreaterThan(-1);
  const receipt =
    'block terminal: c1:scn:b1 — snapshot verified (R-DSP-11 cadence point 2)';
  expect(text.indexOf(receipt)).toBeGreaterThan(killedAt);
  expect(text.split(receipt).length - 1).toBe(1); // exactly once for the block
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

// --- Fix round 5: D-13 fail-stop honored on the settle snapshot paths -------

test('replacement path: a settle snapshot that cannot land after the storage pause STOPS the path — no budget read, no resolution after the fail-stop (D-13)', async () => {
  const h = harness();
  const real = electWriter({
    campaignDir: h.campaignDir,
    clock: h.clock,
    identity: IDENTITY,
    campaign: campaignDoc(),
  });
  const written: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    journal: snapshotEnospcJournal(real),
    stream: { write: (s: string) => written.push(s) },
    killGraceSeconds: 0.05,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  const [childA] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  // The budget expires, the sibling is settle-killed, and the E7.7
  // snapshot hits ENOSPC (and again on the D-13 retry): the pause owns
  // everything after this point.
  await tick(h.clock, ALLOCATION_WAIT_BUDGET_SECONDS + 1);
  for (let i = 0; i < 6; i += 1) await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  const types = journalTypes(h.campaignDir);
  expect(types).toContain('storage_paused');
  expect(types).not.toContain('block_replaced');
  expect(types).not.toContain('sample_disposition');
  // No RESOLUTION adjudication: the only one present is the spend receipt
  // that rides the terminal bundle itself.
  expect(
    eventsOf(h.campaignDir, 'adjudication').map((e) => e.payload.disposition),
  ).toEqual(['spend_recovered']);
  expect(types).not.toContain('budget_stopped');
  const text = written.join('');
  expect(text).toMatch(/storage pause/);
  expect(text).not.toMatch(
    /replacement minted|replacement suppressed|reserve exhausted|replacement for .* REFUSED/,
  );
});

test('contention path: a settle snapshot that cannot land after the storage pause STOPS the batch — no resolution, no counts, no resume after the fail-stop (D-13)', async () => {
  const h = twoBlockHarness();
  writeInvalidatingSidecar(h.campaignDir);
  const real = electWriter({
    campaignDir: h.campaignDir,
    clock: h.clock,
    identity: IDENTITY,
    campaign: h.doc,
  });
  let hooks: DispatchSamplerHooks | null = null;
  const scripted: DispatchSamplerSeam = {
    start(captured) {
      hooks = captured;
      return () => {};
    },
  };
  const written: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    journal: snapshotEnospcJournal(real),
    sampler: scripted,
    stream: { write: (s: string) => written.push(s) },
    killGraceSeconds: 0.05,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  expect(h.spawner.spawned.length).toBe(4);
  hooks!.onBreachExit(BREACH_WINDOW); // deferred on four unallocated children
  await tick(h.clock, 1);
  await tick(h.clock, ALLOCATION_WAIT_BUDGET_SECONDS + 1);
  for (let i = 0; i < 10; i += 1) await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  const types = journalTypes(h.campaignDir);
  expect(types).toContain('storage_paused');
  expect(types).not.toContain('block_replaced');
  expect(types).not.toContain('sample_disposition');
  expect(types).not.toContain('adjudication');
  const text = written.join('');
  expect(text).toMatch(/storage pause/);
  expect(text).not.toMatch(/contention resolution: affected=/);
  expect(text).not.toMatch(/admission resumed/);
});

test('terminal path: a spend snapshot that cannot land after the storage pause STOPS the exit handler — no replacement is resolved after the fail-stop (D-13 sweep)', async () => {
  const h = harness();
  const real = electWriter({
    campaignDir: h.campaignDir,
    clock: h.clock,
    identity: IDENTITY,
    campaign: campaignDoc(),
  });
  // The volume is full for exactly the terminal bundle (evidence + spend +
  // snapshot, one critical section) and its D-13 retry; everything else lands.
  const journal: DispatchJournal = {
    appendEvent: (input) => real.appendEvent(input),
    appendEvents: (inputs) => {
      if (
        inputs.some(
          (i) => i.type === 'run_completed' || i.type === 'instrument_failure',
        )
      ) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return real.appendEvents(inputs);
    },
    readEvents: (afterSeq) => real.readEvents(afterSeq),
    readBudgetPosition: () => real.readBudgetPosition(),
    release: () => real.release(),
  };
  const written: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    journal,
    stream: { write: (s: string) => written.push(s) },
    killGraceSeconds: 0.05,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  const [childA, childB] = h.spawner.spawned;
  for (const c of [childA, childB])
    c!.child.emitLine(`run_allocated: run-${c!.child.pid}`);
  // arm_a fails typed: its terminal spend bundle hits ENOSPC -> pause; the
  // handler must not go on to resolve the replacement.
  childA!.child.exit({ code: 1, signal: null });
  for (let i = 0; i < 6; i += 1) await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  const types = journalTypes(h.campaignDir);
  expect(types).toContain('storage_paused');
  // Atomicity: the evidence rides the same critical section as its spend, so
  // a bundle that cannot land leaves NO terminal behind for recovery to skip.
  expect(types).not.toContain('instrument_failure');
  expect(types).not.toContain('block_replaced');
  expect(types).not.toContain('sample_disposition');
  expect(types).not.toContain('adjudication');
  expect(written.join('')).not.toMatch(
    /replacement minted|replacement suppressed|reserve exhausted|replacement for .* deferred/,
  );
});

// --- Fix round 6: the round-5 gates propagate to their enclosing loops -----

test('spawn loop: after a spawn-failure snapshot enters the storage pause, NO further sample of the block is launched (the pause already abandoned it; D-13 kill sweep)', async () => {
  const h = harness();
  const real = electWriter({
    campaignDir: h.campaignDir,
    clock: h.clock,
    identity: IDENTITY,
    campaign: campaignDoc(),
  });
  // arm_a's spawn fails; its E7.7 release snapshot hits ENOSPC (and the
  // D-13 retry) -> storage pause, whose kill sweep abandons the unspawned
  // arm_b sibling. The spawn loop must then launch nothing.
  h.spawner.failNext = 1;
  const written: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    journal: snapshotEnospcJournal(real),
    stream: { write: (s: string) => written.push(s) },
  };
  const run = runCampaignDispatch(args);
  for (let i = 0; i < 4; i += 1) await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  expect(h.spawner.spawned.length).toBe(0); // arm_b never spawned post-pause
  const types = journalTypes(h.campaignDir);
  expect(types).toContain('storage_paused');
  expect(types).not.toContain('run_allocated');
  expect(types).not.toContain('block_replaced');
  expect(written.join('')).toMatch(/storage pause/);
});

test('terminal path: after the skew_excluded append enters the storage pause, NO snapshot verification or drift repair runs (the pause owns what follows)', async () => {
  const h = harness();
  const real = electWriter({
    campaignDir: h.campaignDir,
    clock: h.clock,
    identity: IDENTITY,
    campaign: campaignDoc(),
  });
  // The volume is full for exactly the skew_excluded row (and its retry).
  const journal: DispatchJournal = {
    appendEvent: (input) => real.appendEvent(input),
    appendEvents: (inputs) => {
      if (inputs.length === 1 && inputs[0]?.type === 'skew_excluded') {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return real.appendEvents(inputs);
    },
    readEvents: (afterSeq) => real.readEvents(afterSeq),
    readBudgetPosition: () => real.readBudgetPosition(),
    release: () => real.release(),
  };
  // The instrument reads as DRIFTED at any verification after the pause
  // (the pause released the ballast — a durable, in-process marker of it).
  let repaired = false;
  let verifiesAfterPause = 0;
  const written: string[] = [];
  const args: DispatchRunArgs = {
    ...h.args,
    journal,
    stream: { write: (s: string) => written.push(s) },
    // b1's pair lands 499s apart -> gating skew breach at block terminal.
    observeExposure: (runDir) =>
      runDir.endsWith('run-1000') ? 1_000 : 500_000,
    snapshotVerify: () => {
      if (!existsSync(join(h.campaignDir, '.ballast'))) {
        verifiesAfterPause += 1;
        throw new SnapshotDriftError('worktree HEAD moved');
      }
    },
    repairSnapshot: () => {
      repaired = true;
      return {
        evalsRoot: join(h.campaignDir, 'evals'),
        gauntletRoot: join(h.campaignDir, 'gauntlet'),
        gauntletBin: join(h.campaignDir, 'bin', 'gauntlet'),
        superpowersWorktrees: [],
        evalsSha: 'e'.repeat(40),
        gauntletSha: '9'.repeat(40),
      };
    },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.emitLine(`run_allocated: run-${child.pid}`);
  for (const { child } of h.spawner.spawned)
    child.exit({ code: 0, signal: null });
  for (let i = 0; i < 4; i += 1) await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  expect(verifiesAfterPause).toBe(0); // no verification after the pause
  expect(repaired).toBe(false); // no repair after the pause
  const types = journalTypes(h.campaignDir);
  expect(types).toContain('storage_paused');
  expect(types).not.toContain('skew_excluded');
  expect(types).not.toContain('block_replaced');
  expect(types).not.toContain('aborted');
  expect(written.join('')).not.toMatch(/drift/);
});

test('a partially verified kill journals the superseding exposure snapshot even when the block is NOT aborted (E7.7 membership change)', async () => {
  const h = harness();
  const written: string[] = [];
  // pid 1000 (arm_a) dies on the first signal; pid 1001 (arm_b) is immortal.
  const dead = new Set<number>();
  const mixedSignaler: GroupSignaler = (pgid, signal) => {
    if (pgid === 1001) return 'ok';
    if (signal === 0) return dead.has(pgid) ? 'esrch' : 'ok';
    dead.add(pgid);
    return 'ok';
  };
  let verifies = 0;
  let signalHandler: ((signal?: NodeJS.Signals) => void) | null = null;
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
    signalGroup: mixedSignaler,
    killGraceSeconds: 0.05,
    installSignals: (handler) => {
      signalHandler = handler;
      return () => {};
    },
    snapshotVerify: () => {
      verifies += 1;
      if (verifies >= 2) throw new SnapshotDriftError('worktree HEAD moved');
    },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned)
    child.emitLine(`run_allocated: run-${child.pid}`);
  const lastAllocSeq = Math.max(
    ...eventsOf(h.campaignDir, 'run_allocated').map((e) => e.seq),
  );
  // Wave 2: drift -> kill the affected block; arm_a verifies dead (released
  // from the exposure set), arm_b survives -> no aborted for the block, the
  // drift response aborts loudly.
  await tick(h.clock, 1);
  for (let i = 0; i < 8; i += 1) await tick(h.clock, 1);
  expect(written.join('')).toMatch(/drift response ABORTED/);
  const events = journalEvents(h.campaignDir);
  expect(events.some((e) => e.type === 'aborted')).toBe(false);
  // E7.7: the membership change (arm_a released) is journaled as a
  // superseding absolute snapshot — the surviving arm_b's estimate only.
  const snapshots = events.filter(
    (e): e is Extract<JournalEvent, { type: 'budget_event' }> =>
      e.type === 'budget_event' &&
      e.payload.kind === 'estimate_inflight' &&
      e.seq > lastAllocSeq,
  );
  expect(snapshots.length).toBeGreaterThanOrEqual(1);
  expect(snapshots[snapshots.length - 1]!.payload.amount_usd).toBe(2);
  // Tear down through the signal path (the survivor stays unkillable).
  signalHandler!('SIGINT');
  for (let i = 0; i < 8; i += 1) await tick(h.clock, 1);
  const outcome = await run;
  expect(outcome.status).toBe('signalled');
});
