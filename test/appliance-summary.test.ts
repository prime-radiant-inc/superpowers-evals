import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplianceError } from '../src/appliance/errors.ts';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';
import {
  costsPayload,
  showPayload,
  statusPayload,
} from '../src/appliance/summary.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-summary-'));
  for (const dir of [
    'state/jobs',
    'state/locks',
    'state/provenance',
    'superpowers-evals/results/batches/batch-1',
    'superpowers-evals/results/run-1',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: {
        path: join(root, 'superpowers-evals'),
        remote: 'origin',
        ref: 'main',
      },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'superpowers-evals/results'),
      },
    },
    bundle: {
      bundle_id: 'blessed-x',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
      note: '',
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

function writeBatch(
  cfg: LoadedApplianceConfig,
  rows: readonly Record<string, unknown>[],
): string {
  const batchDir = join(cfg.config.container.results_root, 'batches/batch-1');
  writeFileSync(
    join(batchDir, 'batch.json'),
    JSON.stringify({
      id: 'batch-1',
      started_at: '2026-06-18T00:00:00Z',
      finished_at: '2026-06-18T00:10:00Z',
      coding_agents: ['codex'],
    }),
  );
  writeFileSync(
    join(batchDir, 'results.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n') +
      (rows.length > 0 ? '\n' : ''),
  );
  return batchDir;
}

function writeVerdict(
  cfg: LoadedApplianceConfig,
  runId: string,
  final: 'pass' | 'fail' | 'indeterminate',
): void {
  mkdirSync(join(cfg.config.container.results_root, runId), {
    recursive: true,
  });
  writeFileSync(
    join(cfg.config.container.results_root, runId, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final,
      final_reason: `${final} reason`,
      gauntlet: null,
      checks: [],
      error: null,
      economics: null,
    }),
  );
}

test('status derives a completed batch summary from artifacts', () => {
  const cfg = loaded();
  writeBatch(cfg, [
    {
      scenario: 'alpha',
      coding_agent: 'codex',
      run_id: 'run-1',
      skipped: null,
    },
  ]);
  writeVerdict(cfg, 'run-1', 'fail');
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'done',
    artifacts: { ...current.artifacts, batch_id: 'batch-1' },
  }));

  const status = statusPayload(cfg, job.job_id);
  expect(status.status).toBe('done');
  expect(status.summary).toEqual({
    pass: 0,
    fail: 1,
    indeterminate: 0,
    unknown: 0,
    skipped: 0,
  });
  expect(status.appliance_failed).toBe(false);
});

test('status prefers terminal batch artifacts over stale nonterminal job status', () => {
  const cfg = loaded();
  writeBatch(cfg, [
    {
      scenario: 'alpha',
      coding_agent: 'codex',
      run_id: 'run-1',
      skipped: null,
    },
  ]);
  writeVerdict(cfg, 'run-1', 'pass');
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'running',
    artifacts: { ...current.artifacts, batch_id: 'batch-1' },
    process: {
      host_pid: 99999999,
      host_pgid: 99999999,
      container_pid: 456,
      container_pgid: 456,
    },
  }));

  const status = statusPayload(cfg, job.job_id);
  expect(status.status).toBe('done');
  expect(status.appliance_failed).toBe(false);
  expect(readJob(cfg, job.job_id).status).toBe('running');
});

test('status reports a nonterminal job as lost when its worker process is gone', () => {
  const cfg = loaded();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'running',
    process: {
      host_pid: 99999999,
      host_pgid: 99999999,
      container_pid: 456,
      container_pgid: 456,
    },
  }));

  const status = statusPayload(cfg, job.job_id);
  expect(status.status).toBe('lost');
  expect(status.appliance_failed).toBe(true);
  expect(readJob(cfg, job.job_id).status).toBe('running');
});

test('status gives a freshly submitted job time to acquire its worker lock', () => {
  const cfg = loaded();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: 'codex', thread: null, task: null },
  });

  const status = statusPayload(cfg, job.job_id);

  expect(status.status).toBe('preflighting');
  expect(status.appliance_failed).toBe(false);
});

test('status reports an old nonterminal job without a worker as lost', () => {
  const cfg = loaded();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  const jobPath = join(cfg.paths.jobs, job.job_id, 'job.json');
  writeFileSync(
    jobPath,
    JSON.stringify({
      ...job,
      updated_at: new Date(Date.now() - 60_000).toISOString(),
    }),
  );

  const status = statusPayload(cfg, job.job_id);

  expect(status.status).toBe('lost');
  expect(status.appliance_failed).toBe(true);
});

test('show and costs do not require credential env', () => {
  const cfg = loaded();
  const batchDir = join(cfg.config.container.results_root, 'batches/batch-1');
  writeFileSync(
    join(batchDir, 'batch.json'),
    JSON.stringify({
      id: 'batch-1',
      started_at: '2026-06-18T00:00:00Z',
      finished_at: null,
      coding_agents: ['codex'],
    }),
  );
  writeFileSync(join(batchDir, 'results.jsonl'), '');
  expect(showPayload(cfg, 'batch-1', false)).toContain('batch batch-1');
  expect(costsPayload(cfg, 'batch-1', true)).toHaveProperty('aggregate');
});

test('status accepts a bare batch id and counts skipped and missing verdict cells', () => {
  const cfg = loaded();
  writeBatch(cfg, [
    {
      scenario: 'alpha',
      coding_agent: 'codex',
      run_id: 'run-1',
      skipped: null,
    },
    {
      scenario: 'beta',
      coding_agent: 'codex',
      run_id: null,
      skipped: 'unsupported_os',
    },
    {
      scenario: 'gamma',
      coding_agent: 'codex',
      run_id: 'missing-run',
      skipped: null,
    },
  ]);
  writeVerdict(cfg, 'run-1', 'pass');

  const status = statusPayload(cfg, 'batch-1');
  expect(status.status).toBe('done');
  expect(status.summary).toEqual({
    pass: 1,
    fail: 0,
    indeterminate: 0,
    unknown: 1,
    skipped: 1,
  });
});

test('status attaches a matching quarantined job for a bare batch id', () => {
  const cfg = loaded();
  writeBatch(cfg, [
    {
      scenario: 'alpha',
      coding_agent: 'codex',
      run_id: 'run-1',
      skipped: null,
    },
  ]);
  writeVerdict(cfg, 'run-1', 'pass');
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'quarantined',
    artifacts: { ...current.artifacts, batch_id: 'batch-1' },
  }));

  const status = statusPayload(cfg, 'batch-1');

  expect(status.status).toBe('quarantined');
  expect(status.appliance_failed).toBe(true);
  expect(status.job?.job_id).toBe(job.job_id);
  expect(status.job?.status).toBe('quarantined');
});

test('status attaches a matching failed job for a bare run id', () => {
  const cfg = loaded();
  writeVerdict(cfg, 'run-1', 'fail');
  const job = createJob(cfg, {
    kind: 'run',
    superpowersRef: 'main',
    argv: ['quorum', 'run', 'alpha', '--coding-agent', 'codex'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'failed',
    artifacts: { ...current.artifacts, run_id: 'run-1' },
  }));

  const status = statusPayload(cfg, 'run-1');

  expect(status.status).toBe('failed');
  expect(status.appliance_failed).toBe(true);
  expect(status.job?.job_id).toBe(job.job_id);
  expect(status.job?.status).toBe('failed');
});

test('show renders a single run from a job artifact', () => {
  const cfg = loaded();
  writeVerdict(cfg, 'run-1', 'pass');
  const job = createJob(cfg, {
    kind: 'run',
    superpowersRef: 'main',
    argv: ['quorum', 'run'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'done',
    artifacts: { ...current.artifacts, run_id: 'run-1' },
  }));

  expect(showPayload(cfg, job.job_id, false)).toContain('final     pass');
  expect(showPayload(cfg, job.job_id, true)).toMatchObject({
    final: 'pass',
    final_reason: 'pass reason',
  });
});

test('show and costs accept exact run artifact ids', () => {
  const cfg = loaded();
  writeVerdict(cfg, 'run-1', 'pass');

  expect(showPayload(cfg, 'run-1', false)).toContain('final     pass');
  expect(costsPayload(cfg, 'run-1', true)).toHaveProperty('aggregate');
});

test('missing artifacts surface appliance artifact_missing errors', () => {
  const cfg = loaded();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'done',
    artifacts: { ...current.artifacts, batch_id: 'batch-missing' },
  }));

  expect(() => statusPayload(cfg, job.job_id)).toThrow(ApplianceError);
  try {
    statusPayload(cfg, job.job_id);
  } catch (error) {
    expect(error).toBeInstanceOf(ApplianceError);
    expect((error as ApplianceError).code).toBe('artifact_missing');
  }
});

test('costs normalizes missing batch files to artifact_missing', () => {
  const cfg = loaded();
  const batchDir = join(cfg.config.container.results_root, 'batches/batch-1');
  writeFileSync(
    join(batchDir, 'batch.json'),
    JSON.stringify({
      id: 'batch-1',
      started_at: '2026-06-18T00:00:00Z',
      finished_at: null,
      coding_agents: ['codex'],
    }),
  );

  expect(() => costsPayload(cfg, 'batch-1', true)).toThrow(ApplianceError);
  try {
    costsPayload(cfg, 'batch-1', true);
  } catch (error) {
    expect(error).toBeInstanceOf(ApplianceError);
    expect((error as ApplianceError).code).toBe('artifact_missing');
  }
});
