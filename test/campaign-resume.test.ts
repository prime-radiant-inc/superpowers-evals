// Behavioral coverage of the WHOLE R-RCV-7 resume path: kill/reconcile ->
// D-13 terminal evidence + storage-pause reconciliation -> preflight (floors,
// fingerprint, key envs) -> R-RCV-6 reconstruction + refs cross-check ->
// admission through the real dispatcher. The instrument snapshot is real git
// (reconstruction runs the real git commands), the host probe is scripted,
// and the children are the dispatcher suite's scripted-child seam — hermetic
// throughout, no network and no real campaign process.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GroupSignaler } from '../src/campaign/dispatcher.ts';
import type { HostStats, HostStatsProbe } from '../src/campaign/host-stats.ts';
import {
  electWriter,
  openJournalRead,
  replayEvents,
} from '../src/campaign/journal.ts';
import { resumeCampaign, universeOf } from '../src/campaign/recovery.ts';
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
import { deleteProcessEnv, getEnv, setProcessEnv } from '../src/env.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import {
  ALIVE_AT_5,
  BLOCK_A,
  campaignDoc,
  childCommandLine,
  fixtureCredentials,
  lockDir,
  publishedCampaign,
  SAMPLE_A,
  SAMPLE_B,
  seedRealSnapshot,
  WRITER_IDENTITY,
} from './campaign-recovery-fixtures.ts';

// The 6a env composition resolves selected key VALUES through src/env.ts and
// fails loud when unset (R-SPN-7); the resume preflight demands the same
// names (R-REG-19). Seed them, restoring any prior values afterwards.
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

// --- scripted children -----------------------------------------------------
// Pids far above any real PID: a fake child must never reach a real process
// group even if a kill path is taken.
const FAKE_PID_BASE = 900_000_001;

class FakeChild implements SpawnedCampaignChild {
  readonly pid: number;
  private readonly stdout: string[] = [];
  private readonly stderr: string[] = [];
  private readonly stdoutCbs: ((l: string) => void)[] = [];
  private readonly stderrCbs: ((l: string) => void)[] = [];
  private readonly exitCbs: ((i: ChildExitInfo) => void)[] = [];
  constructor(pid: number) {
    this.pid = pid;
  }
  get stdoutLines(): readonly string[] {
    return this.stdout;
  }
  get stderrLines(): readonly string[] {
    return this.stderr;
  }
  emitLine(line: string): void {
    this.stdout.push(line);
    for (const cb of this.stdoutCbs) cb(line);
  }
  exit(info: ChildExitInfo): void {
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
  private nextPid = FAKE_PID_BASE;
  spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
    const child = new FakeChild(this.nextPid++);
    this.spawned.push({ spec, child });
    return child;
  }
}

/** A real completed run dir: the verdict the composer would have written and
 *  the trajectory the exposure sensor reads (same timestamp on every sample
 *  -> zero skew). */
function seedRunDir(
  resultsRoot: string,
  runId: string,
  final: string,
  // DISTINCT per run: identical costs make "one duplicated, one omitted"
  // indistinguishable from correct attribution.
  costUsd = 0.25,
): void {
  const dir = join(resultsRoot, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({
      final,
      final_reason: 'fixture',
      economics: { total_est_cost_usd: costUsd },
    }),
  );
  writeFileSync(
    join(dir, 'trajectory.json'),
    JSON.stringify({ steps: [{ timestamp: '2026-08-29T00:00:00.000Z' }] }),
  );
}

/** A group that dies on the first real signal — the orphan kill resume must
 *  perform before it re-admits anything. */
function mortalGroup(): GroupSignaler {
  const dead = new Set<number>();
  return (pgid, sig) => {
    if (dead.has(pgid)) return 'esrch';
    if (sig === 0) return 'ok';
    dead.add(pgid);
    return 'ok';
  };
}

const STATS: HostStats = {
  ts_ms: 0,
  load1: 0.1,
  mem_available_bytes: 8 * 2 ** 30,
  mem_total_bytes: 16 * 2 ** 30,
  swap_used_bytes: 0,
  swap_total_bytes: 0,
  process_count: 100,
  pid_max: 100_000,
  disk_free_bytes: 50 * 2 ** 30,
  disk_total_bytes: 100 * 2 ** 30,
};

/** A scripted probe that clears the floors and matches the fingerprint the
 *  fixture registers (the CPU half comes from the REAL host, since
 *  probeFingerprint reads os.cpus() directly — Decision D-4). */
const PROBE: HostStatsProbe = {
  sample: (nowMs) => ({ ...STATS, ts_ms: nowMs }),
};

function liveFingerprint(): Campaign['contention']['host_fingerprint'] {
  const cpu = cpus();
  return {
    cpu_model: cpu[0]?.model ?? 'unknown',
    cpu_cores: cpu.length,
    mem_bytes: STATS.mem_total_bytes,
    disk_total_bytes: STATS.disk_total_bytes,
  };
}

interface CrashedFixture {
  dir: string;
  doc: Campaign;
  resultsRoot: string;
}

/** A campaign the dispatcher crashed mid-block: both samples allocated, no
 *  terminals. `refs` names the REAL snapshot seeded into the campaign dir,
 *  unless `driftEvals` moves the registered evals sha off its HEAD. */
function crashedCampaign(
  options: { driftEvals?: boolean } = {},
): CrashedFixture {
  // Identity IS the digest, so the document must be FINAL before it is
  // published: the snapshot is seeded first (it supplies the real refs), the
  // document is built from those refs, and only then is the campaign dir
  // published and journaled against it.
  const dir = mkdtempSync(join(tmpdir(), 'resume-'));
  const refs = seedRealSnapshot(dir);
  const doc = campaignDoc({
    refs:
      options.driftEvals === true ? { ...refs, evals: 'f'.repeat(40) } : refs,
    contention: {
      ...campaignDoc().contention,
      host_fingerprint: liveFingerprint(),
      global_run_cap: 4,
    },
  });
  const seed = publishedCampaign({ inFlight: false, doc, dir });
  const w = electWriter({
    campaignDir: seed.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: doc,
  });
  w.appendEvents([
    { type: 'block_admitted', payload: { block_id: BLOCK_A, pools: ['p'] } },
    {
      type: 'attempt_created',
      payload: { sample_id: SAMPLE_A, attempt_id: 'a1' },
    },
    {
      type: 'run_allocated',
      payload: {
        attempt_id: 'a1',
        run_id: 'r1',
        pgid: 900_000_101,
        key_grants: [],
      },
    },
    {
      type: 'attempt_created',
      payload: { sample_id: SAMPLE_B, attempt_id: 'a2' },
    },
    {
      type: 'run_allocated',
      payload: {
        attempt_id: 'a2',
        run_id: 'r2',
        pgid: 900_000_102,
        key_grants: [],
      },
    },
  ]);
  w.release();
  return { dir: seed.dir, doc, resultsRoot: join(seed.dir, 'results') };
}

/** The identity a fixture child of THIS campaign carries (its campaign id is
 *  the document's own digest, not a shared constant). */
function fixtureChild(fx: CrashedFixture): {
  commandLine: (p: number) => string;
} {
  return {
    commandLine: (pgid: number) =>
      childCommandLine(pgid === 900_000_101 ? 'a1' : 'a2', fx.doc.campaign_id),
  };
}

function journalEvents(dir: string): JournalEvent[] {
  const r = openJournalRead(dir);
  try {
    return r.readEvents();
  } finally {
    r.close();
  }
}

async function tick(clock: FakeClock, seconds: number): Promise<void> {
  clock.advance(seconds);
  for (let i = 0; i < 128; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------

test('resume authenticates the frozen document: a tampered budget refuses before any kill or admission', async () => {
  const fx = crashedCampaign();
  const doc = JSON.parse(
    readFileSync(join(fx.dir, 'campaign.json'), 'utf8'),
  ) as Campaign;
  writeFileSync(
    join(fx.dir, 'campaign.json'),
    JSON.stringify({
      ...doc,
      budget: { ...doc.budget, usd_all_in: 500_000 },
    }),
  );
  const spawner = new FakeSpawner();
  await expect(
    resumeCampaign({
      campaignDir: fx.dir,
      credentials: fixtureCredentials(),
      evalsCheckout: fx.dir,
      gauntletCheckout: fx.dir,
      superpowersCheckout: fx.dir,
      resultsRoot: fx.resultsRoot,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: fixtureChild(fx),
      signal: mortalGroup(),
      graceSeconds: 0,
      probe: PROBE,
      spawner,
      lockPath: lockDir('resume-authenticity.lock.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(/not the digest of its content/);
  expect(spawner.spawned).toHaveLength(0);
});

test('resume drives the whole pinned order: kill/reconcile -> rerun re-entry -> preflight -> reconstruction -> admission -> completion', async () => {
  const fx = crashedCampaign();
  const spawner = new FakeSpawner();
  const clock = new FakeClock(1);
  const banner: string[] = [];
  const run = resumeCampaign({
    campaignDir: fx.dir,
    credentials: fixtureCredentials(),
    evalsCheckout: fx.dir,
    gauntletCheckout: fx.dir,
    superpowersCheckout: fx.dir,
    resultsRoot: fx.resultsRoot,
    clock,
    identity: ALIVE_AT_5,
    child: fixtureChild(fx),
    signal: mortalGroup(),
    graceSeconds: 0,
    probe: PROBE,
    spawner,
    lockPath: lockDir('resume-full.lock.d'),
    stream: { write: (s) => banner.push(s) },
  });
  // Admission: the dispatcher re-admits the rerun instance and spawns both
  // samples of the block.
  await tick(clock, 1);
  expect(spawner.spawned.length).toBe(2);
  for (const { child } of spawner.spawned) {
    const runId = `run-${child.pid}`;
    seedRunDir(fx.resultsRoot, runId, 'pass');
    child.emitLine(`run_allocated: ${runId}`);
  }
  await tick(clock, 1);
  for (const { child } of spawner.spawned)
    child.exit({ code: 0, signal: null });
  const outcome = await run;
  expect(outcome.status).toBe('completed');

  const events = journalEvents(fx.dir);
  const types = events.map((e) => e.type);
  // Reconciliation: the orphans were killed, the block aborted, and the
  // instance re-entered WHOLE via the E7 rerun path (R-RCV-2).
  expect(types).toContain('aborted');
  const mints = events
    .filter((e) => e.type === 'block_replaced')
    .map((e) => normalizeBlockReplaced(e.payload));
  expect(mints.length).toBe(1);
  expect(mints[0]?.block_id).toBe(BLOCK_A);
  expect(mints[0]?.kind).toBe('rerun');
  expect(mints[0]?.reason).toBe('dispatcher_restart');
  expect(mints[0]?.replacement_block_id).toBe(`${BLOCK_A}:i1`);
  expect(types.indexOf('aborted')).toBeLessThan(
    types.indexOf('block_replaced'),
  );
  // D-13: the ballast was spent (the pause reserve is absent), noted once.
  expect(
    events.some(
      (e) =>
        e.type === 'adjudication' && e.payload.disposition === 'ballast_spent',
    ),
  ).toBe(true);
  // Admission of the SUCCESSOR, stamped with the E7.1 re-entry edge.
  const admissions = events.filter((e) => e.type === 'block_admitted');
  const successor = admissions.find(
    (e) => e.payload.block_id === `${BLOCK_A}:i1`,
  );
  expect(successor?.payload.rerun_of).toBe(BLOCK_A);
  // Both fresh attempts ran to a journaled terminal.
  expect(events.filter((e) => e.type === 'run_completed').length).toBe(2);
  // The banner names the reconcile summary the operator reads.
  expect(banner.join('')).toMatch(/live-spend lock acquired/);
  expect(banner.join('')).toMatch(/reconcile complete/);
}, 60_000);

test('reconstructed terminal evidence is the FULL fate-table bundle and the journal stays replay-valid (D-13)', async () => {
  // driftEvals stops the resume at the refs cross-check, AFTER reconciliation
  // has committed — so this test sees exactly what reconciliation wrote.
  const fx = crashedCampaign({ driftEvals: true });
  // Both crashed attempts left complete run dirs: verdict + trajectory
  // (exposure) + priced economics. The reconstruction owes exposure_started
  // before the terminal (a bare run_completed from `spawned` is illegal),
  // the ACTUAL spend from the artifacts, and a superseding snapshot.
  seedRunDir(fx.resultsRoot, 'r1', 'pass', 0.25);
  seedRunDir(fx.resultsRoot, 'r2', 'fail', 0.75);
  await expect(
    resumeCampaign({
      campaignDir: fx.dir,
      credentials: fixtureCredentials(),
      evalsCheckout: fx.dir,
      gauntletCheckout: fx.dir,
      superpowersCheckout: fx.dir,
      resultsRoot: fx.resultsRoot,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: fixtureChild(fx),
      signal: mortalGroup(),
      graceSeconds: 0,
      probe: PROBE,
      spawner: new FakeSpawner(),
      lockPath: lockDir('resume-fate-table.lock.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow();

  const events = journalEvents(fx.dir);
  const types = events.map((e) => e.type);
  // Replay-legality is the whole point: the reducer must accept every edge
  // the reconstruction wrote.
  expect(() => replayEvents(universeOf(fx.doc), events)).not.toThrow();
  // Exposure precedes each terminal (spawned -> exposed -> completed).
  expect(types.indexOf('exposure_started')).toBeGreaterThan(-1);
  expect(types.indexOf('exposure_started')).toBeLessThan(
    types.indexOf('run_completed'),
  );
  expect(
    events
      .filter((e) => e.type === 'run_completed')
      .map((e) => e.payload.attempt_id)
      .sort(),
  ).toEqual(['a1', 'a2']);
  // Actual spend from the run artifacts, DISTINCT per run so attribution is
  // visible — never the registration estimate (1 and 2).
  const spends = events
    .filter((e) => e.type === 'budget_event' && e.payload.kind === 'spend')
    .map((e) => (e.type === 'budget_event' ? e.payload.amount_usd : 0));
  expect(spends.slice().sort()).toEqual([0.25, 0.75]);
  // The superseding absolute snapshot rides the same critical section, last.
  const snapshots = events.filter(
    (e) => e.type === 'budget_event' && e.payload.kind === 'estimate_inflight',
  );
  expect(snapshots.length).toBeGreaterThan(0);
  expect(types.lastIndexOf('budget_event')).toBe(
    events.indexOf(snapshots[snapshots.length - 1]!),
  );
});

test('a terminal bundle truncated by a crash is COMPLETED at resume: the lost spend lands, exactly once, and replay stays valid', async () => {
  // R-JRN-4 pins one transaction per event, so a crash inside a terminal
  // bundle leaves a durable prefix — run_completed committed, its spend and
  // superseding snapshot lost. Recovery owes the missing suffix (the spec's
  // crash model for a batched critical section); skipping the attempt
  // because it "already has a terminal" would lose the spend permanently.
  const fx = crashedCampaign({ driftEvals: true });
  seedRunDir(fx.resultsRoot, 'r1', 'pass', 0.25);
  seedRunDir(fx.resultsRoot, 'r2', 'pass', 0.75);
  // The crash cut: a1's exposure + terminal landed, its accounting tail did
  // not. a2 never terminaled at all.
  const w = electWriter({
    campaignDir: fx.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: fx.doc,
  });
  w.appendEvents([
    { type: 'exposure_started', payload: { sample_id: SAMPLE_A, ts: 1_000 } },
    { type: 'run_completed', payload: { attempt_id: 'a1', outcome: 'pass' } },
  ]);
  w.release();

  await expect(
    resumeCampaign({
      campaignDir: fx.dir,
      credentials: fixtureCredentials(),
      evalsCheckout: fx.dir,
      gauntletCheckout: fx.dir,
      superpowersCheckout: fx.dir,
      resultsRoot: fx.resultsRoot,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: fixtureChild(fx),
      signal: mortalGroup(),
      graceSeconds: 0,
      probe: PROBE,
      spawner: new FakeSpawner(),
      lockPath: lockDir('resume-truncated.lock.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(/Campaign.refs cross-check/);

  const events = journalEvents(fx.dir);
  expect(() => replayEvents(universeOf(fx.doc), events)).not.toThrow();
  const spends = events
    .filter((e) => e.type === 'budget_event' && e.payload.kind === 'spend')
    .map((e) => (e.type === 'budget_event' ? e.payload.amount_usd : 0));
  // a1's lost spend completed (0.25) + a2's reconstructed one (0.75).
  // Exactly one each — distinct costs make a duplicate or an omission
  // impossible to mistake for correct attribution.
  expect(spends.slice().sort()).toEqual([0.25, 0.75]);
  expect(
    events
      .filter((e) => e.type === 'run_completed')
      .map((e) => e.payload.attempt_id),
  ).toEqual(['a1', 'a2']);
});

/** Resume the crashed fixture, stopping at the refs cross-check so the test
 *  sees exactly what reconciliation wrote. */
async function reconcileOnly(fx: CrashedFixture, lock: string): Promise<void> {
  await expect(
    resumeCampaign({
      campaignDir: fx.dir,
      credentials: fixtureCredentials(),
      evalsCheckout: fx.dir,
      gauntletCheckout: fx.dir,
      superpowersCheckout: fx.dir,
      resultsRoot: fx.resultsRoot,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: fixtureChild(fx),
      signal: mortalGroup(),
      graceSeconds: 0,
      probe: PROBE,
      spawner: new FakeSpawner(),
      lockPath: lockDir(lock),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(/Campaign.refs cross-check/);
}

function spendsOf(dir: string): number[] {
  return journalEvents(dir)
    .filter((e) => e.type === 'budget_event' && e.payload.kind === 'spend')
    .map((e) => (e.type === 'budget_event' ? e.payload.amount_usd : 0));
}

test('suffix repair is attempt-correlated, not positional: a repaired terminal is never repaired twice even when a later reconstruction lands between it and its spend', async () => {
  // The attack: b's live terminal is the crash prefix and a was allocated
  // FIRST, so recovery's own reconstruction for a lands between terminal(b)
  // and the spend it appends for b. A positional recognizer re-reads
  // terminal(b) as truncated on the next resume and pays b twice — and
  // spends are additive, so the budget position overstates forever.
  const fx = crashedCampaign({ driftEvals: true });
  seedRunDir(fx.resultsRoot, 'r1', 'pass', 0.25); // attempt a1 (allocated first)
  seedRunDir(fx.resultsRoot, 'r2', 'pass', 0.75); // attempt a2
  const w = electWriter({
    campaignDir: fx.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: fx.doc,
  });
  // a2 terminaled live; its accounting tail never landed. a1 never terminaled.
  w.appendEvents([
    { type: 'exposure_started', payload: { sample_id: SAMPLE_B, ts: 1_000 } },
    { type: 'run_completed', payload: { attempt_id: 'a2', outcome: 'pass' } },
  ]);
  w.release();

  await reconcileOnly(fx, 'attack-1.lock.d');
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  const afterFirst = journalEvents(fx.dir).length;

  // The SECOND resume over the repaired journal is a strict no-op.
  await reconcileOnly(fx, 'attack-2.lock.d');
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  expect(journalEvents(fx.dir).length).toBe(afterFirst);
  expect(() =>
    replayEvents(universeOf(fx.doc), journalEvents(fx.dir)),
  ).not.toThrow();
});

test("a crash DURING recovery's own suffix append is completed exactly once by the next resume", async () => {
  const fx = crashedCampaign({ driftEvals: true });
  seedRunDir(fx.resultsRoot, 'r1', 'pass', 0.25);
  seedRunDir(fx.resultsRoot, 'r2', 'pass', 0.75);
  const w = electWriter({
    campaignDir: fx.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: fx.doc,
  });
  // a1 terminaled live, tail lost; then recovery began repairing it and died
  // after its receipt but BEFORE the spend it records.
  w.appendEvents([
    { type: 'exposure_started', payload: { sample_id: SAMPLE_A, ts: 1_000 } },
    { type: 'run_completed', payload: { attempt_id: 'a1', outcome: 'pass' } },
    {
      type: 'adjudication',
      payload: {
        cell: 'c1:scn',
        disposition: 'spend_recovered',
        rationale: 'attempt=a1; interrupted repair',
      },
    },
  ]);
  w.release();
  await reconcileOnly(fx, 'interrupted-1.lock.d');
  // The interrupted receipt records nothing; the repair runs again and lands
  // ONE spend for a1 (plus a2's reconstruction). Never two.
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  const afterFirst = journalEvents(fx.dir).length;
  await reconcileOnly(fx, 'interrupted-2.lock.d');
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  expect(journalEvents(fx.dir).length).toBe(afterFirst);
});

test('priced evidence with no legal terminal is ACCOUNTED before the instance reruns — the live withheld-terminal spend is never lost', async () => {
  // The live gating path withholds a terminal when exposure is absent but
  // still appends the actual spend. If the process dies before that spend
  // lands, recovery sees complete priced evidence with no legal terminal:
  // blind-rerunning pays twice and drops the money already spent.
  const fx = crashedCampaign({ driftEvals: true });
  for (const [runId, cost] of [
    ['r1', 0.25],
    ['r2', 0.75],
  ] as const) {
    const dir = join(fx.resultsRoot, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'verdict.json'),
      JSON.stringify({
        final: 'pass',
        final_reason: 'fixture',
        economics: { total_est_cost_usd: cost },
      }),
    );
    // No trajectory.json: exposure was never established, and the suite is
    // gating — so there is no legal terminal edge.
  }
  await reconcileOnly(fx, 'unterminated-1.lock.d');
  const events = journalEvents(fx.dir);
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  // No fabricated terminal, and the instance still re-enters.
  expect(events.map((e) => e.type)).not.toContain('run_completed');
  expect(events.map((e) => e.type)).toContain('block_replaced');
  expect(() => replayEvents(universeOf(fx.doc), events)).not.toThrow();
  // Idempotent: the second resume accounts nothing further.
  const afterFirst = journalEvents(fx.dir).length;
  await reconcileOnly(fx, 'unterminated-2.lock.d');
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  expect(journalEvents(fx.dir).length).toBe(afterFirst);
});

test('a terminal-less live spend already in the journal is never charged twice', async () => {
  // The exposure-absent gating path withholds run_completed but journals the
  // actual spend. After a later crash recovery finds neither terminal nor
  // receipt for that attempt — and, without a receipt on the live spend,
  // accounts it a second time.
  const fx = crashedCampaign({ driftEvals: true });
  seedRunDir(fx.resultsRoot, 'r1', 'pass', 0.25);
  seedRunDir(fx.resultsRoot, 'r2', 'pass', 0.75);
  const w = electWriter({
    campaignDir: fx.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: fx.doc,
  });
  // a1's live terminal-less spend, in the shape the live path writes it.
  w.appendEvents([
    {
      type: 'adjudication',
      payload: {
        cell: 'c1:scn',
        disposition: 'spend_recovered',
        rationale: 'attempt=a1; terminal withheld (exposure unestablished)',
      },
    },
    { type: 'budget_event', payload: { kind: 'spend', amount_usd: 0.25 } },
  ]);
  w.release();
  await reconcileOnly(fx, 'terminalless-1.lock.d');
  // a1 was already paid; only a2 is accounted now.
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  const afterFirst = journalEvents(fx.dir).length;
  await reconcileOnly(fx, 'terminalless-2.lock.d');
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  expect(journalEvents(fx.dir).length).toBe(afterFirst);
});

test('a repair whose ONLY missing piece is the superseding snapshot still lands it (E7.7)', async () => {
  // Receipt + spend are durable; the crash took the snapshot. Nothing else
  // is left to do, so an "only act when the bundle is non-empty" rule leaves
  // the stale estimate_inflight in place forever.
  const fx = crashedCampaign({ driftEvals: true });
  seedRunDir(fx.resultsRoot, 'r1', 'pass', 0.25);
  seedRunDir(fx.resultsRoot, 'r2', 'pass', 0.75);
  const w = electWriter({
    campaignDir: fx.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: fx.doc,
  });
  const paid = (attemptId: string, amount: number) => [
    {
      type: 'adjudication' as const,
      payload: {
        cell: 'c1:scn',
        disposition: 'spend_recovered',
        rationale: `attempt=${attemptId}; already repaired`,
      },
    },
    {
      type: 'budget_event' as const,
      payload: { kind: 'spend', amount_usd: amount },
    },
  ];
  w.appendEvents([
    { type: 'exposure_started', payload: { sample_id: SAMPLE_A, ts: 1_000 } },
    { type: 'run_completed', payload: { attempt_id: 'a1', outcome: 'pass' } },
    ...paid('a1', 0.25),
    { type: 'exposure_started', payload: { sample_id: SAMPLE_B, ts: 1_000 } },
    { type: 'run_completed', payload: { attempt_id: 'a2', outcome: 'pass' } },
    ...paid('a2', 0.75),
    // The stale snapshot: both samples are terminal, so the remaining
    // exposure is 0, but the last snapshot still claims 3.
    {
      type: 'budget_event',
      payload: { kind: 'estimate_inflight', amount_usd: 3 },
    },
    // Already noted, so reconciliation has NOTHING else to append — the
    // snapshot is the only remaining gap.
    {
      type: 'adjudication',
      payload: {
        cell: 'control-plane',
        disposition: 'ballast_spent',
        rationale: 'noted by an earlier resume',
      },
    },
  ]);
  w.release();
  await reconcileOnly(fx, 'snapshot-only-1.lock.d');
  const snapshots = journalEvents(fx.dir).filter(
    (e) => e.type === 'budget_event' && e.payload.kind === 'estimate_inflight',
  );
  const last = snapshots[snapshots.length - 1];
  expect(last?.type === 'budget_event' ? last.payload.amount_usd : -1).toBe(0);
  // No money moved, and the repair is idempotent.
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  const afterFirst = journalEvents(fx.dir).length;
  await reconcileOnly(fx, 'snapshot-only-2.lock.d');
  expect(journalEvents(fx.dir).length).toBe(afterFirst);
});

test('a spend_recovered receipt naming an attempt the campaign does not know is loud corruption', async () => {
  const fx = crashedCampaign({ driftEvals: true });
  seedRunDir(fx.resultsRoot, 'r1', 'pass', 0.25);
  seedRunDir(fx.resultsRoot, 'r2', 'pass', 0.75);
  const w = electWriter({
    campaignDir: fx.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: fx.doc,
  });
  w.appendEvents([
    {
      type: 'adjudication',
      payload: {
        cell: 'c1:scn',
        disposition: 'spend_recovered',
        rationale: 'attempt=a-not-in-this-campaign; forged',
      },
    },
    { type: 'budget_event', payload: { kind: 'spend', amount_usd: 9 } },
  ]);
  w.release();
  await expect(
    resumeCampaign({
      campaignDir: fx.dir,
      credentials: fixtureCredentials(),
      evalsCheckout: fx.dir,
      gauntletCheckout: fx.dir,
      superpowersCheckout: fx.dir,
      resultsRoot: fx.resultsRoot,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: fixtureChild(fx),
      signal: mortalGroup(),
      graceSeconds: 0,
      probe: PROBE,
      spawner: new FakeSpawner(),
      lockPath: lockDir('forged-receipt.lock.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(/a-not-in-this-campaign/);
});

test('a FREE-STANDING unpriced gap blocks the resume, and resolves when the economics are restored', async () => {
  // A gating child with no exposure AND no composed verdict gets an
  // unpriced_terminal with NO terminal at all. A gap scan that only walks
  // terminal events misses it and lets an ordinary paid rerun through.
  const fx = crashedCampaign({ driftEvals: true });
  const w = electWriter({
    campaignDir: fx.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: fx.doc,
  });
  w.appendEvents([
    {
      type: 'adjudication',
      payload: {
        cell: 'c1:scn',
        disposition: 'unpriced_terminal',
        rationale: 'attempt=a1; run r1 has no readable actual cost',
      },
    },
    {
      type: 'budget_event',
      payload: { kind: 'estimate_inflight', amount_usd: 2 },
    },
  ]);
  w.release();
  const before = journalEvents(fx.dir).length;
  await expect(
    resumeCampaign({
      campaignDir: fx.dir,
      credentials: fixtureCredentials(),
      evalsCheckout: fx.dir,
      gauntletCheckout: fx.dir,
      superpowersCheckout: fx.dir,
      resultsRoot: fx.resultsRoot,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: fixtureChild(fx),
      signal: mortalGroup(),
      graceSeconds: 0,
      probe: PROBE,
      spawner: new FakeSpawner(),
      lockPath: lockDir('freestanding-1.lock.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(/a1/);
  expect(journalEvents(fx.dir).length).toBe(before); // no rerun admitted

  // The operator restores the economics; the same gap now resolves.
  seedRunDir(fx.resultsRoot, 'r1', 'pass', 0.25);
  seedRunDir(fx.resultsRoot, 'r2', 'pass', 0.75);
  await reconcileOnly(fx, 'freestanding-2.lock.d');
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
});

test("a resolved accounting gap lets the resume proceed: restoring the run dir's economics is the advertised action and it WORKS", async () => {
  // The live fail-stop tells the operator to restore the verdict economics
  // and re-run. Refusing on any historical unpriced_terminal before
  // re-reading the artifacts makes that instruction impossible to follow.
  const fx = crashedCampaign({ driftEvals: true });
  const w = electWriter({
    campaignDir: fx.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: fx.doc,
  });
  w.appendEvents([
    { type: 'exposure_started', payload: { sample_id: SAMPLE_A, ts: 1_000 } },
    { type: 'run_completed', payload: { attempt_id: 'a1', outcome: 'pass' } },
    {
      type: 'adjudication',
      payload: {
        cell: 'c1:scn',
        disposition: 'unpriced_terminal',
        rationale:
          'attempt=a1; run r1 terminaled with no readable actual cost in its run artifacts',
      },
    },
    {
      type: 'budget_event',
      payload: { kind: 'estimate_inflight', amount_usd: 2 },
    },
  ]);
  w.release();
  // The operator did what the message said: r1 now carries economics.
  seedRunDir(fx.resultsRoot, 'r1', 'pass', 0.25);
  seedRunDir(fx.resultsRoot, 'r2', 'pass', 0.75);

  await reconcileOnly(fx, 'gap-resolved-1.lock.d');
  // a1's gap is resolved with its ACTUAL cost; a2 is reconstructed.
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  expect(() =>
    replayEvents(universeOf(fx.doc), journalEvents(fx.dir)),
  ).not.toThrow();
  // …and resolving is idempotent.
  const afterFirst = journalEvents(fx.dir).length;
  await reconcileOnly(fx, 'gap-resolved-2.lock.d');
  expect(spendsOf(fx.dir).slice().sort()).toEqual([0.25, 0.75]);
  expect(journalEvents(fx.dir).length).toBe(afterFirst);
});

test('a run dir whose actual cost is unreadable REFUSES the resume — a composed verdict is not rerun fodder (D-13 fail-closed)', async () => {
  const fx = crashedCampaign({ driftEvals: true });
  // A composed verdict with no priced economics. The terminal is knowable;
  // the money is not — and a spend row must be an actual (R-JRN-12), so the
  // instance re-enters rather than being journaled against a fabricated one.
  for (const runId of ['r1', 'r2']) {
    const dir = join(fx.resultsRoot, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'verdict.json'),
      JSON.stringify({
        final: 'pass',
        final_reason: 'fixture',
        economics: null,
      }),
    );
  }
  const before = journalEvents(fx.dir).length;
  await expect(
    resumeCampaign({
      campaignDir: fx.dir,
      credentials: fixtureCredentials(),
      evalsCheckout: fx.dir,
      gauntletCheckout: fx.dir,
      superpowersCheckout: fx.dir,
      resultsRoot: fx.resultsRoot,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: fixtureChild(fx),
      signal: mortalGroup(),
      graceSeconds: 0,
      probe: PROBE,
      spawner: new FakeSpawner(),
      lockPath: lockDir('resume-unpriced.lock.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(/no readable actual cost/);
  // A composed verdict means the run RAN and spent. Rerunning it would pay
  // twice for evidence we already hold, so nothing is journaled at all —
  // the operator resolves the accounting gap first.
  const events = journalEvents(fx.dir);
  expect(events.length).toBe(before);
  const types = events.map((e) => e.type);
  expect(types).not.toContain('run_completed');
  expect(types).not.toContain('block_replaced');
});

test('resume REFUSES while an accounting gap is STILL unpriced — re-reading the artifacts is what decides it', async () => {
  const fx = crashedCampaign({ driftEvals: true });
  const w = electWriter({
    campaignDir: fx.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: fx.doc,
  });
  // The live fail-stop's shape: terminal, then the gap adjudication that
  // names it, then the superseding snapshot.
  w.appendEvents([
    { type: 'exposure_started', payload: { sample_id: SAMPLE_A, ts: 1_000 } },
    { type: 'run_completed', payload: { attempt_id: 'a1', outcome: 'pass' } },
    {
      type: 'adjudication',
      payload: {
        cell: 'c1:scn',
        disposition: 'unpriced_terminal',
        rationale: 'attempt=a1; run r1 terminaled with no readable actual cost',
      },
    },
    {
      type: 'budget_event',
      payload: { kind: 'estimate_inflight', amount_usd: 2 },
    },
  ]);
  w.release();
  // r1 still carries nothing to price it with, so the refusal stands.
  const before = journalEvents(fx.dir).length;
  await expect(
    resumeCampaign({
      campaignDir: fx.dir,
      credentials: fixtureCredentials(),
      evalsCheckout: fx.dir,
      gauntletCheckout: fx.dir,
      superpowersCheckout: fx.dir,
      resultsRoot: fx.resultsRoot,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: fixtureChild(fx),
      signal: mortalGroup(),
      graceSeconds: 0,
      probe: PROBE,
      spawner: new FakeSpawner(),
      lockPath: lockDir('resume-gap.lock.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(/still supplies no composed verdict to price it/);
  expect(journalEvents(fx.dir).length).toBe(before); // nothing journaled
});

test('resume reconciliation lands BEFORE the refs cross-check refuses: D-13 terminal evidence, quarantine, and the storage-pause marker are all durable', async () => {
  const fx = crashedCampaign({ driftEvals: true });
  // D-13 terminal evidence: attempt a1's run dir holds a COMPLETE verdict.
  seedRunDir(fx.resultsRoot, 'r1', 'fail');
  writeFileSync(
    join(fx.resultsRoot, 'r1', 'campaign-identity.json'),
    JSON.stringify({
      campaign_id: fx.doc.campaign_id,
      comparison_id: 'c1',
      block_id: BLOCK_A,
      sample_id: SAMPLE_A,
      execution_attempt_id: 'a1',
    }),
  );
  // R-RCV-3: a run dir from ANOTHER campaign sitting in the same results root.
  mkdirSync(join(fx.resultsRoot, 'foreign'), { recursive: true });
  writeFileSync(
    join(fx.resultsRoot, 'foreign', 'campaign-identity.json'),
    JSON.stringify({
      campaign_id: 'a'.repeat(64),
      comparison_id: 'c9',
      block_id: 'b9',
      sample_id: 's9',
      execution_attempt_id: 'a9',
    }),
  );
  // D-13 step 6: the pause marker landed because storage_paused never did.
  writeFileSync(join(fx.dir, '.storage-paused'), '');

  await expect(
    resumeCampaign({
      campaignDir: fx.dir,
      credentials: fixtureCredentials(),
      evalsCheckout: fx.dir,
      gauntletCheckout: fx.dir,
      superpowersCheckout: fx.dir,
      resultsRoot: fx.resultsRoot,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: fixtureChild(fx),
      signal: mortalGroup(),
      graceSeconds: 0,
      probe: PROBE,
      spawner: new FakeSpawner(),
      lockPath: lockDir('resume-drift.lock.d'),
      stream: { write: () => {} },
    }),
    // R-RCV-6: expected identity never derives from current HEAD alone.
  ).rejects.toThrow(/cross-check|refusing to resume/);

  const events = journalEvents(fx.dir);
  const types = events.map((e) => e.type);
  // Retroactive ordering (REV fable M-6): storage_paused precedes every
  // buffered activity event this resume journaled.
  expect(types).toContain('storage_paused');
  const pauseAt = types.indexOf('storage_paused');
  expect(pauseAt).toBeLessThan(types.indexOf('run_completed'));
  expect(pauseAt).toBeLessThan(types.indexOf('aborted'));
  // D-13 terminal-evidence rule: a1's verdict became its journaled terminal.
  const terminal = events.find((e) => e.type === 'run_completed');
  expect(terminal?.payload).toEqual({ attempt_id: 'a1', outcome: 'fail' });
  // Only a2 had no run dir, so the block still re-enters whole — under the
  // storage_failure reason, because this resume reconciled a pause.
  const mint = events
    .filter((e) => e.type === 'block_replaced')
    .map((e) => normalizeBlockReplaced(e.payload))[0];
  expect(mint?.reason).toBe('storage_failure');
  expect(mint?.kind).toBe('rerun');
  // R-RCV-3: the foreign run dir is journal-quarantined, never moved.
  const quarantined = events.filter((e) => e.type === 'quarantined');
  expect(quarantined.map((e) => e.payload)).toContainEqual({
    run_id: 'foreign',
    reason: 'campaign_mismatch',
  });
  // Nothing was admitted: the refs cross-check refused before admission.
  expect(types.filter((t) => t === 'block_admitted').length).toBe(1);
}, 60_000);

test('resume REFUSES when a registered key env is missing (R-REG-19 second occurrence, before any spend)', async () => {
  const fx = crashedCampaign();
  deleteProcessEnv('KEY_B');
  try {
    await expect(
      resumeCampaign({
        campaignDir: fx.dir,
        credentials: fixtureCredentials(),
        evalsCheckout: fx.dir,
        gauntletCheckout: fx.dir,
        superpowersCheckout: fx.dir,
        resultsRoot: fx.resultsRoot,
        clock: new FakeClock(1),
        identity: ALIVE_AT_5,
        child: fixtureChild(fx),
        signal: mortalGroup(),
        graceSeconds: 0,
        probe: PROBE,
        spawner: new FakeSpawner(),
        lockPath: lockDir('resume-keyenv.lock.d'),
        stream: { write: () => {} },
      }),
    ).rejects.toThrow(/KEY_B/);
  } finally {
    setProcessEnv('KEY_B', 'fixture-key-b');
  }
  expect(
    journalEvents(fx.dir).some(
      (e) =>
        e.type === 'block_admitted' && e.payload.block_id === `${BLOCK_A}:i1`,
    ),
  ).toBe(false);
}, 60_000);

test('resume REFUSES when the grader credential is missing from the registry (R-REG-19 fail-closed)', async () => {
  const fx = crashedCampaign();
  const credentials = fixtureCredentials();
  delete credentials['grader_cred'];
  await expect(
    resumeCampaign({
      campaignDir: fx.dir,
      credentials,
      evalsCheckout: fx.dir,
      gauntletCheckout: fx.dir,
      superpowersCheckout: fx.dir,
      resultsRoot: fx.resultsRoot,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: fixtureChild(fx),
      signal: mortalGroup(),
      graceSeconds: 0,
      probe: PROBE,
      spawner: new FakeSpawner(),
      lockPath: lockDir('resume-grader.lock.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(/grader_cred/);
}, 60_000);

test('the .storage-paused marker survives a resume whose reconciliation committed nothing (D-13 step 7)', async () => {
  // No in-flight work, an already-landed storage_paused, and a ballast note
  // already journaled: the reconciliation bundle is empty, so nothing proves
  // storage accepted a write and the durable marker must stay.
  // Identity is anchored to campaign_opened, so the document must be FINAL
  // before publication: seed the snapshot (it supplies the real refs), build
  // the document from them, THEN open the journal against it. Overwriting a
  // published document with a differently-stamped one is now a refusal case,
  // not a fixture shortcut.
  const dir = mkdtempSync(join(tmpdir(), 'resume-pause-'));
  const refs = seedRealSnapshot(dir);
  const doc = campaignDoc({
    refs: { ...refs, evals: 'f'.repeat(40) }, // refuse before admission
    contention: {
      ...campaignDoc().contention,
      host_fingerprint: liveFingerprint(),
    },
  });
  const seed = publishedCampaign({ inFlight: false, doc, dir });
  const w = electWriter({
    campaignDir: seed.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: doc,
  });
  w.appendEvents([
    { type: 'storage_paused', payload: {} },
    {
      type: 'adjudication',
      payload: {
        cell: 'control-plane',
        disposition: 'ballast_spent',
        rationale: 'noted by an earlier resume',
      },
    },
  ]);
  w.release();
  writeFileSync(join(seed.dir, '.storage-paused'), '');
  const before = journalEvents(seed.dir).length;
  await expect(
    resumeCampaign({
      campaignDir: seed.dir,
      credentials: fixtureCredentials(),
      evalsCheckout: seed.dir,
      gauntletCheckout: seed.dir,
      superpowersCheckout: seed.dir,
      resultsRoot: join(seed.dir, 'results'),
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      probe: PROBE,
      spawner: new FakeSpawner(),
      lockPath: lockDir('resume-pause.lock.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(/Campaign.refs cross-check/); // the intended refusal, not an earlier one
  expect(journalEvents(seed.dir).length).toBe(before); // nothing committed
  const { existsSync } = await import('node:fs');
  expect(existsSync(join(seed.dir, '.storage-paused'))).toBe(true);
}, 60_000);
