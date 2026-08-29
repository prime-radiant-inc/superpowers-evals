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
import { electWriter, openJournalRead } from '../src/campaign/journal.ts';
import { resumeCampaign } from '../src/campaign/recovery.ts';
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
function seedRunDir(resultsRoot: string, runId: string, final: string): void {
  const dir = join(resultsRoot, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({
      final,
      final_reason: 'fixture',
      economics: { total_est_cost_usd: 0.25 },
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
  const seed = publishedCampaign({ inFlight: false, doc: campaignDoc() });
  const refs = seedRealSnapshot(seed.dir);
  const doc = campaignDoc({
    refs: { ...refs, evals: 'f'.repeat(40) }, // refuse before admission
    contention: {
      ...campaignDoc().contention,
      host_fingerprint: liveFingerprint(),
    },
  });
  writeFileSync(join(seed.dir, 'campaign.json'), JSON.stringify(doc));
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
  ).rejects.toThrow();
  expect(journalEvents(seed.dir).length).toBe(before); // nothing committed
  const { existsSync } = await import('node:fs');
  expect(existsSync(join(seed.dir, '.storage-paused'))).toBe(true);
}, 60_000);
