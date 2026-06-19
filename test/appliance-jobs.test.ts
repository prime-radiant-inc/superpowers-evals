import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-jobs-'));
  mkdirSync(join(root, 'state/jobs'), { recursive: true });
  mkdirSync(join(root, 'state/locks'), { recursive: true });
  mkdirSync(join(root, 'state/provenance'), { recursive: true });
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

test('createJob writes a preflighting job with private log paths', () => {
  const cfg = loaded();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'feature/ref',
    argv: ['quorum', 'run-all', '--tier', 'sentinel'],
    requester: { agent: 'codex', thread: null, task: null },
  });

  expect(job.job_id).toMatch(/^job-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  expect(job.status).toBe('preflighting');
  expect(job.request.superpowers_ref).toBe('feature/ref');
  expect(job.refs).toBeNull();
  expect(job.artifacts.stdout_log).toEndWith('/stdout.log');
  expect(job.artifacts.stderr_log).toEndWith('/stderr.log');
  expect(job.artifacts.provenance).toBe(
    join(cfg.paths.provenance, `${job.job_id}.json`),
  );
  expect(existsSync(join(cfg.paths.jobs, job.job_id, 'job.json'))).toBe(true);
  expect(statSync(join(cfg.paths.jobs, job.job_id)).mode & 0o777).toBe(0o700);
  expect(
    statSync(join(cfg.paths.jobs, job.job_id, 'job.json')).mode & 0o777,
  ).toBe(0o600);
  expect(readJob(cfg, job.job_id).command.argv).toEqual([
    'quorum',
    'run-all',
    '--tier',
    'sentinel',
  ]);
});

test('updateJob applies atomic patches and preserves immutable ids', () => {
  const cfg = loaded();
  const job = createJob(cfg, {
    kind: 'prepare',
    superpowersRef: 'main',
    argv: ['prepare'],
    requester: { agent: null, thread: null, task: null },
  });

  const updated = updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'done',
    finished_at: '2026-06-18T01:00:00.000Z',
    result: { exit_code: 0, summary: 'preflight ok' },
  }));

  expect(updated.job_id).toBe(job.job_id);
  expect(readJob(cfg, job.job_id).status).toBe('done');
  expect(readJob(cfg, job.job_id).updated_at >= job.updated_at).toBe(true);
  expect(() =>
    updateJob(cfg, job.job_id, (current) => ({
      ...current,
      job_id: 'job-other',
    })),
  ).toThrow(/job_id/);
});
