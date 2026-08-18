import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApplianceError,
  type ApplianceErrorCode,
} from '../src/appliance/errors.ts';
import { createJob, updateJob } from '../src/appliance/jobs.ts';
import { acquireLock } from '../src/appliance/locks.ts';
import { prune } from '../src/appliance/prune.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-prune-'));
  mkdirSync(join(root, 'state/jobs'), { recursive: true });
  mkdirSync(join(root, 'state/locks'), { recursive: true });
  mkdirSync(join(root, 'state/provenance'), { recursive: true });
  mkdirSync(join(root, 'evals/results'), { recursive: true });
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'evals/results'),
      },
    },
    bundle: {
      bundle_id: 'blessed-2026-06-18-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
      note: 'test',
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

function expectCode(fn: () => void, code: ApplianceErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApplianceError);
    expect((error as ApplianceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ApplianceError ${code}`);
}

function makeRunDir(
  root: string,
  name: string,
  opts: { verdict: boolean; ageDays: number },
): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (opts.verdict)
    writeFileSync(join(dir, 'verdict.json'), '{"final":"pass"}');
  writeFileSync(join(dir, 'trajectory.json'), '{}');
  const past = new Date(Date.now() - opts.ageDays * 86_400_000);
  utimesSync(dir, past, past);
}

// Canonical batch.json header (BatchHeaderSchema shape, written at batch
// start by src/run-all/batch-index.ts) — prune requires it per batch dir.
function writeBatchHeaderFixture(dir: string, batchId: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'batch.json'),
    JSON.stringify({
      schema_version: 1,
      id: batchId,
      started_at: '2026-08-01T00:00:00Z',
      finished_at: null,
      coding_agents: ['a'],
      jobs: 1,
    }),
  );
}

function makeBatch(
  resultsRoot: string,
  batchId: string,
  runIds: readonly string[],
): void {
  const dir = join(resultsRoot, 'batches', batchId);
  writeBatchHeaderFixture(dir, batchId);
  const lines = runIds.map(
    (id) =>
      `{"scenario": "s", "coding_agent": "a", "run_id": ${JSON.stringify(id)}}`,
  );
  writeFileSync(join(dir, 'results.jsonl'), `${lines.join('\n')}\n`);
}

test('dry-run reports incomplete unreferenced old dirs and moves nothing', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.dry_run).toBe(true);
  expect(result.candidates.map((c) => c.name)).toEqual(['old-partial']);
  expect(result.candidates[0]?.reason).toBe('incomplete');
  expect(result.reclaimable_bytes).toBeGreaterThan(0);
  expect(existsSync(join(root, 'old-partial'))).toBe(true); // dry-run moves nothing
});

test('completed runs (verdict.json) are never candidates', () => {
  const cfg = loaded();
  makeRunDir(cfg.config.container.results_root, 'done-run', {
    verdict: true,
    ageDays: 90,
  });
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.protected).toBe(1);
});

test('batch-referenced and job-record-referenced incomplete dirs are protected', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'in-batch', { verdict: false, ageDays: 30 });
  makeRunDir(root, 'in-jobs', { verdict: false, ageDays: 30 });
  makeBatch(root, 'b1', ['in-batch']);
  const job = createJob(cfg, {
    kind: 'import',
    superpowersRef: 'x',
    argv: ['test'],
    requester: { agent: null, thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (cur) => ({
    ...cur,
    artifacts: { ...cur.artifacts, run_id: 'in-jobs' },
  }));
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.protected).toBe(2);
});

test('a run mentioned under campaigns/ is protected (fail-closed substring scan)', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'in-campaign', { verdict: false, ageDays: 30 });
  const campaigns = join(cfg.config.evals.path, 'campaigns', 'abc1-some-suite');
  mkdirSync(campaigns, { recursive: true });
  writeFileSync(
    join(campaigns, 'campaign.json'),
    '{"samples": ["in-campaign"]}',
  );
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.protected).toBe(1);
});

test('a run mentioned only in a nested campaign file is still protected', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'in-sealed-report', { verdict: false, ageDays: 30 });
  const reportDir = join(
    cfg.config.evals.path,
    'campaigns',
    'def2-sealed-suite',
    'report',
  );
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, 'samples.md'),
    'Regenerated from run in-sealed-report on 2026-08-06.\n',
  );
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.protected).toBe(1);
});

test('dirs younger than the age floor are protected', () => {
  const cfg = loaded();
  makeRunDir(cfg.config.container.results_root, 'fresh-partial', {
    verdict: false,
    ageDays: 2,
  });
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
});

test('stale import stage dirs are candidates with reason stale_stage', () => {
  const cfg = loaded();
  makeRunDir(cfg.config.container.results_root, '.importing-run-9.123.tmp', {
    verdict: false,
    ageDays: 10,
  });
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates[0]?.reason).toBe('stale_stage');
});

test('apply moves candidates to state/quarantine and reports destinations', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const result = prune(cfg, { apply: true, olderThanDays: 7 });
  expect(result.dry_run).toBe(false);
  expect(result.quarantined).toHaveLength(1);
  expect(result.failures).toHaveLength(0);
  expect(existsSync(join(root, 'old-partial'))).toBe(false);
  expect(
    readFileSync(
      join(result.quarantined[0]?.to as string, 'trajectory.json'),
      'utf8',
    ),
  ).toBe('{}');
  // Apply released run.lock on the way out.
  const held = acquireLock({
    loaded: cfg,
    name: 'run.lock',
    jobId: 'job-after',
    command: 'run-all',
  });
  held.release();
});

test('apply refuses while a live job holds run.lock', () => {
  const cfg = loaded();
  const held = acquireLock({
    loaded: cfg,
    name: 'run.lock',
    jobId: 'job-live',
    command: 'run-all',
  });
  try {
    expectCode(
      () => prune(cfg, { apply: true, olderThanDays: 7 }),
      'lock_busy',
    );
  } finally {
    held.release();
  }
});

test('an unparseable batch results.jsonl line fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const dir = join(root, 'batches', 'b-bad');
  writeBatchHeaderFixture(dir, 'b-bad');
  writeFileSync(join(dir, 'results.jsonl'), 'not json at all\n');
  expectCode(
    () => prune(cfg, { apply: false, olderThanDays: 7 }),
    'config_invalid',
  );
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  // Nothing became eligible, and the failed apply released run.lock.
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
  const held = acquireLock({
    loaded: cfg,
    name: 'run.lock',
    jobId: 'job-after',
    command: 'run-all',
  });
  held.release();
});

test('a batch record without a readable run_id fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, '42', { verdict: false, ageDays: 30 });
  const dir = join(root, 'batches', 'b-typed');
  writeBatchHeaderFixture(dir, 'b-typed');
  writeFileSync(
    join(dir, 'results.jsonl'),
    '{"scenario": "s", "coding_agent": "a", "run_id": 42}\n',
  );
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, '42'))).toBe(true);
});

test('a symlinked entry under batches/ fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const outside = join(cfg.config.root, 'elsewhere');
  makeBatch(outside, 'b-real', []);
  mkdirSync(join(root, 'batches'), { recursive: true });
  symlinkSync(
    join(outside, 'batches', 'b-real'),
    join(root, 'batches', 'b-link'),
  );
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a job directory without job.json fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  mkdirSync(join(cfg.paths.jobs, 'job-empty'), { recursive: true });
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a corrupt job record fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const dir = join(cfg.paths.jobs, 'job-broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), '{"schema_version": 1}');
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('symlinked entries under the results root are never candidates', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  const outside = join(cfg.config.root, 'outside-run');
  makeRunDir(cfg.config.root, 'outside-run', { verdict: false, ageDays: 30 });
  symlinkSync(outside, join(root, 'linked-run'));
  const result = prune(cfg, { apply: true, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.quarantined).toHaveLength(0);
  expect(existsSync(join(outside, 'trajectory.json'))).toBe(true);
});

// --- Critical 1: unsafe age values must never erase the eligibility floor ---

test('non-positive or non-integer age floors fail closed before any mutation', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  for (const days of [0, -1, 1.5, Number.NaN]) {
    expectCode(
      () => prune(cfg, { apply: true, olderThanDays: days }),
      'config_invalid',
    );
  }
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

// --- Critical 2: campaign symlinks / non-regular entries hide references ---

test('a symlinked file under campaigns/ fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const mention = join(cfg.config.root, 'mention.md');
  writeFileSync(mention, 'campaign sample: old-partial\n');
  const camp = join(cfg.config.evals.path, 'campaigns', 'camp-a');
  mkdirSync(camp, { recursive: true });
  symlinkSync(mention, join(camp, 'link.md'));
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a symlinked directory under campaigns/ fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const outsideDir = join(cfg.config.root, 'outside-campaign');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'report.md'), 'mentions old-partial\n');
  const camp = join(cfg.config.evals.path, 'campaigns', 'camp-b');
  mkdirSync(camp, { recursive: true });
  symlinkSync(outsideDir, join(camp, 'sub'));
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a non-regular entry (fifo) under campaigns/ fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const camp = join(cfg.config.evals.path, 'campaigns', 'camp-c');
  mkdirSync(camp, { recursive: true });
  const mkfifo = spawnSync('mkfifo', [join(camp, 'pipe')]);
  expect(mkfifo.status).toBe(0);
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a symlinked campaigns/ root fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const outsideCampaigns = join(cfg.config.root, 'outside-campaigns');
  mkdirSync(outsideCampaigns, { recursive: true });
  writeFileSync(
    join(outsideCampaigns, 'c.json'),
    '{"samples":["old-partial"]}',
  );
  symlinkSync(outsideCampaigns, join(cfg.config.evals.path, 'campaigns'));
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

// --- Critical 3: a symlinked results_root must never move outside dirs ---

test('a symlinked results_root fails closed and moves nothing outside', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  const outside = join(cfg.config.root, 'outside-results');
  mkdirSync(outside, { recursive: true });
  makeRunDir(outside, 'old-partial', { verdict: false, ageDays: 30 });
  rmdirSync(root);
  symlinkSync(outside, root);
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(outside, 'old-partial', 'trajectory.json'))).toBe(
    true,
  );
});

test('a results_root symlinked to a file fails closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  const outsideFile = join(cfg.config.root, 'not-a-dir');
  writeFileSync(outsideFile, 'x');
  rmdirSync(root);
  symlinkSync(outsideFile, root);
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
});

test('a results_root that is a plain file fails closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  rmdirSync(root);
  writeFileSync(root, 'x');
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
});

// --- Important 2: exact stage grammar; references protect stages too ---

test('a completed near-miss .importing dir keeps verdict protection', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  // No `.<pid>.tmp` tail — not a stage slot import would ever create, so it
  // is an ordinary (completed) run dir.
  makeRunDir(root, '.importing-x.tmp', { verdict: true, ageDays: 30 });
  const result = prune(cfg, { apply: true, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.quarantined).toHaveLength(0);
  expect(existsSync(join(root, '.importing-x.tmp', 'verdict.json'))).toBe(true);
});

test('an incomplete near-miss .importing dir classifies as incomplete, not stale_stage', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, '.importing-y.tmp', { verdict: false, ageDays: 30 });
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates.map((c) => c.name)).toEqual(['.importing-y.tmp']);
  expect(result.candidates[0]?.reason).toBe('incomplete');
});

test('a batch-referenced exact stage dir is protected', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, '.importing-run-9.123.tmp', { verdict: false, ageDays: 10 });
  makeBatch(root, 'b1', ['.importing-run-9.123.tmp']);
  const result = prune(cfg, { apply: true, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.quarantined).toHaveLength(0);
  expect(existsSync(join(root, '.importing-run-9.123.tmp'))).toBe(true);
});

test('a campaign-mentioned exact stage dir is protected', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, '.importing-run-9.123.tmp', { verdict: false, ageDays: 10 });
  const camp = join(cfg.config.evals.path, 'campaigns', 'camp-d');
  mkdirSync(camp, { recursive: true });
  writeFileSync(join(camp, 'note.md'), 'stage .importing-run-9.123.tmp held\n');
  const result = prune(cfg, { apply: true, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(existsSync(join(root, '.importing-run-9.123.tmp'))).toBe(true);
});

// --- Important 3: canonical, uniformly strict batch/job scanning ---

test('a batch dir without batch.json fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const dir = join(root, 'batches', 'b-headless');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'results.jsonl'),
    '{"scenario": "s", "coding_agent": "a", "run_id": "old-partial"}\n',
  );
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a non-canonical batch.json fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const dir = join(root, 'batches', 'b-badheader');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'batch.json'), '{"schema_version": 2}');
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a symlinked batch.json fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const outside = join(cfg.config.root, 'real-batch.json');
  writeFileSync(
    outside,
    JSON.stringify({
      schema_version: 1,
      id: 'b-linkjson',
      started_at: '2026-08-01T00:00:00Z',
      finished_at: null,
      coding_agents: ['a'],
      jobs: 1,
    }),
  );
  const dir = join(root, 'batches', 'b-linkjson');
  mkdirSync(dir, { recursive: true });
  symlinkSync(outside, join(dir, 'batch.json'));
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a symlinked results.jsonl fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const outside = join(cfg.config.root, 'real-results.jsonl');
  writeFileSync(
    outside,
    '{"scenario": "s", "coding_agent": "a", "run_id": "old-partial"}\n',
  );
  const dir = join(root, 'batches', 'b-linkrows');
  writeBatchHeaderFixture(dir, 'b-linkrows');
  symlinkSync(outside, join(dir, 'results.jsonl'));
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a results.jsonl row failing the canonical record schema fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const dir = join(root, 'batches', 'b-thin');
  writeBatchHeaderFixture(dir, 'b-thin');
  // Parses as JSON and has a string run_id, but is not a canonical
  // ResultRecord (scenario/coding_agent missing).
  writeFileSync(join(dir, 'results.jsonl'), '{"run_id": "old-partial"}\n');
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a batch dir with batch.json but no results.jsonl yet contributes no refs and no error', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  writeBatchHeaderFixture(join(root, 'batches', 'b-live'), 'b-live');
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates.map((c) => c.name)).toEqual(['old-partial']);
});

test('a stray regular file under batches/ fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  mkdirSync(join(root, 'batches'), { recursive: true });
  writeFileSync(join(root, 'batches', 'stray.txt'), 'x');
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a symlinked batches/ root fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const outside = join(cfg.config.root, 'outside-batches');
  makeBatch(join(cfg.config.root, 'outside-batches-parent'), 'b-x', []);
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, 'batches'));
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a stray regular file under state/jobs fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  writeFileSync(join(cfg.paths.jobs, 'stray.txt'), 'x');
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('a symlinked job.json fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const job = createJob(cfg, {
    kind: 'import',
    superpowersRef: 'x',
    argv: ['test'],
    requester: { agent: null, thread: null, task: null },
  });
  const recordPath = join(cfg.paths.jobs, job.job_id, 'job.json');
  const outside = join(cfg.config.root, 'outside-job.json');
  renameSync(recordPath, outside);
  symlinkSync(outside, recordPath);
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});
