// Shared fixtures for the resume + cancellation verbs (task 9b). Both verbs
// AUTHENTICATE campaign.json (schema, recomputed digest, identity, closure),
// so every fixture here is a genuinely valid AND authentic frozen document —
// a minimal stand-in would only prove the intake was skipped.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electWriter, initJournalDb } from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import { CampaignSchema } from '../src/contracts/campaign/campaign.ts';
import { campaignDigest } from '../src/contracts/campaign/digest.ts';
import {
  type JournalEvent,
  JournalEventSchema,
  type JournalEventType,
} from '../src/contracts/campaign/journal-events.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

export const BLOCK_A = 'c1:scn:b1';
export const SAMPLE_A = 'c1:scn:arm_a:r1';
export const SAMPLE_B = 'c1:scn:arm_b:r1';
/** The journaled pgid of the crashed in-flight attempt. Far above any real
 *  PID: a fixture pgid must never name a live process. */
export const CRASHED_PGID = 999999999;

/** The command/lease identity of the verb process itself: no campaign child
 *  is alive, and no dispatcher holds the live-spend lock, but this process
 *  keeps a readable identity so it can take the journal lease. */
export const NO_LIVE_CHILD: ProcessIdentityProbe = {
  exists: (pid) => (pid === process.pid ? 'alive' : 'esrch'),
  startTimeMs: (pid) => (pid === process.pid ? 1 : null),
};

export const WRITER_IDENTITY: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 1,
};

/** Every probed pid is alive with a stable start time — the shape a live
 *  campaign child presents to the R-RCV-1 guard. */
export const ALIVE_AT_5: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 5,
};

export function lockDir(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'lock-')), name);
}

export function credential(env: string): Credential {
  return {
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    api_key_env: env,
    compat: {},
    max_concurrency: 2,
  } as Credential;
}

export function fixtureCredentials(): Record<string, Credential> {
  return {
    cred_a: credential('KEY_A'),
    cred_b: credential('KEY_B'),
    grader_cred: credential('KEY_G'),
  };
}

export interface CampaignDocOverrides {
  readonly refs?: Campaign['refs'];
  readonly contention?: Campaign['contention'];
}

/** A schema-valid two-arm campaign: one confirmatory cell, one primary
 *  block, one reserve block. */
export function campaignDoc(overrides: CampaignDocOverrides = {}): Campaign {
  const doc = {
    schema_version: 1,
    campaign_id: 'd'.repeat(64), // placeholder: re-stamped below
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
    refs: overrides.refs ?? {
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
      { sample_id: SAMPLE_A, cell: 'c1:scn', arm: 'arm_a', replicate: 1 },
      { sample_id: SAMPLE_B, cell: 'c1:scn', arm: 'arm_b', replicate: 1 },
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
        block_id: BLOCK_A,
        comparison_id: 'c1',
        sample_ids: [SAMPLE_A, SAMPLE_B],
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
    digest: 'd'.repeat(64), // placeholder: re-stamped below (excluded from the digest input)
    contention: overrides.contention ?? {
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
  };
  // Parsed, not cast: the fixture is only useful if it is the same document
  // the production verbs accept — which means AUTHENTIC, so the identity is
  // stamped from the content's own digest.
  const parsed = CampaignSchema.parse(doc);
  const digest = campaignDigest(parsed);
  return { ...parsed, digest, campaign_id: digest };
}

/** Identity is the digest, so the fixture cannot pin a literal: the default
 *  document's own recomputed digest IS its id. A document built with
 *  overrides carries a different (re-stamped) identity — read it off the
 *  document, never off this constant. */
export const DIGEST: string = campaignDoc().digest;
export const CAMPAIGN_ID: string = DIGEST;

export interface PublishedOptions {
  /** Journal a crashed in-flight attempt (attempt_created + run_allocated on
   *  CRASHED_PGID) for sample A. Default true. */
  readonly inFlight?: boolean;
  readonly doc?: Campaign;
  /** Publish into an EXISTING directory (a caller that had to seed the
   *  snapshot before it could compute the document's refs, and therefore its
   *  identity). Default: a fresh tmp dir. */
  readonly dir?: string;
}

/** A published campaign dir: campaign.json, ballast, sidecar, and a journal
 *  cut off mid-run exactly where a crash would leave it. */
export function publishedCampaign(options: PublishedOptions = {}): {
  dir: string;
  doc: Campaign;
} {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'cancel-'));
  const doc = options.doc ?? campaignDoc();
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(doc));
  writeFileSync(join(dir, 'contention-telemetry.jsonl'), '');
  initJournalDb(dir);
  // The writer holds the frozen membership: attempt_created resolves its
  // block from it (a campaign-less writer refuses to fabricate one).
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: doc,
  });
  w.appendEvent({
    type: 'campaign_opened',
    payload: { campaign_id: doc.campaign_id, digest: doc.digest },
  });
  if (options.inFlight !== false) {
    w.appendEvent({
      type: 'block_admitted',
      payload: { block_id: BLOCK_A, pools: ['p'] },
    });
    w.appendEvent({
      type: 'attempt_created',
      payload: { sample_id: SAMPLE_A, attempt_id: 'a1' },
    });
    w.appendEvent({
      type: 'run_allocated',
      payload: {
        attempt_id: 'a1',
        run_id: 'r1',
        pgid: CRASHED_PGID,
        key_grants: [],
      },
    });
  }
  w.release();
  return { dir, doc };
}

export function journaledTypes(dir: string, atSeconds: number): string[] {
  const r = electWriter({
    campaignDir: dir,
    clock: new FakeClock(atSeconds),
    identity: WRITER_IDENTITY,
  });
  try {
    return r.readEvents().map((e) => e.type);
  } finally {
    r.release();
  }
}

// ---------------------------------------------------------------------------
// Descriptive-report fixtures (kernel D4a task 3): a small exploratory
// campaign + a synthesizer for replay-legal event prefixes. The fold itself
// (src/campaign/report.ts) runs the production replayEvents over whatever
// these builders emit, so a prefix that violates the pinned machine fails
// loud inside the fold — the fixtures cannot accidentally bless an illegal
// stream.
// ---------------------------------------------------------------------------

/** The exploratory report fixture's blocks: two primary replicates of the
 *  one cell plus one frozen reserve (activated only by a block_replaced). */
export const REPORT_BLOCK_1 = 'c1:scn:b1';
export const REPORT_BLOCK_2 = 'c1:scn:b2';
export const REPORT_RESERVE = 'c1:scn:x1';

export interface ReportCampaignOverrides {
  /** null OMITS suite.profile — the exploratory suite without a declared
   *  profile (folds as descriptive_v1). Default: 'descriptive_v1'. */
  readonly profile?: 'descriptive_v1' | null;
  /** Single-arm comparison shape (one arm, one sample per block). */
  readonly singleArm?: boolean;
  /** Registered model ids, for provenance tests that need a specific shape
   *  (e.g. a Bedrock-prefixed `anthropic.claude-*` request id). Defaults:
   *  arm_a model-a, arm_b model-b, grader grader-model. */
  readonly models?: {
    readonly arm_a?: string;
    readonly arm_b?: string;
    readonly grader?: string;
  };
}

/** A small schema-valid exploratory campaign for the report fold: one
 *  comparison, one descriptive cell (n=2), arms arm_a/arm_b registered as
 *  models model-a/model-b, grader grader-model — distinct names so
 *  provenance/grader tests can match or miss them on purpose. Same
 *  parse-and-restamp discipline as campaignDoc: the fixture must be the
 *  document the production verbs accept, so identity is its own digest. */
export function reportCampaign(
  overrides: ReportCampaignOverrides = {},
): Campaign {
  const single = overrides.singleArm === true;
  const modelA = overrides.models?.arm_a ?? 'model-a';
  const modelB = overrides.models?.arm_b ?? 'model-b';
  const graderModel = overrides.models?.grader ?? 'grader-model';
  const profile =
    overrides.profile === null
      ? {}
      : { profile: overrides.profile ?? 'descriptive_v1' };
  const estimate = (costUsd: number) => ({
    duration_s: 100,
    cost_usd: costUsd,
    confidence: 'high',
  });
  const doc = {
    schema_version: 1,
    campaign_id: 'd'.repeat(64), // placeholder: re-stamped below
    suite: {
      schema_version: 1,
      name: 'reportsuite',
      kind: 'exploratory',
      budget_usd: 50,
      ...profile,
      comparisons: [
        single
          ? { arm: 'arm_a', scenarios: ['scn'], n: 2 }
          : { baseline: 'arm_a', treatment: 'arm_b', scenarios: ['scn'], n: 2 },
      ],
    },
    refs: {
      superpowers_by_arm: single
        ? { arm_a: null }
        : { arm_a: null, arm_b: null },
      evals: 'e'.repeat(40),
      gauntlet: '9'.repeat(40),
    },
    grader: { credential: 'grader_cred', model: graderModel },
    cells: [
      {
        scenario: 'scn',
        comparison_id: 'c1',
        arms: single ? ['arm_a'] : ['arm_a', 'arm_b'],
        n: 2,
        class: 'descriptive',
        coupling: 'arm-independent',
        estimates_by_arm: single
          ? { arm_a: estimate(1) }
          : { arm_a: estimate(1), arm_b: estimate(2) },
      },
    ],
    excluded_cells: [],
    samples: single
      ? [
          {
            sample_id: 'c1:scn:arm_a:r1',
            cell: 'c1:scn',
            arm: 'arm_a',
            replicate: 1,
          },
          {
            sample_id: 'c1:scn:arm_a:r2',
            cell: 'c1:scn',
            arm: 'arm_a',
            replicate: 2,
          },
          {
            sample_id: 'c1:scn:arm_a:x1',
            cell: 'c1:scn',
            arm: 'arm_a',
            replicate: 1,
          },
        ]
      : [
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
    comparisons: [
      single
        ? { comparison_id: 'c1', arm: 'arm_a' }
        : { comparison_id: 'c1', baseline: 'arm_a', treatment: 'arm_b' },
    ],
    blocks: single
      ? [
          {
            block_id: REPORT_BLOCK_1,
            comparison_id: 'c1',
            sample_ids: ['c1:scn:arm_a:r1'],
          },
          {
            block_id: REPORT_BLOCK_2,
            comparison_id: 'c1',
            sample_ids: ['c1:scn:arm_a:r2'],
          },
          {
            block_id: REPORT_RESERVE,
            comparison_id: 'c1',
            sample_ids: ['c1:scn:arm_a:x1'],
            slot: 'reserve',
          },
        ]
      : [
          {
            block_id: REPORT_BLOCK_1,
            comparison_id: 'c1',
            sample_ids: ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'],
          },
          {
            block_id: REPORT_BLOCK_2,
            comparison_id: 'c1',
            sample_ids: ['c1:scn:arm_a:r2', 'c1:scn:arm_b:r2'],
          },
          {
            block_id: REPORT_RESERVE,
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
    registered_at: '2026-08-31T00:00:00Z',
    registered_by: 'test',
    digest: 'd'.repeat(64), // placeholder: re-stamped below
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
    execution_surface: single
      ? [
          {
            name: 'arm_a',
            agent: 'claude',
            credential: 'cred_a',
            auth: 'api-key',
            api: 'anthropic',
            model: modelA,
            key_env_names: ['KEY_A'],
          },
        ]
      : [
          {
            name: 'arm_a',
            agent: 'claude',
            credential: 'cred_a',
            auth: 'api-key',
            api: 'anthropic',
            model: modelA,
            key_env_names: ['KEY_A'],
          },
          {
            name: 'arm_b',
            agent: 'claude',
            credential: 'cred_b',
            auth: 'api-key',
            api: 'anthropic',
            model: modelB,
            key_env_names: ['KEY_B'],
          },
        ],
  };
  const parsed = CampaignSchema.parse(doc);
  const digest = campaignDigest(parsed);
  return { ...parsed, digest, campaign_id: digest };
}

/** One sample's journey through the journal: attempt → run → (exposure →)
 *  terminal. `instrument_failure` journals the typed instrument terminal;
 *  `caveat: true` completes from spawned under the exploratory exposure
 *  caveat (R-SNS-4 — no exposure_started, run_completed carries the caveat:
 *  the journaled skew-caveat shape). */
export interface ReportRunSpec {
  readonly sampleId: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly outcome: 'pass' | 'fail' | 'indeterminate' | 'instrument_failure';
  readonly caveat?: boolean;
}

/** A raw journal event the tests interleave between runs (mints,
 *  dispositions, adjudications, skew events): the payload is validated by
 *  the production envelope schema at stamp time. */
export interface ReportRawEvent {
  readonly type: JournalEventType;
  readonly payload: unknown;
}

export type ReportStep =
  | { readonly kind: 'run'; readonly run: ReportRunSpec }
  | { readonly kind: 'raw'; readonly event: ReportRawEvent };

/** Synthesize a replay-legal event prefix: campaign_opened, then the steps
 *  in order — a `run` lazily admits its frozen block on first use and emits
 *  the full per-sample prefix; a `raw` stamps the caller's event as-is.
 *  Envelope ts follows the fixtures' FakeClock convention (one advance(1)
 *  per event); every envelope is parsed by JournalEventSchema so a
 *  malformed payload fails the fixture, not the test's expectations. */
export function reportEvents(args: {
  readonly campaign: Campaign;
  readonly steps: readonly ReportStep[];
}): JournalEvent[] {
  const clock = new FakeClock(0);
  const blockOfSample = new Map<string, string>();
  for (const block of args.campaign.blocks) {
    for (const sampleId of block.sample_ids) {
      blockOfSample.set(sampleId, block.block_id);
    }
  }
  const admitted = new Set<string>();
  const out: JournalEvent[] = [];
  const emit = (type: JournalEventType, payload: unknown): void => {
    clock.advance(1);
    const seq = out.length + 1;
    out.push(
      JournalEventSchema.parse({
        seq,
        ts_ms: clock.now() * 1000,
        type,
        payload,
      }),
    );
  };
  emit('campaign_opened', {
    campaign_id: args.campaign.campaign_id,
    digest: args.campaign.digest,
  });
  for (const step of args.steps) {
    if (step.kind === 'raw') {
      emit(step.event.type, step.event.payload);
      continue;
    }
    const run = step.run;
    const blockId = blockOfSample.get(run.sampleId);
    if (blockId === undefined) {
      throw new Error(
        `reportEvents: sample ${run.sampleId} belongs to no block of the campaign`,
      );
    }
    if (!admitted.has(blockId)) {
      admitted.add(blockId);
      emit('block_admitted', { block_id: blockId, pools: ['p'] });
    }
    emit('attempt_created', {
      sample_id: run.sampleId,
      attempt_id: run.attemptId,
    });
    emit('run_allocated', {
      attempt_id: run.attemptId,
      run_id: run.runId,
      pgid: CRASHED_PGID,
      key_grants: [],
    });
    if (run.outcome === 'instrument_failure') {
      emit('exposure_started', {
        sample_id: run.sampleId,
        ts: clock.now() * 1000,
      });
      emit('instrument_failure', {
        attempt_id: run.attemptId,
        cause: 'grader_rate_limited',
      });
    } else if (run.caveat === true) {
      emit('run_completed', {
        attempt_id: run.attemptId,
        outcome: run.outcome,
        caveat: 'exploratory_exposure_unestablished',
      });
    } else {
      emit('exposure_started', {
        sample_id: run.sampleId,
        ts: clock.now() * 1000,
      });
      emit('run_completed', {
        attempt_id: run.attemptId,
        outcome: run.outcome,
      });
    }
  }
  return out;
}

/** The campaign child's real argv shape (spawn.ts buildCampaignChildArgv):
 *  the persisted identity travels on `--campaign-identity`. */
export function childCommandLine(
  attemptId: string,
  campaignId: string = CAMPAIGN_ID,
): string {
  return `bun /snap/src/cli/index.ts run /scn --campaign-identity {"campaign_id":"${campaignId}","comparison_id":"c1","block_id":"${BLOCK_A}","sample_id":"${SAMPLE_A}","execution_attempt_id":"${attemptId}"}`;
}

// ---------------------------------------------------------------------------
// A real on-disk instrument snapshot (R-RCV-6 reconstruction runs the REAL
// git commands through defaultCommandRunner, so the trees must be real).
// ---------------------------------------------------------------------------

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...gargs: string[]) =>
    spawnSync('git', gargs, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
  return spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
}

/** Seed `<campaignDir>` with the Decision D-6 snapshot layout over real git
 *  repos and return the refs those trees actually carry. */
/** The three trees are built ONCE per test process and copied per fixture:
 *  `git init` + commit costs ~9 subprocesses each, and this suite already
 *  has tests sitting close to their timeouts. A copied repo keeps its HEAD
 *  and its clean porcelain, which is all reconstruction and the drift guard
 *  read. */
let SNAPSHOT_TEMPLATE: { dir: string; refs: Campaign['refs'] } | null = null;

function snapshotTemplate(): { dir: string; refs: Campaign['refs'] } {
  if (SNAPSHOT_TEMPLATE === null) {
    const dir = mkdtempSync(join(tmpdir(), 'snap-tpl-'));
    const evals = initRepo(join(dir, 'evals'));
    const gauntlet = initRepo(join(dir, 'gauntlet'));
    // The worktree directory name embeds its own HEAD, so the repo is built
    // under a scratch name and renamed once the sha is known.
    const scratch = join(dir, 'sp-scratch');
    const sp = initRepo(scratch);
    renameSync(scratch, join(dir, `superpowers-${sp}`));
    SNAPSHOT_TEMPLATE = {
      dir,
      refs: { superpowers_by_arm: { arm_a: sp, arm_b: sp }, evals, gauntlet },
    };
  }
  return SNAPSHOT_TEMPLATE;
}

export function seedRealSnapshot(campaignDir: string): Campaign['refs'] {
  const template = snapshotTemplate();
  for (const entry of readdirSync(template.dir)) {
    cpSync(join(template.dir, entry), join(campaignDir, entry), {
      recursive: true,
    });
  }
  mkdirSync(join(campaignDir, 'bin'), { recursive: true });
  writeFileSync(
    join(campaignDir, 'bin', 'gauntlet'),
    // The wrapper bytes are compared exactly by the completion contract;
    // the path is single-quoted exactly as instrument-snapshot's shellQuote
    // emits it.
    `#!/bin/sh\nexec bun '${join(campaignDir, 'gauntlet', 'src', 'index.ts')}' "$@"\n`,
  );
  chmodSync(join(campaignDir, 'bin', 'gauntlet'), 0o755);
  writeFileSync(join(campaignDir, '.quorum-snapshot-ok'), '');
  return template.refs;
}
