import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
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
import { importJobRequest } from './appliance-job-fixtures.ts';

function loaded(): LoadedApplianceConfig {
  // Canonical (realpath) fixture root: the appliance boundary validates
  // every absolute path component no-follow, and macOS tmpdir paths
  // traverse the /var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-prune-')));
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

// Full recursive fingerprint of a dir — names, entry types, modes, sizes,
// mtimes, and file bytes. Two equal snapshots prove zero byte or metadata
// change.
function snapshotTree(dir: string): string {
  const lines: string[] = [];
  const record = (path: string, rel: string): void => {
    const stats = lstatSync(path);
    const kind = stats.isSymbolicLink()
      ? 'link'
      : stats.isDirectory()
        ? 'dir'
        : 'file';
    const hash =
      kind === 'file' ? Bun.SHA256.hash(readFileSync(path), 'hex') : '';
    lines.push(
      `${rel}|${kind}|${(stats.mode & 0o777).toString(8)}|${stats.size}|${stats.mtimeMs}|${hash}`,
    );
    if (kind === 'dir') {
      for (const entry of readdirSync(path).sort()) {
        record(join(path, entry), `${rel}/${entry}`);
      }
    }
  };
  record(dir, '.');
  return lines.join('\n');
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
  const job = createJob(
    cfg,
    importJobRequest({ superpowersRef: 'x', argv: ['test'] }),
  );
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

// --- The state namespace is a no-follow boundary: a symlinked root must
// --- never hide references or redirect the quarantine move.

test('a symlinked state/jobs root cannot hide a reference: prune fails closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'referenced-run', { verdict: false, ageDays: 30 });
  // The real record claiming the run:
  const job = createJob(
    cfg,
    importJobRequest({ superpowersRef: 'x', argv: ['test'] }),
  );
  updateJob(cfg, job.job_id, (cur) => ({
    ...cur,
    artifacts: { ...cur.artifacts, run_id: 'referenced-run' },
  }));
  // The namespace name redirected at an empty decoy that hides it:
  const decoy = join(cfg.config.root, 'decoy-jobs');
  mkdirSync(decoy);
  renameSync(cfg.paths.jobs, join(cfg.config.root, 'real-jobs'));
  symlinkSync(decoy, cfg.paths.jobs);

  expectCode(
    () => prune(cfg, { apply: false, olderThanDays: 7 }),
    'config_invalid',
  );
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'referenced-run', 'trajectory.json'))).toBe(
    true,
  );
});

test('an intermediate symlink inside results_root cannot make prune move an outside run', () => {
  const cfg = loaded();
  const root = cfg.config.root;
  // The configured results_root is <root>/evals/results, but <root>/evals is
  // a symlink at an external directory whose results/ holds a run this
  // appliance does not own. The FINAL path component resolves to a real
  // directory only by traversing the intermediate link, so a final-component
  // probe alone would accept it — and apply would pull the external run into
  // this appliance's quarantine.
  const external = join(root, 'external');
  mkdirSync(join(external, 'results'), { recursive: true });
  makeRunDir(join(external, 'results'), 'outside-run', {
    verdict: false,
    ageDays: 30,
  });
  rmSync(join(root, 'evals'), { recursive: true, force: true });
  symlinkSync(external, join(root, 'evals'));
  // Pre-existing appliance state, with state/locks deliberately at the
  // non-private 0o755: a rejection that runs the lock machinery first would
  // chmod it 0o700 (and churn its mtime creating/releasing run.lock) before
  // the typed refusal lands. The full state tree — bytes, modes, mtimes —
  // must be identical after BOTH rejections.
  chmodSync(join(root, 'state/locks'), 0o755);
  const before = snapshotTree(external);
  const stateBefore = snapshotTree(join(root, 'state'));

  expectCode(
    () => prune(cfg, { apply: false, olderThanDays: 7 }),
    'config_invalid',
  );
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  // The external tree — bytes, modes, mtimes — is untouched, nothing was
  // quarantined, and the appliance's own state (locks still 0o755) is
  // exactly as it was: reject-before-lock/mkdir/chmod.
  expect(snapshotTree(external)).toBe(before);
  expect(snapshotTree(join(root, 'state'))).toBe(stateBefore);
  const qroot = join(root, 'state', 'quarantine');
  expect(existsSync(qroot) ? readdirSync(qroot) : []).toEqual([]);
});

test('a symlinked state/quarantine root fails prune apply closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'victim-run', { verdict: true, ageDays: 90 });
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  symlinkSync(
    join(root, 'victim-run'),
    join(cfg.config.root, 'state', 'quarantine'),
  );

  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  // The candidate was not moved into the victim, and the victim is intact:
  expect(existsSync(join(root, 'old-partial', 'trajectory.json'))).toBe(true);
  expect(readFileSync(join(root, 'victim-run', 'verdict.json'), 'utf8')).toBe(
    '{"final":"pass"}',
  );
  expect(existsSync(join(root, 'victim-run', 'trajectory.json'))).toBe(true);
});

// --- Age floor: unsafe values must never erase the eligibility floor ---

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

// --- Campaign scan integrity: symlinks and non-regular entries could hide
// --- references, so they fail the scan closed ---

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

// --- Results root: a symlinked results_root must never move outside dirs ---

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

// --- Stage grammar: exactly the importer's predicate, and references
// --- protect stages too ---

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

// --- Reference scanning: canonical, uniformly strict batch/job state ---

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

test('a batch dir without results.jsonl fails prune closed', () => {
  // Apply's re-plan owns run.lock, so no live batch can be racing its first
  // append — a batch dir with no record file is stale/crashed/ambiguous
  // state, not a batch that has yet to write its first cell.
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  writeBatchHeaderFixture(
    join(root, 'batches', 'b-recordless'),
    'b-recordless',
  );
  expectCode(
    () => prune(cfg, { apply: true, olderThanDays: 7 }),
    'config_invalid',
  );
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('an empty results.jsonl is a valid zero-row record file', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const dir = join(root, 'batches', 'b-empty');
  writeBatchHeaderFixture(dir, 'b-empty');
  writeFileSync(join(dir, 'results.jsonl'), '');
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
  const job = createJob(
    cfg,
    importJobRequest({ superpowersRef: 'x', argv: ['test'] }),
  );
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

// --- Unreadable campaign state proves nothing and must fail typed ---

test('an unreadable nested campaigns/ directory fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const sub = join(cfg.config.evals.path, 'campaigns', 'camp-e', 'sealed');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'note.md'), 'mentions old-partial\n');
  chmodSync(sub, 0o000);
  try {
    expectCode(
      () => prune(cfg, { apply: true, olderThanDays: 7 }),
      'config_invalid',
    );
  } finally {
    chmodSync(sub, 0o700);
  }
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('an unreadable campaigns/ root fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const campaignsRoot = join(cfg.config.evals.path, 'campaigns');
  mkdirSync(campaignsRoot, { recursive: true });
  chmodSync(campaignsRoot, 0o000);
  try {
    expectCode(
      () => prune(cfg, { apply: true, olderThanDays: 7 }),
      'config_invalid',
    );
  } finally {
    chmodSync(campaignsRoot, 0o700);
  }
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

test('an unreadable campaign file fails prune closed', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const camp = join(cfg.config.evals.path, 'campaigns', 'camp-f');
  mkdirSync(camp, { recursive: true });
  const secret = join(camp, 'secret.md');
  writeFileSync(secret, 'mentions old-partial\n');
  chmodSync(secret, 0o000);
  try {
    expectCode(
      () => prune(cfg, { apply: true, olderThanDays: 7 }),
      'config_invalid',
    );
  } finally {
    chmodSync(secret, 0o600);
  }
  expect(existsSync(join(root, 'old-partial'))).toBe(true);
});

// --- Near-miss stage names are ordinary run dirs, never stale stages ---

test('near-miss stage names with unsafe run ids or non-canonical pids keep verdict protection', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  // `..` run id (import's validateBundle rejects it), pid 0, leading-zero
  // pid: none of these can be a name import created, so each is an ordinary
  // (here: completed) run dir.
  const nearMisses = [
    '.importing-a..b.123.tmp',
    '.importing-run-9.0.tmp',
    '.importing-run-9.0123.tmp',
  ];
  for (const name of nearMisses) {
    makeRunDir(root, name, { verdict: true, ageDays: 30 });
  }
  const result = prune(cfg, { apply: true, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.quarantined).toHaveLength(0);
  for (const name of nearMisses) {
    expect(existsSync(join(root, name, 'verdict.json'))).toBe(true);
  }
});

test('incomplete near-miss stage names classify as incomplete and honor references', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, '.importing-a..b.123.tmp', { verdict: false, ageDays: 30 });
  makeRunDir(root, '.importing-run-9.0.tmp', { verdict: false, ageDays: 30 });
  makeRunDir(root, '.importing-run-9.0123.tmp', {
    verdict: false,
    ageDays: 30,
  });
  // A referenced near-miss is protected like any ordinary run dir.
  makeBatch(root, 'b1', ['.importing-run-9.0.tmp']);
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(new Set(result.candidates.map((c) => c.name))).toEqual(
    new Set(['.importing-a..b.123.tmp', '.importing-run-9.0123.tmp']),
  );
  for (const candidate of result.candidates) {
    expect(candidate.reason).toBe('incomplete');
  }
});

test('an exact stage name with a dotted run id is still recognized', () => {
  const cfg = loaded();
  makeRunDir(cfg.config.container.results_root, '.importing-run.12.34.tmp', {
    verdict: false,
    ageDays: 10,
  });
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates.map((c) => c.name)).toEqual([
    '.importing-run.12.34.tmp',
  ]);
  expect(result.candidates[0]?.reason).toBe('stale_stage');
});

// Prune is a structural read/quarantine operation: it accepts the state-only
// loaded config, so a broken credential bundle cannot strand it.
test('prune dry-run operates on the structural state config', () => {
  const full = loaded();
  const { bundle: _bundle, ...structural } = full;
  const result = prune(structural, { apply: false, olderThanDays: 7 });
  expect(result.dry_run).toBe(true);
});
