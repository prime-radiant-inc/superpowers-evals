import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApplianceError,
  type ApplianceErrorCode,
} from '../src/appliance/errors.ts';
import {
  createJob,
  readAllJobsStrict,
  readJob,
  readJobById,
  readJobByRunId,
  updateJob,
} from '../src/appliance/jobs.ts';
import type {
  JobRecord,
  LoadedApplianceConfig,
} from '../src/appliance/types.ts';

function loaded(): LoadedApplianceConfig {
  // Canonical (realpath) fixture root: the appliance boundary validates
  // every absolute path component no-follow, and macOS tmpdir paths
  // traverse the /var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-jobs-')));
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

function importJob(cfg: LoadedApplianceConfig) {
  return createJob(cfg, {
    kind: 'import',
    superpowersRef: 'unknown',
    argv: ['evals-appliance', 'import'],
    requester: { agent: null, thread: null, task: null },
  });
}

function claimRun(
  cfg: LoadedApplianceConfig,
  jobId: string,
  runId: string,
): void {
  updateJob(cfg, jobId, (current) => ({
    ...current,
    artifacts: { ...current.artifacts, run_id: runId },
  }));
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

test('readJobByRunId resolves the single job claiming the run_id', () => {
  const cfg = loaded();
  importJob(cfg); // an unrelated job that never claims the run
  const claimant = importJob(cfg);
  claimRun(cfg, claimant.job_id, 'run-under-import');

  expect(readJobByRunId(cfg, 'run-under-import').job_id).toBe(claimant.job_id);
});

test('readJobByRunId never resolves by job id: a run_id equal to an unrelated job id is job_not_found', () => {
  const cfg = loaded();
  // artifacts.run_id stays null, so nothing claims this id as a run — even
  // though a job directory of exactly that name exists.
  const job = importJob(cfg);

  expectCode(() => readJobByRunId(cfg, job.job_id), 'job_not_found');
});

test('readJobByRunId fails closed when two jobs claim one run_id', () => {
  const cfg = loaded();
  const first = importJob(cfg);
  const second = importJob(cfg);
  claimRun(cfg, first.job_id, 'contested-run');
  claimRun(cfg, second.job_id, 'contested-run');

  expectCode(() => readJobByRunId(cfg, 'contested-run'), 'config_invalid');
  try {
    readJobByRunId(cfg, 'contested-run');
  } catch (error) {
    const message = (error as ApplianceError).message;
    expect(message).toContain(first.job_id);
    expect(message).toContain(second.job_id);
  }
});

test('readJobByRunId fails closed on an unreadable job record even when a valid claimant exists', () => {
  const cfg = loaded();
  const claimant = importJob(cfg);
  claimRun(cfg, claimant.job_id, 'target-run');
  // An unreadable sibling record could claim the same run; absence cannot be
  // proven, so resolution must refuse rather than guess.
  const corrupt = importJob(cfg);
  writeFileSync(join(cfg.paths.jobs, corrupt.job_id, 'job.json'), 'not json');

  expectCode(() => readJobByRunId(cfg, 'target-run'), 'config_invalid');
});

test('readJobByRunId fails closed on a job directory with no job.json', () => {
  const cfg = loaded();
  const claimant = importJob(cfg);
  claimRun(cfg, claimant.job_id, 'target-run');
  // A directory whose record is gone may have claimed any run before the
  // record vanished; skipping it would turn corruption into false absence.
  mkdirSync(join(cfg.paths.jobs, 'job-20260818T000000Z-dead'));

  expectCode(() => readJobByRunId(cfg, 'target-run'), 'config_invalid');
});

test('readJobById returns null for an absent directory and the record for a well-formed one', () => {
  const cfg = loaded();
  const job = importJob(cfg);

  expect(readJobById(cfg, 'job-20260818T000000Z-none')).toBeNull();
  expect(readJobById(cfg, job.job_id)?.job_id).toBe(job.job_id);
});

test('readJobById fails closed on a directory missing its job.json or holding a mismatched record', () => {
  const cfg = loaded();
  mkdirSync(join(cfg.paths.jobs, 'job-20260818T000000Z-dead'));
  expectCode(
    () => readJobById(cfg, 'job-20260818T000000Z-dead'),
    'config_invalid',
  );

  const original = importJob(cfg);
  const mismatchDir = join(cfg.paths.jobs, 'job-20260818T000000Z-beef');
  mkdirSync(mismatchDir);
  writeFileSync(
    join(mismatchDir, 'job.json'),
    readFileSync(join(cfg.paths.jobs, original.job_id, 'job.json')),
  );
  expectCode(
    () => readJobById(cfg, 'job-20260818T000000Z-beef'),
    'config_invalid',
  );
});

// A symlinked job-directory entry: link name is a plausible job id and the
// target holds an identity-valid record (job_id equals the LINK name), so
// following it would accept the record while a Dirent scan would skip it.
function plantSymlinkedJobDir(
  cfg: LoadedApplianceConfig,
  linkName: string,
  runId: string | null,
): void {
  const target = join(cfg.config.root, 'detached-job-payload');
  mkdirSync(target, { recursive: true });
  const donor = importJob(cfg);
  const record = JSON.parse(
    readFileSync(join(cfg.paths.jobs, donor.job_id, 'job.json'), 'utf8'),
  ) as JobRecord;
  writeFileSync(
    join(target, 'job.json'),
    JSON.stringify({
      ...record,
      job_id: linkName,
      artifacts: { ...record.artifacts, run_id: runId },
    }),
  );
  symlinkSync(target, join(cfg.paths.jobs, linkName));
}

test('readJobByRunId fails closed on a symlinked job-directory entry instead of skipping it', () => {
  const cfg = loaded();
  plantSymlinkedJobDir(cfg, 'job-20260818T000000Z-link', 'target-run');

  expectCode(() => readJobByRunId(cfg, 'target-run'), 'config_invalid');
});

test('readJobById fails closed on a symlinked job directory instead of following it', () => {
  const cfg = loaded();
  plantSymlinkedJobDir(cfg, 'job-20260818T000000Z-link', null);

  expectCode(
    () => readJobById(cfg, 'job-20260818T000000Z-link'),
    'config_invalid',
  );
});

test('exact lookups fail closed on a record whose provenance path is noncanonical', () => {
  const cfg = loaded();
  const job = importJob(cfg);
  claimRun(cfg, job.job_id, 'target-run');
  // An identity-valid record whose provenance field was redirected: trusting
  // it would let retirement delete whatever the field points at.
  const recordPath = join(cfg.paths.jobs, job.job_id, 'job.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as JobRecord;
  writeFileSync(
    recordPath,
    JSON.stringify({
      ...record,
      artifacts: {
        ...record.artifacts,
        provenance: join(cfg.config.root, 'evals/results/victim/verdict.json'),
      },
    }),
  );

  expectCode(() => readJobByRunId(cfg, 'target-run'), 'config_invalid');
  expectCode(() => readJobById(cfg, job.job_id), 'config_invalid');
});

test('readJobByRunId fails closed on a record whose job_id mismatches its directory name', () => {
  const cfg = loaded();
  const claimant = importJob(cfg);
  claimRun(cfg, claimant.job_id, 'target-run');
  // A schema-valid record filed under the wrong directory would make any
  // updateJob against its job_id write into a DIFFERENT directory.
  const original = importJob(cfg);
  const mismatchDir = join(cfg.paths.jobs, 'job-20260818T000000Z-beef');
  mkdirSync(mismatchDir);
  writeFileSync(
    join(mismatchDir, 'job.json'),
    readFileSync(join(cfg.paths.jobs, original.job_id, 'job.json')),
  );

  expectCode(() => readJobByRunId(cfg, 'target-run'), 'config_invalid');
});

test('a jobs-root enumeration failure is typed config_invalid, never a raw fs error', () => {
  const cfg = loaded();
  importJob(cfg);
  // Platform-independent fault seam: the enumeration itself fails (as EACCES
  // would), scoped to exactly the jobs root. Everything else hits the real
  // fs; the exact original method identity is restored afterwards.
  const realReaddir = fs.readdirSync;
  const spy = spyOn(fs, 'readdirSync').mockImplementation(((
    path: Parameters<typeof fs.readdirSync>[0],
    options?: unknown,
  ) => {
    if (path === cfg.paths.jobs) {
      const err = new Error(
        `EACCES: permission denied, scandir '${cfg.paths.jobs}'`,
      ) as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }
    return realReaddir(path, options as Parameters<typeof fs.readdirSync>[1]);
  }) as typeof fs.readdirSync);
  let caught: unknown;
  try {
    readAllJobsStrict(cfg);
  } catch (error) {
    caught = error;
  } finally {
    spy.mockRestore();
  }
  expect(fs.readdirSync).toBe(realReaddir);
  expect(caught).toBeInstanceOf(ApplianceError);
  const err = caught as ApplianceError;
  expect(err.code).toBe('config_invalid');
  expect(err.step).toBe('job');
  expect(err.message).toContain('EACCES');
});

// Job persistence is part of the structural state boundary: the whole API
// accepts a state-only loaded config carrying no bundle metadata.
test('job lifecycle operates on the structural state config', () => {
  const full = loaded();
  const { bundle: _bundle, ...structural } = full;
  const job = createJob(structural, {
    kind: 'run',
    superpowersRef: 'main',
    argv: ['quorum', 'run'],
    requester: { agent: null, thread: null, task: null },
  });
  expect(readJob(structural, job.job_id).job_id).toBe(job.job_id);
  expect(readJobById(structural, job.job_id)?.job_id).toBe(job.job_id);
});
