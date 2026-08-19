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
import { EMPTY_CREDENTIAL_SCOPE } from '../src/credentials/scope.ts';
import {
  FIXTURE_LIVE_SCOPE,
  FIXTURE_LIVE_SELECTION,
  FIXTURE_SOURCE_EVALS_SHA,
  importJobRequest,
  liveJobRequest,
  prepareJobRequest,
} from './appliance-job-fixtures.ts';

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
  return createJob(cfg, importJobRequest());
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
  const job = createJob(
    cfg,
    liveJobRequest('run-all', {
      superpowersRef: 'feature/ref',
      argv: ['quorum', 'run-all', '--tier', 'sentinel'],
      requester: { agent: 'codex', thread: null, task: null },
    }),
  );

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
  const job = createJob(cfg, prepareJobRequest());

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

// --- initial credential request persistence (F13) ---------------------------
// The triple is part of the FIRST atomic job.json write, not a later patch: a
// crash between creation and preflight must never leave a live job whose
// credential authority is unknown. These read the bytes on disk, not just the
// returned record.

function persistedRecord(
  cfg: LoadedApplianceConfig,
  jobId: string,
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(cfg.paths.jobs, jobId, 'job.json'), 'utf8'),
  ) as Record<string, unknown>;
}

test('createJob persists the live credential triple for run and run-all', () => {
  const cfg = loaded();
  for (const kind of ['run', 'run-all'] as const) {
    const job = createJob(cfg, liveJobRequest(kind));

    expect(job.credential_selection).toEqual(FIXTURE_LIVE_SELECTION);
    expect(job.credential_scope).toEqual(FIXTURE_LIVE_SCOPE);
    expect(job.credential_scope_source_evals_sha).toBe(
      FIXTURE_SOURCE_EVALS_SHA,
    );
    expect(persistedRecord(cfg, job.job_id)).toMatchObject({
      kind,
      credential_selection: FIXTURE_LIVE_SELECTION,
      credential_scope: FIXTURE_LIVE_SCOPE,
      credential_scope_source_evals_sha: FIXTURE_SOURCE_EVALS_SHA,
    });
  }
});

test('createJob persists the asserted empty scope for prepare', () => {
  const cfg = loaded();
  const job = createJob(cfg, prepareJobRequest());

  expect(job.credential_selection).toBe(null);
  expect(job.credential_scope).toEqual(EMPTY_CREDENTIAL_SCOPE);
  expect(job.credential_scope_source_evals_sha).toBe(null);
  expect(persistedRecord(cfg, job.job_id)).toMatchObject({
    credential_selection: null,
    credential_scope: EMPTY_CREDENTIAL_SCOPE,
    credential_scope_source_evals_sha: null,
  });
});

test('createJob persists all-null credential fields for import', () => {
  const cfg = loaded();
  const job = createJob(cfg, importJobRequest({ runId: 'run-imported' }));

  expect(job.credential_selection).toBe(null);
  expect(job.credential_scope).toBe(null);
  expect(job.credential_scope_source_evals_sha).toBe(null);
  const record = persistedRecord(cfg, job.job_id);
  // Explicit nulls on disk, not absent keys the reader defaults later.
  expect(Object.hasOwn(record, 'credential_selection')).toBe(true);
  expect(Object.hasOwn(record, 'credential_scope')).toBe(true);
  expect(Object.hasOwn(record, 'credential_scope_source_evals_sha')).toBe(true);
  expect(record['credential_selection']).toBe(null);
  expect(record['credential_scope']).toBe(null);
  expect(record['credential_scope_source_evals_sha']).toBe(null);
});

test('the persisted credential fields carry no filesystem paths', () => {
  const cfg = loaded();
  const job = createJob(
    cfg,
    liveJobRequest('run', {
      // The selection and the scope describe the SAME cell: a record whose
      // selection contradicted its scope would not be the shape production
      // writes, so it could not prove anything about production's bytes.
      selection: { agent: 'pi', credential: 'pi_default' },
      scope: {
        schemaVersion: 1,
        kind: 'live',
        agent: 'pi',
        runtimeFamily: 'pi',
        credential: 'pi_default',
        agentEnv: [
          { destinationName: 'PI_API_KEY', sourceNames: ['PI_API_KEY'] },
        ],
        geminiAuthType: null,
        oauth: { kind: 'pi', mountName: 'pi', provider: 'openai-codex' },
      },
    }),
  );

  const record = persistedRecord(cfg, job.job_id);
  const credentialFields = JSON.stringify({
    credential_selection: record['credential_selection'],
    credential_scope: record['credential_scope'],
    credential_scope_source_evals_sha:
      record['credential_scope_source_evals_sha'],
  });
  // Names and mount labels only — never where the material lives on disk.
  expect(credentialFields).not.toContain('/');
  expect(credentialFields).not.toContain('credentials-scoped');
  expect(credentialFields).not.toContain(cfg.config.credential_bundle.path);
  expect(credentialFields).not.toContain(cfg.config.root);

  // The whole persisted record, not just the credential block: no field may
  // leak the blessed bundle or the scoped credential namespace.
  const wholeRecord = readFileSync(
    join(cfg.paths.jobs, job.job_id, 'job.json'),
    'utf8',
  );
  expect(wholeRecord).not.toContain(cfg.config.credential_bundle.path);
  expect(wholeRecord).not.toContain('credentials-scoped');
});

// The credential triple is written once, in the initial atomic record, and is
// the sole persisted authority afterwards. No update path may rewrite it — not
// preflight committing evidence, not the worker recording artifacts.
test('updateJob refuses to patch the persisted credential authority', () => {
  const cfg = loaded();
  const job = createJob(cfg, liveJobRequest('run'));
  const patches: readonly ((current: JobRecord) => JobRecord)[] = [
    (current) => ({ ...current, credential_scope: null }),
    (current) => ({ ...current, credential_scope: EMPTY_CREDENTIAL_SCOPE }),
    (current) => ({
      ...current,
      credential_selection: { agent: 'pi', credential: 'pi_default' },
    }),
    (current) => ({
      ...current,
      credential_scope_source_evals_sha: 'z'.repeat(40),
    }),
  ];

  for (const patch of patches) {
    let caught: unknown = null;
    try {
      updateJob(cfg, job.job_id, patch);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
  }

  const after = readJob(cfg, job.job_id);
  expect(after.credential_selection).toEqual(FIXTURE_LIVE_SELECTION);
  expect(after.credential_scope).toEqual(FIXTURE_LIVE_SCOPE);
  expect(after.credential_scope_source_evals_sha).toBe(
    FIXTURE_SOURCE_EVALS_SHA,
  );

  // Everything else still updates normally.
  expect(
    updateJob(cfg, job.job_id, (current) => ({ ...current, status: 'running' }))
      .status,
  ).toBe('running');
});

// Job persistence is part of the structural state boundary: the whole API
// accepts a state-only loaded config carrying no bundle metadata.
test('job lifecycle operates on the structural state config', () => {
  const full = loaded();
  const { bundle: _bundle, ...structural } = full;
  const job = createJob(structural, liveJobRequest('run'));
  expect(readJob(structural, job.job_id).job_id).toBe(job.job_id);
  expect(readJobById(structural, job.job_id)?.job_id).toBe(job.job_id);
});
