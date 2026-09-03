// test/campaign-run-spawner-injection.test.ts — Task 12: the run-verb
// injection seams. `campaignRun` gains an optional options object with TWO
// separate seams (ruling R11): `spawner` (the appliance worker's per-attempt
// container spawner) and `containerStop` (the exact-ID Docker stop seam).
// Neither is ever inferred from the other; task 14 passes one
// ContainerAttemptSpawner explicitly as both. The raw `quorum campaign run`
// verb keeps the no-options process-spawner default — no CLI flag exists in
// v1 (the pinned table).
//
// Proof discipline: every test drives the REAL campaignRun end-to-end over a
// genuinely published, digest-authenticated campaign (the shared
// campaign-recovery fixtures) and asserts journaled outcomes — never a
// captured options object. The two stopper-forwarding proofs ride the
// journaled-container fixture: an 'alive' stop must leave the container
// unverified (the R-RCV-1 refusal, journal untouched) and a 'dead' stop must
// complete a requested cancellation (aborted + campaign_cancelled LAST).
//
// The full spawner-run proof (a resumed campaign whose remaining attempt is
// spawned by the injected spawner and driven to seal) is Linux-only: the
// resume preflight samples the host through the production probe, whose
// non-Linux refusal IS the R-LCK-3 designated-host discipline — on any other
// platform admission is unreachable by design, so the test skips rather than
// assert a refusal that would prove nothing about the spawner.
import { afterAll, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import type { ContainerStopper } from '../src/campaign/container-spawner.ts';
import { electWriter } from '../src/campaign/journal.ts';
import { REPORT_JSON_NAME } from '../src/campaign/report.ts';
import { runTerminusSeal } from '../src/campaign/seal.ts';
import type {
  CampaignChildSpec,
  ChildExitInfo,
  ChildSpawner,
  SpawnedCampaignChild,
} from '../src/campaign/spawn.ts';
import { campaignRun } from '../src/cli/campaign.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import { CampaignSchema } from '../src/contracts/campaign/campaign.ts';
import { campaignDigest } from '../src/contracts/campaign/digest.ts';
import { deleteProcessEnv, getEnv, setProcessEnv } from '../src/env.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import {
  ALIVE_AT_5,
  journaledTypes,
  lockDir,
  publishedCampaign,
  publishedContainerCampaign,
  reportCampaign,
  reportEvents,
  seedRealSnapshot,
  WRITER_IDENTITY,
} from './campaign-recovery-fixtures.ts';

// The run verb resolves its source checkouts from the environment (C12b)
// and acquires the live-spend lock at the default path, so both seams are
// pointed at throwaway test values for the whole file, restored afterwards.
const PRIOR_ENV = new Map<string, string | undefined>(
  ['GAUNTLET_ROOT', 'SUPERPOWERS_ROOT', 'QUORUM_LIVE_SPEND_LOCK'].map((k) => [
    k,
    getEnv(k),
  ]),
);
const CHECKOUT_STANDIN = mkdtempSync(join(tmpdir(), 'run-inject-checkout-'));
setProcessEnv('GAUNTLET_ROOT', CHECKOUT_STANDIN);
setProcessEnv('SUPERPOWERS_ROOT', CHECKOUT_STANDIN);
setProcessEnv('QUORUM_LIVE_SPEND_LOCK', lockDir('run-inject-spend.lock.d'));
afterAll(() => {
  for (const [key, prior] of PRIOR_ENV) {
    if (prior === undefined) deleteProcessEnv(key);
    else setProcessEnv(key, prior);
  }
});

// The frozen sidecar name the sampler/seal read (the terminus-fixture
// convention: one well-formed line).
const SIDECAR = 'contention-telemetry.jsonl';

// The run verb's results root is the evals checkout's own results/ tree
// (resolveCampaignResultsRoot's default) — the same root the report CLI
// tests write their run dirs into. Unique run IDs + explicit cleanup keep
// the shared tree clean.
const RESULTS_ROOT = resolve(import.meta.dir, '..', 'results');

const CREDENTIALS_YAML = [
  ...[
    'cred_a:',
    '  model: model-a',
    '  harnesses: [claude]',
    '  api: anthropic',
    '  auth: api-key',
    '  api_key_env: KEY_A',
    '',
  ],
  ...[
    'grader_cred:',
    '  model: grader-model',
    '  harnesses: [claude]',
    '  api: anthropic',
    '  auth: api-key',
    '  api_key_env: KEY_G',
    '',
  ],
].join('\n');

/** The snapshot-tree credentials file the run verb parses before resume
 * (campaignDir/evals/credentials.yaml — cred_a is the single-arm fixture
 * document's arm credential, grader_cred its grader). Plain variant for
 * fixtures with no snapshot trees (the refusal paths — nothing ever
 * verifies the evals worktree there). */
function writeCredentials(campaignDir: string): void {
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  writeFileSync(
    join(campaignDir, 'evals', 'credentials.yaml'),
    CREDENTIALS_YAML,
  );
}

/** The same file, but COMMITTED into the campaign's evals snapshot tree:
 * a campaign dir seeded by seedRealSnapshot carries the Decision D-6
 * layout, so campaignDir/evals is a real git repo and an uncommitted
 * credentials write IS the drift the seal's pre-seal verify refuses. The
 * tree's new HEAD is the refs.evals the document must register (the real
 * flow registers a checkout that already carries the committed bundle). */
function commitCredentialsIntoEvals(campaignDir: string): string {
  writeCredentials(campaignDir);
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', join(campaignDir, 'evals'), ...args], {
      encoding: 'utf8',
    });
  git('add', 'credentials.yaml');
  git(
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-qm',
    'credentials',
  );
  return spawnSync(
    'git',
    ['-C', join(campaignDir, 'evals'), 'rev-parse', 'HEAD'],
    {
      encoding: 'utf8',
    },
  ).stdout.trim();
}

/** Capture process.stderr during an async verb call (the CLI-boundary
 * refusal channel), restoring the stream in finally. */
async function captureStderr(fn: () => Promise<number>): Promise<{
  code: number;
  loud: string;
}> {
  const spy = spyOn(process.stderr, 'write');
  let loud = '';
  spy.mockImplementation((chunk: string) => {
    loud += String(chunk);
    return true;
  });
  try {
    return { code: await fn(), loud };
  } finally {
    spy.mockRestore();
  }
}

/** Capture process.stdout during an async verb call (the verb's finish line
 * and the resume banner), restoring the stream in finally. */
async function captureStdout(fn: () => Promise<number>): Promise<{
  code: number;
  said: string;
}> {
  const spy = spyOn(process.stdout, 'write');
  let said = '';
  spy.mockImplementation((chunk: string) => {
    said += String(chunk);
    return true;
  });
  try {
    return { code: await fn(), said };
  } finally {
    spy.mockRestore();
  }
}

// ── container stopper: normal resume recovery ───────────────────────────────

test('campaignRun forwards the container stopper to normal resume recovery', async () => {
  // The journaled container allocation is the whole proof surface: the
  // injected stopper must be THE thing recovery stops the exact container
  // ID through. An 'alive' outcome is the R-RCV-1 refusal — the container
  // cannot be verified dead, so the resume must refuse BEFORE any journal
  // mutation, with the exact ID recorded by the stopper.
  const fx = publishedContainerCampaign();
  writeCredentials(fx.dir);
  const stopped: string[] = [];
  const containerStop: ContainerStopper = {
    stop: async (containerId) => {
      stopped.push(containerId);
      return 'alive';
    },
  };
  const before = journaledTypes(fx.dir, 2);

  const { code, loud } = await captureStderr(() =>
    campaignRun(fx.dir, { containerStop }),
  );

  expect(code).toBe(1);
  expect(stopped).toEqual(['a'.repeat(64)]);
  expect(loud).toMatch(/container\(s\).*could not be verified dead/);
  expect(journaledTypes(fx.dir, 2)).toEqual(before);
}, 60_000);

// ── container stopper: cancel-request precedence ────────────────────────────

test('campaignRun forwards the container stopper through cancel-request precedence and never spawns', async () => {
  // The precedence branch (R-RCV-7 FIRST) completes the requested
  // cancellation directly through cancelCampaign — it must never spawn an
  // attempt, so a spawner that throws on spawn proves the negative, and a
  // 'dead' stop must let the pinned cancel order journal aborted per
  // in-flight block and campaign_cancelled LAST.
  const fx = publishedContainerCampaign();
  writeFileSync(
    join(fx.dir, 'cancel-request'),
    `${Date.now()}\noperator halt\n`,
  );
  const stopped: string[] = [];
  const containerStop: ContainerStopper = {
    stop: async (containerId) => {
      stopped.push(containerId);
      return 'dead';
    },
  };
  const spawner: ChildSpawner = {
    kind: 'process',
    spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
      throw new Error(
        `cancel-request precedence must never spawn (${
          spec.attempt?.attemptId ?? 'no attempt context'
        })`,
      );
    },
  };

  const { code, said } = await captureStdout(() =>
    campaignRun(fx.dir, { spawner, containerStop }),
  );

  expect(code).toBe(0);
  expect(said).toContain(
    'cancel-request present — completing cancellation instead of resuming',
  );
  expect(stopped).toEqual(['a'.repeat(64)]);
  const types = journaledTypes(fx.dir, 2);
  expect(types).toContain('aborted');
  expect(types.at(-1)).toBe('campaign_cancelled');
}, 60_000);

// ── no options: the raw verb path is unchanged ───────────────────────────────

/** A sealed, already-complete campaign whose report.json is missing: the
 * R-RCV-5 sealed-tail path refolds the sealed prefix, verifies the digest,
 * republishes the artifact pair, and resolves 'completed' — zero attempts
 * to spawn, so the no-options call settles it with no behavioral change. */
function sealedCampaignFixture(): { dir: string; runIds: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'run-inject-sealed-'));
  const refs = seedRealSnapshot(dir);
  const evalsSha = commitCredentialsIntoEvals(dir);
  const single = reportCampaign({ singleArm: true });
  const parsed = CampaignSchema.parse({
    ...single,
    refs: { ...refs, evals: evalsSha },
    campaign_id: 'd'.repeat(64),
    digest: 'd'.repeat(64),
  });
  const digest = campaignDigest(parsed);
  const doc: Campaign = { ...parsed, campaign_id: digest, digest };
  const published = publishedCampaign({ inFlight: false, doc, dir });
  const runIds = ['run-inject-sealed-r1', 'run-inject-sealed-r2'];
  const steps = [
    {
      kind: 'run' as const,
      run: {
        sampleId: 'c1:scn:arm_a:r1',
        attemptId: 'si-a1',
        runId: runIds[0] as string,
        outcome: 'pass' as const,
      },
    },
    {
      kind: 'run' as const,
      run: {
        sampleId: 'c1:scn:arm_a:r2',
        attemptId: 'si-a2',
        runId: runIds[1] as string,
        outcome: 'fail' as const,
      },
    },
  ];
  for (const [index, runId] of runIds.entries()) {
    const runDir = join(RESULTS_ROOT, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'verdict.json'),
      JSON.stringify({
        final: index === 0 ? 'pass' : 'fail',
        final_reason: 'fixture',
        economics: { total_est_cost_usd: 0.25 },
      }),
    );
    writeFileSync(
      join(runDir, 'trajectory.json'),
      JSON.stringify({ steps: [{ timestamp: '2026-08-29T00:00:00.000Z' }] }),
    );
  }
  const events = reportEvents({ campaign: doc, steps });
  const w = electWriter({
    campaignDir: published.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: doc,
  });
  w.appendEvents(
    events
      .slice(1)
      .map((event) => ({ type: event.type, payload: event.payload })),
  );
  w.release();
  writeFileSync(
    join(published.dir, SIDECAR),
    `${JSON.stringify({
      ts_ms: 1,
      load1: 1,
      mem_available_bytes: 8 * 2 ** 30,
      swap_used_bytes: 0,
      process_count: 100,
      disk_free_bytes: 50 * 2 ** 30,
      breach: [],
    })}\n`,
  );
  const sealed = runTerminusSeal({
    campaignDir: published.dir,
    resultsRoot: RESULTS_ROOT,
    clock: new FakeClock(1),
    identity: ALIVE_AT_5,
    stream: { write: () => {} },
  });
  if (sealed.outcome !== 'sealed') {
    throw new Error(
      `fixture did not seal: ${sealed.outcome}${
        sealed.outcome === 'refused_drift'
          ? ` (${sealed.trees.join(', ')})`
          : ''
      }`,
    );
  }
  // Open the sealed-tail window: the report pair is the completion marker.
  rmSync(join(published.dir, REPORT_JSON_NAME));
  return { dir: published.dir, runIds };
}

test('campaignRun without options settles an already-complete campaign unchanged (sealed-tail republish, zero spawns)', async () => {
  // The raw verb path is the pinned contract: `quorum campaign run <dir>`
  // invokes campaignRun(dir) with NO options and keeps the process-spawner
  // default. On a zero-spawn terminal fixture the call must resolve exit 0
  // with the sealed-tail republication — no flag, no behavior change.
  const fx = sealedCampaignFixture();
  try {
    const { code, said } = await captureStdout(() => campaignRun(fx.dir));
    expect(code).toBe(0);
    expect(said).toContain('campaign run finished: completed');
    // The completion marker is back on disk, digest-verified by the fold.
    expect(existsSync(join(fx.dir, REPORT_JSON_NAME))).toBe(true);
    expect(journaledTypes(fx.dir, 2).at(-1)).toBe('sealed');
  } finally {
    for (const runId of fx.runIds) {
      rmSync(join(RESULTS_ROOT, runId), { recursive: true, force: true });
    }
  }
}, 120_000);

// ── spawner: the injected spawner runs the attempts (Linux-designated host) ──

// The scripted-child seam (the campaign-resume suite's shape): a fake child
// is a real SpawnedCampaignChild over an impossible pgid, driven by the
// test through the same stdout/exit surface the dispatcher consumes.
const FAKE_PID_BASE = 900_000_001;

class FakeChild implements SpawnedCampaignChild {
  readonly handle: { readonly kind: 'process'; readonly pgid: number };
  private readonly stdoutCbs: ((l: string) => void)[] = [];
  private readonly exitCbs: ((i: ChildExitInfo) => void)[] = [];
  constructor(pid: number) {
    this.handle = { kind: 'process', pgid: pid };
  }
  get stdoutLines(): readonly string[] {
    return [];
  }
  get stderrLines(): readonly string[] {
    return [];
  }
  emitLine(line: string): void {
    for (const cb of this.stdoutCbs) cb(line);
  }
  exit(info: ChildExitInfo): void {
    for (const cb of this.exitCbs) cb(info);
  }
  onStdoutLine(cb: (l: string) => void): void {
    this.stdoutCbs.push(cb);
  }
  onStderrLine(cb: (l: string) => void): void {
    void cb;
  }
  onExit(cb: (i: ChildExitInfo) => void): void {
    this.exitCbs.push(cb);
  }
}

class FakeSpawner implements ChildSpawner {
  readonly kind = 'process' as const;
  readonly spawned: { spec: CampaignChildSpec; child: FakeChild }[] = [];
  private nextPid = FAKE_PID_BASE;
  spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
    const child = new FakeChild(this.nextPid++);
    this.spawned.push({ spec, child });
    return child;
  }
}

/** The registered fingerprint of the host THIS process runs on: the resume
 * preflight compares it against a fresh production-probe sample (exact
 * cpu_model/cpu_cores, tolerance bands on mem/disk — Decision D-4), so the
 * fixture document must carry the live host's own identity. */
function liveFingerprint(
  diskPath: string,
): Campaign['contention']['host_fingerprint'] {
  const cpu = cpus();
  const fs = statfsSync(diskPath);
  return {
    cpu_model: cpu[0]?.model ?? 'unknown',
    cpu_cores: cpu.length,
    mem_bytes: totalmem(),
    disk_total_bytes: fs.blocks * fs.bsize,
  };
}

/** A published single-arm descriptive campaign with ONE primary terminal
 * (journaled pass) and one still to serve: the resume must admit the second
 * block, spawn its attempt through the INJECTED spawner, and — once the
 * test drives the fake child to a journaled terminal — reach the terminus
 * seal. Key envs the preflight demands (R-REG-19) are seeded per call. */
function pendingCampaignFixture(): {
  dir: string;
  journaledRunId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'run-inject-pending-'));
  const refs = seedRealSnapshot(dir);
  const evalsSha = commitCredentialsIntoEvals(dir);
  const single = reportCampaign({ singleArm: true });
  const parsed = CampaignSchema.parse({
    ...single,
    refs: { ...refs, evals: evalsSha },
    campaign_id: 'd'.repeat(64),
    digest: 'd'.repeat(64),
    contention: {
      ...single.contention,
      host_fingerprint: liveFingerprint(dir),
    },
  });
  const digest = campaignDigest(parsed);
  const doc: Campaign = { ...parsed, campaign_id: digest, digest };
  const published = publishedCampaign({ inFlight: false, doc, dir });
  const journaledRunId = 'run-inject-pending-r1';
  const runDir = join(RESULTS_ROOT, journaledRunId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'verdict.json'),
    JSON.stringify({
      final: 'pass',
      final_reason: 'fixture',
      economics: { total_est_cost_usd: 0.25 },
    }),
  );
  writeFileSync(
    join(runDir, 'trajectory.json'),
    JSON.stringify({ steps: [{ timestamp: '2026-08-29T00:00:00.000Z' }] }),
  );
  const events = reportEvents({
    campaign: doc,
    steps: [
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r1',
          attemptId: 'pi-a1',
          runId: journaledRunId,
          outcome: 'pass',
        },
      },
    ],
  });
  const w = electWriter({
    campaignDir: published.dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: doc,
  });
  w.appendEvents(
    events
      .slice(1)
      .map((event) => ({ type: event.type, payload: event.payload })),
  );
  w.release();
  writeFileSync(
    join(published.dir, SIDECAR),
    `${JSON.stringify({
      ts_ms: 1,
      load1: 1,
      mem_available_bytes: 8 * 2 ** 30,
      swap_used_bytes: 0,
      process_count: 100,
      disk_free_bytes: 50 * 2 ** 30,
      breach: [],
    })}\n`,
  );
  return { dir: published.dir, journaledRunId };
}

/** Real wall-clock sleep — this proof runs against RealClock, so the test
 * polls the spawner until the dispatcher admits and spawns. */
const sleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

test.skipIf(process.platform !== 'linux')(
  'campaignRun forwards an injected spawner to the dispatcher — the remaining attempt runs through it and the campaign seals',
  async () => {
    // Linux-only by R-LCK-3: the resume preflight samples the host through
    // the production probe, which refuses everywhere but the designated
    // Linux appliance — on any other host admission (the only thing that
    // consumes a spawner) is unreachable, so there is nothing to prove.
    setProcessEnv('KEY_A', 'fixture-key-a');
    setProcessEnv('KEY_G', 'fixture-key-g');
    const fx = pendingCampaignFixture();
    const spawner = new FakeSpawner();
    try {
      const run = captureStdout(() => campaignRun(fx.dir, { spawner }));
      // Admission: the dispatcher serves the pending sample by spawning
      // through the INJECTED spawner (RealClock wake loop is ~1s a wave).
      const deadline = Date.now() + 90_000;
      while (spawner.spawned.length === 0) {
        if (Date.now() > deadline) {
          throw new Error('dispatcher never spawned the pending attempt');
        }
        await sleep(200);
      }
      expect(spawner.spawned.length).toBe(1);
      const child = spawner.spawned[0]?.child;
      if (child === undefined) throw new Error('unreachable');
      // The child's run id travels on its `run_allocated:` stdout line; the
      // dispatcher journals it, so the terminal evidence lands under the
      // verb's own results root.
      const runId = `run-${child.handle.pgid}`;
      const runDir = join(RESULTS_ROOT, runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'verdict.json'),
        JSON.stringify({
          final: 'fail',
          final_reason: 'fixture',
          economics: { total_est_cost_usd: 0.25 },
        }),
      );
      writeFileSync(
        join(runDir, 'trajectory.json'),
        JSON.stringify({ steps: [{ timestamp: '2026-08-29T00:00:00.000Z' }] }),
      );
      child.emitLine(`run_allocated: ${runId}`);
      await sleep(1500); // let the dispatcher journal the allocation
      child.exit({ code: 0, signal: null });
      const { code, said } = await run;
      expect(code).toBe(0);
      expect(said).toContain('campaign run finished: completed');
      // The spawned attempt reached a journaled terminal and the campaign
      // sealed: settled, not merely spawned.
      const types = journaledTypes(fx.dir, 2);
      expect(types.filter((t) => t === 'run_completed').length).toBe(2);
      expect(types.at(-1)).toBe('sealed');
      rmSync(join(RESULTS_ROOT, runId), { recursive: true, force: true });
    } finally {
      deleteProcessEnv('KEY_A');
      deleteProcessEnv('KEY_G');
      rmSync(join(RESULTS_ROOT, fx.journaledRunId), {
        recursive: true,
        force: true,
      });
    }
  },
  180_000,
);
