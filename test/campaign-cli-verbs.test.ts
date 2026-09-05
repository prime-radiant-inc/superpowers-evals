// test/campaign-cli-verbs.test.ts — the promised C1 bodies for the
// `quorum campaign register | run | cancel` verb wiring, plus the C12 pins:
// (a) `campaign run` has NO options in v1 (the spec's CLI option/default
//     table row "— (none in v1)"), so the three draft flags must be rejected;
// (b) checkout discovery is NON-CLI: evals = the running checkout,
//     gauntlet = $GAUNTLET_ROOT, superpowers = $SUPERPOWERS_ROOT — the
//     environment seams the repo already owns, fail-closed when unset.
// Every test subprocess-launches the real CLI entrypoint (src/cli/index.ts):
// the commander wiring itself is the unit under test, so in-process calls to
// the verb functions would prove nothing. Hermetic — tmp git fixtures, no
// network, no credentials, no live evals.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  canonicalReportBytes,
  digestReportBytes,
  foldDescriptiveReport,
  REPORT_JSON_NAME,
  REPORT_MD_NAME,
  renderReportMd,
} from '../src/campaign/budgeted-report.ts';
import { readSampleEvidence } from '../src/campaign/budgeted-report-evidence.ts';
import {
  electWriter,
  initJournalDb,
  openJournalRead,
} from '../src/campaign/journal.ts';
import {
  campaignCancel,
  campaignRegister,
  campaignRun,
} from '../src/cli/campaign.ts';
import { envSnapshot } from '../src/env.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import {
  CRASHED_PGID,
  campaignDoc,
  publishedCampaign,
  REPORT_BLOCK_1,
  REPORT_RESERVE,
  reportCampaign,
  reportEvents,
  WRITER_IDENTITY,
} from './campaign-recovery-fixtures.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
// Per-file live-spend lock path: the cancel verb reads the holder from
// $QUORUM_LIVE_SPEND_LOCK (unset here means "no holder" -> post-crash path),
// and nothing in this file touches the $HOME default.
const SPEND_LOCK = join(mkdtempSync(join(tmpdir(), 'qlock-')), 'live.lock.d');

function git(dir: string, args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** Register resolves both source checkouts at main (R-REG-8). */
function sourceRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-repo-`));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), `${name} fixture\n`);
  // The snapshot's bun install --frozen-lockfile runs inside EVERY
  // checked-out tree, so the fixture needs a committed lockfile.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `${name}-fixture`, version: '0.0.0' }),
  );
  const install = spawnSync('bun', ['install'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (install.status !== 0)
    throw new Error(`${name} fixture bun install failed: ${install.stderr}`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'fixture']);
  return dir;
}

const GAUNTLET_ROOT = sourceRepo('gauntlet');
const SUPERPOWERS_ROOT = sourceRepo('superpowers');

/** The estimates artifact (the task-5d fixture shape, inside staleness). */
function writeEstimates(dir: string): string {
  const path = join(dir, 'estimates-v1.json');
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 'quorum.estimates/v1',
      generated_at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      corpus: {
        sources: ['s'],
        run_count: 10,
        duplicates_excluded: 0,
        excluded: [],
        digest: 'd',
      },
      entries: [
        {
          scenario: 'scn-a',
          agent: 'claude',
          credential: 'cred_a',
          os: 'linux',
          duration_s_median: 600,
          duration_n: 9,
          cost_subject_usd_median: 1,
          cost_grader_usd_median: 0.5,
          cost_total_usd_median: 1.5,
          priced_n: 9,
          spread_s: { p25: 500, p75: 700 },
          confidence: 'high',
        },
      ],
      fallbacks: {
        scenario_agent: [],
        scenario: [],
        corpus_median: { duration_s: 600, cost_total_usd: 1.5 },
      },
    }),
  );
  return path;
}

/** The suite document (task-5d shape): grader block + one comparison. */
function writeSuite(dir: string, baseline = 'arm_a'): string {
  const path = join(dir, 'testsuite.yaml');
  writeFileSync(
    path,
    [
      'schema_version: 1',
      'name: testsuite',
      'kind: exploratory',
      'budget_usd: 100',
      'grader: { credential: cred_a, model: grader-model }',
      'comparisons:',
      `  - baseline: ${baseline}`,
      '    treatment: arm_b',
      '    scenarios: [scn-a]',
      '    n: 1',
      '',
    ].join('\n'),
  );
  return path;
}

type EnvOverrides = Record<string, string | undefined>;
function cliEnv(overrides: EnvOverrides = {}): Record<string, string> {
  const env: Record<string, string | undefined> = { ...envSnapshot() };
  env['QUORUM_LIVE_SPEND_LOCK'] = SPEND_LOCK;
  env['GAUNTLET_ROOT'] = GAUNTLET_ROOT;
  env['SUPERPOWERS_ROOT'] = SUPERPOWERS_ROOT;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env as Record<string, string>;
}

function runCli(
  args: string[],
  opts: { cwd?: string; env?: EnvOverrides } = {},
): { status: number; stdout: string; stderr: string } {
  const p = spawnSync('bun', ['--no-env-file', CLI, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: cliEnv(opts.env),
  });
  return { status: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
}

const REPORT_RESULTS_ROOT = resolve(import.meta.dir, '..', 'results');

interface ReportCliFixture {
  readonly dir: string;
  readonly runDirs: readonly string[];
  readonly jsonBytes: Buffer;
  readonly md: string;
}

function writeReportRun(
  runDir: string,
  runId: string,
  outcome: 'pass' | 'fail',
  model: 'model-a' | 'model-b',
): void {
  mkdirSync(join(runDir, 'gauntlet-agent', 'results', runId), {
    recursive: true,
  });
  writeFileSync(
    join(runDir, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final: outcome,
      final_reason: 'fixture verdict',
      gauntlet: {
        status: outcome,
        summary: 's',
        reasoning: 'r',
        run_id: runId,
      },
      checks: [],
      error: null,
      economics: {
        coding_agent: { duration_ms: 61_000 },
        gauntlet: { duration_ms: 45_000 },
        total_est_cost_usd: outcome === 'pass' ? 1 : 2,
      },
    }),
  );
  writeFileSync(
    join(runDir, 'trajectory.json'),
    JSON.stringify({
      schema_version: 'ATIF-v1.7',
      agent: { name: 'claude', version: '1.0.34' },
      steps: [
        {
          step_id: 1,
          timestamp: '2026-08-31T10:00:00Z',
          source: 'agent',
          model_name: model,
          message: 'did the work',
        },
      ],
    }),
  );
  writeFileSync(
    join(runDir, 'coding-agent-token-usage.json'),
    JSON.stringify({
      total_input: 40,
      total_cache_create: 0,
      total_cache_read: 0,
      total_output: 60,
      total_tokens: 100,
      model,
      models: {
        [model]: {
          total_input: 40,
          total_cache_create: 0,
          total_cache_read: 0,
          total_output: 60,
          total_tokens: 100,
          provider: 'anthropic',
          est_cost_usd: outcome === 'pass' ? 1 : 2,
        },
      },
      est_cost_usd: outcome === 'pass' ? 1 : 2,
      unpriced_models: [],
      approximations: [],
      pricing_as_of: '2026-08-31',
      duration_ms: 61_000,
    }),
  );
  writeFileSync(
    join(runDir, 'gauntlet-agent', 'results', runId, 'result.json'),
    JSON.stringify({
      schemaVersion: 5,
      runId,
      status: outcome,
      summary: 's',
      reasoning: 'r',
      duration_ms: 45_000,
      config: { model: 'grader-model' },
      usage: {},
    }),
  );
}

function reportFixture(args: { sealed: boolean }): ReportCliFixture {
  mkdirSync(REPORT_RESULTS_ROOT, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'campaign-report-cli-'));
  const doc = reportCampaign();
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(doc));
  initJournalDb(dir);

  const runSpecs = [
    {
      sampleId: 'c1:scn:arm_a:r1',
      attemptId: 'report-a1',
      outcome: 'pass' as const,
      model: 'model-a' as const,
    },
    {
      sampleId: 'c1:scn:arm_b:r1',
      attemptId: 'report-b1',
      outcome: 'fail' as const,
      model: 'model-b' as const,
    },
    {
      sampleId: 'c1:scn:arm_a:r2',
      attemptId: 'report-a2',
      outcome: 'pass' as const,
      model: 'model-a' as const,
    },
    {
      sampleId: 'c1:scn:arm_b:r2',
      attemptId: 'report-b2',
      outcome: 'pass' as const,
      model: 'model-b' as const,
    },
  ];
  const runDirs: string[] = [];
  const steps = runSpecs.map((spec) => {
    const runDir = mkdtempSync(
      join(REPORT_RESULTS_ROOT, 'campaign-report-run-'),
    );
    const runId = basename(runDir);
    runDirs.push(runDir);
    writeReportRun(runDir, runId, spec.outcome, spec.model);
    return {
      kind: 'run' as const,
      run: { ...spec, runId },
    };
  });
  const events = reportEvents({ campaign: doc, steps });
  const writer = electWriter({
    campaignDir: dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: doc,
  });
  try {
    for (const event of events) {
      writer.appendEvent({
        type: event.type,
        payload: event.payload,
        ts_ms: event.ts_ms,
      });
    }
  } finally {
    writer.release();
  }

  const reportReader = openJournalRead(dir);
  let journalEvents: ReturnType<typeof reportEvents>;
  try {
    journalEvents = reportReader.readEvents();
  } finally {
    reportReader.close();
  }
  const report = foldDescriptiveReport({
    campaign: doc,
    events: journalEvents,
    evidenceOf: (runId, sampleId) =>
      readSampleEvidence({
        runDir: join(REPORT_RESULTS_ROOT, runId),
        sampleId,
      }),
  });
  const jsonBytes = canonicalReportBytes(report);
  const md = renderReportMd({ report, campaign: doc });
  if (args.sealed) {
    const sealer = electWriter({
      campaignDir: dir,
      clock: new FakeClock(1),
      identity: WRITER_IDENTITY,
      campaign: doc,
    });
    try {
      sealer.appendEvent({
        type: 'sealed',
        payload: { report_digest: digestReportBytes(jsonBytes) },
      });
    } finally {
      sealer.release();
    }
    writeFileSync(join(dir, REPORT_MD_NAME), md);
    writeFileSync(join(dir, REPORT_JSON_NAME), jsonBytes);
  }
  return { dir, runDirs, jsonBytes, md };
}

function cleanupReportFixture(fixture: ReportCliFixture): void {
  rmSync(fixture.dir, { recursive: true, force: true });
  for (const runDir of fixture.runDirs) {
    rmSync(runDir, { recursive: true, force: true });
  }
}

function unsealedReportFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'campaign-unsealed-cli-'));
  const doc = reportCampaign();
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(doc));
  initJournalDb(dir);
  const events = reportEvents({
    campaign: doc,
    steps: [
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r1',
          attemptId: 'unsealed-a1',
          runId: 'unsealed-a1-run',
          outcome: 'pass',
        },
      },
      {
        kind: 'raw',
        event: {
          type: 'attempt_created',
          payload: {
            sample_id: 'c1:scn:arm_b:r1',
            attempt_id: 'unsealed-b1',
          },
        },
      },
      {
        kind: 'raw',
        event: {
          type: 'run_allocated',
          payload: {
            attempt_id: 'unsealed-b1',
            run_id: 'unsealed-b1-run',
            pgid: CRASHED_PGID,
            key_grants: [],
          },
        },
      },
    ],
  });
  const writer = electWriter({
    campaignDir: dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: doc,
  });
  try {
    for (const event of events) {
      writer.appendEvent({
        type: event.type,
        payload: event.payload,
        ts_ms: event.ts_ms,
      });
    }
  } finally {
    writer.release();
  }
  return dir;
}

function unsealedReplacementReportFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'campaign-replacement-cli-'));
  const doc = reportCampaign();
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(doc));
  initJournalDb(dir);
  const events = reportEvents({
    campaign: doc,
    steps: [
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r1',
          attemptId: 'replacement-a1',
          runId: 'replacement-a1-run',
          outcome: 'instrument_failure',
        },
      },
      {
        kind: 'raw',
        event: {
          type: 'block_replaced',
          payload: {
            block_id: REPORT_BLOCK_1,
            replacement_block_id: REPORT_RESERVE,
            reason: 'grader_crashed',
            kind: 'replacement',
            reserve_activation: true,
            roster: [
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
            ],
          },
        },
      },
      {
        kind: 'raw',
        event: {
          type: 'sample_disposition',
          payload: {
            sample_id: 'c1:scn:arm_b:r1',
            disposition: 'excluded_block_replaced',
            superseded_by: 'c1:scn:arm_b:x1',
          },
        },
      },
      {
        kind: 'raw',
        event: {
          type: 'block_admitted',
          payload: { block_id: REPORT_RESERVE, pools: ['p'] },
        },
      },
    ],
  });
  const writer = electWriter({
    campaignDir: dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: doc,
  });
  try {
    for (const event of events) {
      writer.appendEvent({
        type: event.type,
        payload: event.payload,
        ts_ms: event.ts_ms,
      });
    }
  } finally {
    writer.release();
  }
  return dir;
}

test('report on unsealed campaign prints the blocking samples and exits 1', () => {
  const dir = unsealedReportFixture();
  try {
    const result = runCli(['campaign', 'report', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('attempt unsealed-b1');
    expect(result.stderr).toContain('kill_pgid_rerun_block');
    expect(result.stderr).toContain('c1:scn:arm_b:r1');
    expect(result.stderr).toContain('samples lacking terminals');
    expect(result.stderr).toContain('seal first via `quorum campaign run`');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('report on sealed campaign regenerates digest-equal and prints the md', () => {
  const fixture = reportFixture({ sealed: true });
  try {
    const result = runCli(['campaign', 'report', fixture.dir]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(fixture.md);
    expect(
      readFileSync(join(fixture.dir, REPORT_JSON_NAME)).toString('hex'),
    ).toBe(fixture.jsonBytes.toString('hex'));
    expect(readFileSync(join(fixture.dir, REPORT_MD_NAME), 'utf8')).toBe(
      fixture.md,
    );
  } finally {
    cleanupReportFixture(fixture);
  }
}, 30_000);

test('report on a complete but unsealed campaign gives seal-first guidance', () => {
  const fixture = reportFixture({ sealed: false });
  try {
    const result = runCli(['campaign', 'report', fixture.dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('campaign is complete but unsealed');
    expect(result.stderr).not.toContain('seal predicate is not satisfied');
    expect(result.stderr).toContain('seal first via `quorum campaign run`');
  } finally {
    cleanupReportFixture(fixture);
  }
}, 30_000);

test('report republishes missing artifacts', () => {
  const fixture = reportFixture({ sealed: true });
  try {
    rmSync(join(fixture.dir, REPORT_MD_NAME));
    rmSync(join(fixture.dir, REPORT_JSON_NAME));
    const result = runCli(['campaign', 'report', fixture.dir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(fixture.md);
    expect(
      readFileSync(join(fixture.dir, REPORT_JSON_NAME)).toString('hex'),
    ).toBe(fixture.jsonBytes.toString('hex'));
    expect(readFileSync(join(fixture.dir, REPORT_MD_NAME), 'utf8')).toBe(
      fixture.md,
    );
  } finally {
    cleanupReportFixture(fixture);
  }
}, 30_000);

test('report refuses a tampered present artifact before partial-artifact publication', () => {
  const fixture = reportFixture({ sealed: true });
  const jsonPath = join(fixture.dir, REPORT_JSON_NAME);
  const mdPath = join(fixture.dir, REPORT_MD_NAME);
  const tamperedJson = Buffer.concat([
    readFileSync(jsonPath),
    Buffer.from('tampered'),
  ]);
  try {
    rmSync(mdPath);
    writeFileSync(jsonPath, tamperedJson);

    const result = runCli(['campaign', 'report', fixture.dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('evidence tampering');
    expect(result.stderr).toContain(REPORT_JSON_NAME);
    expect(existsSync(mdPath)).toBe(false);
    expect(readFileSync(jsonPath).toString('hex')).toBe(
      tamperedJson.toString('hex'),
    );
  } finally {
    cleanupReportFixture(fixture);
  }
}, 30_000);

test('report on a tampered run dir exits 1 naming the divergence, never overwriting', () => {
  const fixture = reportFixture({ sealed: true });
  const beforeJson = readFileSync(join(fixture.dir, REPORT_JSON_NAME));
  const beforeMd = readFileSync(join(fixture.dir, REPORT_MD_NAME), 'utf8');
  try {
    const trajectoryPath = join(fixture.runDirs[0]!, 'trajectory.json');
    const trajectory = JSON.parse(readFileSync(trajectoryPath, 'utf8')) as {
      steps: Array<Record<string, unknown>>;
    };
    trajectory.steps[0]!['model_name'] = 'tampered-model';
    writeFileSync(trajectoryPath, JSON.stringify(trajectory));

    const result = runCli(['campaign', 'report', fixture.dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('evidence tampering');
    expect(result.stderr).toContain('journaled report_digest');
    expect(
      readFileSync(join(fixture.dir, REPORT_JSON_NAME)).toString('hex'),
    ).toBe(beforeJson.toString('hex'));
    expect(readFileSync(join(fixture.dir, REPORT_MD_NAME), 'utf8')).toBe(
      beforeMd,
    );
  } finally {
    cleanupReportFixture(fixture);
  }
}, 30_000);

test('report lists active replacement-roster samples, not an inactive reserve', () => {
  const dir = unsealedReplacementReportFixture();
  try {
    const result = runCli(['campaign', 'report', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('samples lacking terminals');
    expect(result.stderr).toContain('c1:scn:arm_a:x1');
    expect(result.stderr).toContain('c1:scn:arm_b:x1');
    expect(result.stderr).not.toContain('c1:scn:arm_a:r1');
    expect(result.stderr).not.toContain('c1:scn:arm_b:r1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('report on a gating campaign refuses with the D4b message', () => {
  const fixture = publishedCampaign({ inFlight: false, doc: campaignDoc() });
  try {
    const result = runCli(['campaign', 'report', fixture.dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'sealing/reporting gating campaigns awaits D4b',
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}, 30_000);

// ── register ───────────────────────────────────────────────────────────────

test('campaign register resolves gauntlet from $GAUNTLET_ROOT, refusing loudly when unset (C12b)', () => {
  const work = mkdtempSync(join(tmpdir(), 'reg-'));
  const res = runCli(
    [
      'campaign',
      'register',
      writeSuite(work),
      '--estimates',
      writeEstimates(work),
    ],
    { env: { GAUNTLET_ROOT: undefined } },
  );
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('GAUNTLET_ROOT');
}, 30_000);

test('campaign register resolves superpowers from $SUPERPOWERS_ROOT, refusing loudly when unset (C12b)', () => {
  const work = mkdtempSync(join(tmpdir(), 'reg-'));
  // A caller-owned dotenv file must not be able to repopulate an environment
  // variable this subprocess intentionally removed.
  writeFileSync(join(work, '.env'), `SUPERPOWERS_ROOT=${SUPERPOWERS_ROOT}\n`);
  const res = runCli(
    [
      'campaign',
      'register',
      writeSuite(work),
      '--estimates',
      writeEstimates(work),
    ],
    { cwd: work, env: { SUPERPOWERS_ROOT: undefined } },
  );
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('SUPERPOWERS_ROOT');
}, 30_000);

test("campaign register's --estimates default is estimates/v1.json (pinned table)", () => {
  // cwd holds the suite but NOT estimates/v1.json: the default path itself
  // must be the thing that refuses, naming the path.
  const work = mkdtempSync(join(tmpdir(), 'reg-'));
  const suite = writeSuite(work);
  const res = runCli(['campaign', 'register', suite], { cwd: work });
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('estimates/v1.json');
}, 30_000);

test('campaign register excludes a cell whose arm is absent from frozen intake', () => {
  // A passing host probe and isolated committed intake reach R-REG-2 on
  // every platform, without depending on the operator checkout's arm refs.
  const work = mkdtempSync(join(tmpdir(), 'reg-'));
  const res = registerCli([
    'campaign',
    'register',
    writeSuite(work, 'missing_arm'),
    '--estimates',
    writeEstimates(work),
  ]);
  expect(res.status).toBe(0);
  expect(res.stderr).toBe('');
  expect(res.stdout).toContain('arm missing_arm not in arms/ intake');
  expect(res.stdout).toContain('grid: 0 cells, 0 samples, 0 blocks');
  expect(existsSync(join(EVALS_CHECKOUT, 'campaigns'))).toBe(false);
}, 60_000);

// ── run ────────────────────────────────────────────────────────────────────

test('campaign run rejects the three C12-forbidden options (pinned: none in v1)', () => {
  for (const flag of [
    '--evals-checkout',
    '--gauntlet-checkout',
    '--superpowers-checkout',
  ]) {
    const res = runCli([
      'campaign',
      'run',
      '/tmp/does-not-matter',
      flag,
      '/tmp/x',
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`unknown option '${flag}'`);
  }
}, 30_000);

test('campaign run refuses a nonexistent campaign directory loudly', () => {
  const res = runCli(['campaign', 'run', '/tmp/quorum-no-such-campaign-xyz']);
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('campaign');
}, 30_000);

// ── cancel + the R-RCV-7 refuse-to-resume precedence ───────────────────────

/** A published campaign dir plus the snapshot-tree credentials the run verb
 * parses before resume (grader_cred is the fixture document's grader). */
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

function journalTypes(dir: string): { types: string[]; last: unknown } {
  const reader = openJournalRead(dir);
  try {
    const events = reader.readEvents();
    return { types: events.map((e) => e.type), last: events.at(-1)?.payload };
  } finally {
    reader.close();
  }
}

test('campaign cancel journals campaign_cancelled LAST with --reason; a later campaign run refuses to resume, citing the cancel-request (R-RCV-7)', () => {
  const dir = campaignFixture();
  const cancel = runCli([
    'campaign',
    'cancel',
    dir,
    '--reason',
    'operator halt',
  ]);
  expect(cancel.status).toBe(0);
  expect(cancel.stdout).toContain('campaign cancelled');
  // Marker first, campaign_cancelled LAST (Decision D-12), reason carried.
  expect(existsSync(join(dir, 'cancel-request'))).toBe(true);
  const markerLine2 = readFileSync(join(dir, 'cancel-request'), 'utf8').split(
    '\n',
  )[1];
  expect(markerLine2).toBe('operator halt');
  const { types, last } = journalTypes(dir);
  expect(types).toEqual(['campaign_opened', 'campaign_cancelled']);
  expect(last).toEqual({ reason: 'operator halt' });

  // The resume verb checks cancel-request FIRST: it completes the
  // cancellation instead of resuming (idempotent — already terminal).
  const run = runCli(['campaign', 'run', dir]);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain(
    'cancel-request present — completing cancellation instead of resuming',
  );
  expect(run.stdout).toContain('campaign run finished: cancelled');
}, 60_000);

test('campaign run completes an already-requested cancellation even when every other prerequisite is missing (R-RCV-7 FIRST)', () => {
  // The pin: cancel-request is checked before ANYTHING else. A missing
  // $GAUNTLET_ROOT or a damaged snapshot-credentials file must never block
  // completing a cancellation the operator already requested.
  const dir = campaignFixture();
  writeFileSync(join(dir, 'cancel-request'), `${Date.now()}\noperator halt\n`);
  // Damage the credentials file too — still must not matter.
  writeFileSync(join(dir, 'evals', 'credentials.yaml'), '{ not: yaml');
  const res = runCli(['campaign', 'run', dir], {
    env: { GAUNTLET_ROOT: undefined, SUPERPOWERS_ROOT: undefined },
  });
  expect(res.status).toBe(0);
  expect(res.stdout).toContain(
    'cancel-request present — completing cancellation instead of resuming',
  );
  expect(res.stdout).toContain('campaign run finished: cancelled');
  const { types } = journalTypes(dir);
  expect(types).toEqual(['campaign_opened', 'campaign_cancelled']);
}, 60_000);

// ── register success paths (C1; every earlier register test ended in exit 1)
// ────────────────────────────────────────────────────────────────────────────

const WORKTREE = resolve(import.meta.dir, '..');
const CHILD_CONTRACT_SHA = 'f230698e5bb653371bee73d6e3212d6c2e241368';
const HOST_STATS_FIXTURE = resolve(
  import.meta.dir,
  'fixtures',
  'host-stats.json',
);

/** A real clone of THIS worktree's committed state: the register verb runs
 * from the clone, so repoRoot() — the evals checkout the verb freezes and
 * intakes — is the clone (the real checkout stays untouched). The clone
 * additionally carries the campaign inputs the fixture suite references
 * (arms/, scenarios/scn-a, fixture credentials). */
function evalsCheckout(): string {
  const holder = mkdtempSync(join(tmpdir(), 'evals-cli-'));
  const dir = join(holder, 'repo');
  const clone = spawnSync(
    'git',
    ['-c', 'advice.detachedHead=false', 'clone', '-q', WORKTREE, dir],
    { encoding: 'utf8' },
  );
  if (clone.status !== 0) throw new Error(clone.stderr);
  symlinkSync(join(WORKTREE, 'node_modules'), join(dir, 'node_modules'));
  // Hermetic campaign intake: the clone may carry repo-level arms/suites
  // documents; the frozen intake this fixture registers against must contain
  // exactly the fixture arms written below.
  rmSync(join(dir, 'arms'), { recursive: true, force: true });
  rmSync(join(dir, 'suites'), { recursive: true, force: true });
  const gitOpts = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  const g = (args: string[]): string => {
    const r = spawnSync('git', ['-C', dir, ...gitOpts, ...args], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  writeFileSync(
    join(dir, 'credentials.yaml'),
    [
      'cred_a:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_KEY_A',
      'cred_b:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_KEY_B',
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
  g(['add', '-A']);
  g(['commit', '-qm', 'campaign CLI fixtures']);
  return dir;
}

const EVALS_CHECKOUT = evalsCheckout();

/** The child-contract seam: a `git` PATH shim answering exactly the pinned
 * merge-base --is-ancestor question (the commit exists in no reachable
 * store) and delegating everything else to the real git. */
const GIT_SHIM_DIR = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'git-shim-'));
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh
# Test seam (registration child-contract probe): answer the one
# merge-base --is-ancestor question for D2's pinned implementation merge,
# which exists in no reachable object store; delegate all else to real git.
if [ "$1" = "-C" ] && [ "$3" = "merge-base" ] && [ "$4" = "--is-ancestor" ] \
   && [ "$5" = "${CHILD_CONTRACT_SHA}" ]; then
  exit 0
fi
exec /usr/bin/git "$@"
`,
    { mode: 0o755 },
  );
  return dir;
})();

/** Register invocations run from the clone (cwd inside it so the relative
 * --estimates default and campaigns/ root land there) with the passing
 * host-stats fixture injected through the seam. */
function registerCli(
  args: string[],
  opts: { env?: EnvOverrides } = {},
): { status: number; stdout: string; stderr: string } {
  const p = spawnSync(
    'bun',
    [join(EVALS_CHECKOUT, 'src', 'cli', 'index.ts'), ...args],
    {
      encoding: 'utf8',
      cwd: EVALS_CHECKOUT,
      env: {
        ...cliEnv({
          GAUNTLET_ROOT,
          SUPERPOWERS_ROOT,
          QUORUM_HOST_STATS_PROBE_FIXTURE: HOST_STATS_FIXTURE,
          TEST_KEY_A: 'fixture-key-a',
          TEST_KEY_B: 'fixture-key-b',
        }),
        ...opts.env,
      },
    },
  );
  return { status: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
}

function fixtureSuite(): string {
  return writeSuite(EVALS_CHECKOUT);
}

function fixtureEstimates(): string {
  return writeEstimates(EVALS_CHECKOUT);
}

test('register without --confirm prints grid + digest + cap and exits 0, never writing (print-and-exit)', () => {
  const res = registerCli([
    'campaign',
    'register',
    fixtureSuite(),
    '--estimates',
    fixtureEstimates(),
  ]);
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  expect(res.stdout).toMatch(/digest: [0-9a-f]{64}/);
  expect(res.stdout).toContain('grid: 1 cells');
  expect(res.stdout).toContain('global_run_cap = 8 per-sample slots');
  expect(existsSync(join(EVALS_CHECKOUT, 'campaigns'))).toBe(false);
}, 120_000);

test('register --dry-run computes the same grid + digest and never publishes', () => {
  const res = registerCli([
    'campaign',
    'register',
    fixtureSuite(),
    '--estimates',
    fixtureEstimates(),
    '--dry-run',
  ]);
  expect(res.status).toBe(0);
  expect(res.stdout).toMatch(/digest: [0-9a-f]{64}/);
  expect(existsSync(join(EVALS_CHECKOUT, 'campaigns'))).toBe(false);
}, 120_000);

test('register --global-cap forwards the flag into the frozen cap reading', () => {
  const res = registerCli([
    'campaign',
    'register',
    fixtureSuite(),
    '--estimates',
    fixtureEstimates(),
    '--global-cap',
    '4',
  ]);
  expect(res.status).toBe(0);
  expect(res.stdout).toContain('global_run_cap = 4 per-sample slots');
  expect(res.stdout).toContain('max contemporaneous two-arm blocks = 2');
}, 120_000);

test('register: the operator supplies pricing overrides through a file — the grader attestation lands (C3 operator path)', () => {
  // Without an override the exploratory registration caveats the grader as
  // unattested; a GATING registration refuses outright on the same
  // predicate, so this file is the only operator-reachable path to a
  // registrable gating campaign (R-REG-3 / R-REG-11: the declared per-token
  // override is the only escape).
  const bare = registerCli([
    'campaign',
    'register',
    fixtureSuite(),
    '--estimates',
    fixtureEstimates(),
  ]);
  expect(bare.status).toBe(0);
  expect(bare.stdout).toContain('unattested');

  const overridesPath = join(EVALS_CHECKOUT, 'pricing-overrides.json');
  writeFileSync(
    overridesPath,
    JSON.stringify([
      {
        applies_to_grader: true,
        per_token_usd: 0.000002,
        rationale: 'operator attestation: grader priced per-token',
      },
    ]),
  );
  const attested = registerCli([
    'campaign',
    'register',
    fixtureSuite(),
    '--estimates',
    fixtureEstimates(),
    '--pricing-overrides',
    overridesPath,
  ]);
  expect(attested.stderr).toBe('');
  expect(attested.status).toBe(0);
  expect(attested.stdout).not.toContain('unattested');
}, 240_000);

test('register: a pricing-overrides file that is not a valid override list refuses loudly (fail-closed)', () => {
  const badPath = join(EVALS_CHECKOUT, 'bad-overrides.json');
  // Targets BOTH arm and applies_to_grader — the schema pins exactly one.
  writeFileSync(
    badPath,
    JSON.stringify([
      {
        arm: 'arm_a',
        applies_to_grader: true,
        per_token_usd: 0.000002,
        rationale: 'ambiguous target',
      },
    ]),
  );
  const res = registerCli([
    'campaign',
    'register',
    fixtureSuite(),
    '--estimates',
    fixtureEstimates(),
    '--pricing-overrides',
    badPath,
  ]);
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('pricing override');
  expect(res.stdout).not.toMatch(/digest: [0-9a-f]{64}/);

  const missing = registerCli([
    'campaign',
    'register',
    fixtureSuite(),
    '--estimates',
    fixtureEstimates(),
    '--pricing-overrides',
    join(EVALS_CHECKOUT, 'no-such-overrides.json'),
  ]);
  expect(missing.status).toBe(1);
}, 240_000);

test('register --confirm publishes: campaign.json + journal + snapshot, digest printed, exit 0', () => {
  // The child-contract probe's prerequisites come through the seams: D2's
  // pinned implementation-merge commit exists in no reachable object store
  // (cat-file misses locally AND on origin), so the fixture PATH carries a
  // git shim that answers exactly that merge-base --is-ancestor question
  // and delegates everything else to the real git — the same PATH-shim
  // mechanism the mock-gauntlet harness uses. Everything else is real:
  // worktree materialization, bun installs, publication order.
  const res = registerCli(
    [
      'campaign',
      'register',
      fixtureSuite(),
      '--estimates',
      fixtureEstimates(),
      '--confirm',
    ],
    { env: { PATH: `${GIT_SHIM_DIR}:${envSnapshot()['PATH'] ?? ''}` } },
  );
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  const digest = /[0-9a-f]{64}/.exec(
    /digest: ([0-9a-f]{64})/.exec(res.stdout)?.[1] ?? '',
  )?.[0];
  expect(digest).toBeDefined();
  const campaigns = join(EVALS_CHECKOUT, 'campaigns');
  const dir = readdirSync(campaigns)
    .filter((d) => d.endsWith('-testsuite'))
    .map((d) => join(campaigns, d))[0];
  expect(dir).toBeDefined();
  expect(basename(dir!)).toBe(`${digest!.slice(0, 8)}-testsuite`);
  for (const f of [
    'campaign.json',
    'journal.db',
    '.quorum-snapshot-ok',
    'evals/credentials.yaml',
    'gauntlet/README.md',
  ]) {
    expect(existsSync(join(dir!, f))).toBe(true);
  }
  const doc: { digest?: string; contention?: { global_run_cap?: number } } =
    JSON.parse(readFileSync(join(dir!, 'campaign.json'), 'utf8')) as {
      digest?: string;
      contention?: { global_run_cap?: number };
    };
  expect(doc.digest).toBe(digest);
  expect(doc.contention?.global_run_cap).toBe(8);
}, 300_000);

test('the campaign-dir argument is canonicalized at the CLI boundary — a relative path never reaches the engine', async () => {
  // The engine hands the campaign dir to detached children that run with a
  // DIFFERENT working directory, so a relative argument would name a
  // different directory there. Canonicalizing at the boundary is also what
  // lets the operator-facing refusal name the directory actually checked.
  const captured: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    expect(await campaignRun('quorum-no-such-campaign-rel')).toBe(1);
    expect(await campaignCancel('quorum-no-such-campaign-rel', {})).toBe(1);
  } finally {
    process.stderr.write = realWrite;
  }
  const absolute = resolve('quorum-no-such-campaign-rel');
  expect(captured.join('')).toBe(
    `error: campaign directory does not exist: ${absolute}\n`.repeat(2),
  );
}, 30_000);

test('the D3 verbs resolve exit codes in-process (only the Commander action exits)', async () => {
  // C8 boundary: a fail-closed verb error must RETURN a code, never
  // process.exit inside the helper — an in-process caller (this test) would
  // otherwise die with it.
  expect(await campaignRun('/tmp/quorum-no-such-campaign-xyz')).toBe(1);
  expect(await campaignCancel('/tmp/quorum-no-such-campaign-xyz', {})).toBe(1);
  expect(
    campaignRegister('/tmp/no-such-suite.yaml', {
      estimates: '/tmp/no-such-estimates.json',
      globalCap: '8',
    }),
  ).toBe(1);
}, 30_000);
