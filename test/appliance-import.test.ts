import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ApplianceError,
  type ApplianceErrorCode,
} from '../src/appliance/errors.ts';
import { type ImportResult, importBundle } from '../src/appliance/import.ts';
import {
  createJob,
  readJob,
  readJobByRunId,
  updateJob,
} from '../src/appliance/jobs.ts';
import { acquireLock } from '../src/appliance/locks.ts';
import {
  ImportedProvenanceRecordSchema,
  type JobRecord,
  type LoadedApplianceConfig,
} from '../src/appliance/types.ts';

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-import-'));
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

const RUN_ID = 'demo-codex-codex_sub-linux-20260730T201515Z-a325';
const RUN_ID_B = 'demo-codex-codex_sub-linux-20260730T211515Z-b777';

function sha256(body: string): string {
  return Bun.SHA256.hash(Buffer.from(body), 'hex');
}

// Every job record under state/jobs claiming this run_id — the duplicate
// detector: recording must repair in place, never mint a second job. Records
// that don't parse are skipped: they can't claim the run.
function countJobsForRun(cfg: LoadedApplianceConfig, runId: string): number {
  let count = 0;
  for (const entry of readdirSync(cfg.paths.jobs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jobPath = join(cfg.paths.jobs, entry.name, 'job.json');
    if (!existsSync(jobPath)) continue;
    let job: JobRecord;
    try {
      job = JSON.parse(readFileSync(jobPath, 'utf8')) as JobRecord;
    } catch {
      continue;
    }
    if (job.artifacts.run_id === runId) count += 1;
  }
  return count;
}

function importJobClaiming(cfg: LoadedApplianceConfig, runId: string) {
  const job = createJob(cfg, {
    kind: 'import',
    superpowersRef: 'unknown',
    argv: ['evals-appliance', 'import', runId],
    requester: { agent: null, thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    artifacts: { ...current.artifacts, run_id: runId },
  }));
  return job;
}

interface BundleOverrides {
  readonly extraFile?: { readonly path: string; readonly body: string };
  readonly corruptChecksum?: boolean;
  readonly revRecovery?: string;
  readonly runIds?: readonly string[];
}

function makeBundle(overrides: BundleOverrides = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  const verdictBody = JSON.stringify({ schema: 1, final: 'pass' });
  const files: Record<string, string> = {
    'verdict.json': overrides.corruptChecksum
      ? sha256('something else entirely')
      : sha256(verdictBody),
  };

  const entries = (overrides.runIds ?? [RUN_ID]).map((runId) => {
    const runDir = join(dir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'verdict.json'), verdictBody);

    const entryFiles: Record<string, string> = { ...files };
    if (overrides.extraFile !== undefined) {
      const path = join(runDir, overrides.extraFile.path);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, overrides.extraFile.body);
      entryFiles[overrides.extraFile.path] = sha256(overrides.extraFile.body);
    }

    return {
      run_id: runId,
      source_path: `/Users/jesse/git/evals/results/cx-demo-rep1/${runId}`,
      scenario: 'demo-scenario',
      coding_agent: 'codex',
      credential: 'codex_sub',
      os: 'linux',
      started_at: '2026-07-30T20:15:15.000Z',
      finished_at: '2026-07-30T20:35:15.000Z',
      final: 'pass',
      harness_rev: 'abc123harness',
      rev_recovery: overrides.revRecovery ?? 'recovered',
      superpowers_sha: '3da65fb0da716305934940f0760376496defc4e7',
      superpowers_tree_sha: '0df4d01f92fd50730641366288d54ee59561a30c',
      inferred_superpowers_sha: null,
      files: entryFiles,
    };
  });

  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      created_at: '2026-08-09T00:00:00.000Z',
      source_host: 'laptop',
      source_results_dir: '/Users/jesse/git/evals/results',
      entries,
      skipped: [],
    }),
  );
  return dir;
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

test('import lands the payload and writes an imported job record', () => {
  const cfg = loaded();
  const result = importBundle(cfg, { bundleDir: makeBundle() });

  expect(result.imported).toBe(1);
  expect(result.skipped).toBe(0);
  expect(
    existsSync(join(cfg.config.container.results_root, RUN_ID, 'verdict.json')),
  ).toBe(true);

  const job = readJob(cfg, RUN_ID);
  expect(job.kind).toBe('import');
  expect(job.status).toBe('done');
  expect(job.artifacts.run_id).toBe(RUN_ID);
  expect(job.result.exit_code).toBe(0);
  // An imported job must never claim refs or a blessed bundle it never had.
  expect(job.refs).toBeNull();
  expect(job.credential_bundle).toBeNull();
  expect(job.container).toBeNull();
  expect(job.origin?.kind).toBe('imported');
  expect(job.origin?.rev_recovery).toBe('recovered');
  expect(job.origin?.superpowers_sha).toBe(
    '3da65fb0da716305934940f0760376496defc4e7',
  );
  expect(job.origin?.source_host).toBe('laptop');
});

test('imported provenance is written next to the run and in the state dir', () => {
  const cfg = loaded();
  importBundle(cfg, { bundleDir: makeBundle() });
  const job = readJob(cfg, RUN_ID);

  const stateRecord = ImportedProvenanceRecordSchema.parse(
    JSON.parse(readFileSync(job.artifacts.provenance, 'utf8')),
  );
  expect(stateRecord.job_id).toBe(job.job_id);
  expect(stateRecord.origin.superpowers_sha).toBe(
    '3da65fb0da716305934940f0760376496defc4e7',
  );

  const beside = join(
    cfg.config.container.results_root,
    RUN_ID,
    'appliance-provenance.json',
  );
  expect(existsSync(beside)).toBe(true);
});

test('a checksum mismatch aborts before anything lands', () => {
  const cfg = loaded();
  expectCode(
    () =>
      importBundle(cfg, { bundleDir: makeBundle({ corruptChecksum: true }) }),
    'artifact_missing',
  );
  expect(existsSync(join(cfg.config.container.results_root, RUN_ID))).toBe(
    false,
  );
});

test('a credential-shaped path in the bundle is rejected outright', () => {
  const cfg = loaded();
  expectCode(
    () =>
      importBundle(cfg, {
        bundleDir: makeBundle({
          extraFile: { path: 'raw-sessions/auth.json', body: '{"t":"secret"}' },
        }),
      }),
    'config_invalid',
  );
  expect(existsSync(join(cfg.config.container.results_root, RUN_ID))).toBe(
    false,
  );
});

test('importing the same bundle twice lands one copy', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  importBundle(cfg, { bundleDir: bundle });
  const second = importBundle(cfg, { bundleDir: bundle });

  expect(second.imported).toBe(0);
  expect(second.skipped).toBe(1);
  // One job record, not two.
  const job = readJob(cfg, RUN_ID);
  expect(job.artifacts.run_id).toBe(RUN_ID);
});

test('a conflicting destination is rejected: landed run untouched, payload quarantined', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  importBundle(cfg, { bundleDir: bundle });
  const landed = join(
    cfg.config.container.results_root,
    RUN_ID,
    'verdict.json',
  );
  writeFileSync(landed, 'STALE');

  const second = importBundle(cfg, { bundleDir: bundle });
  expect(second.imported).toBe(0);
  expect(second.failed).toBe(1);
  expect(second.failures[0]?.code).toBe('import_conflict');
  // Failure identity: the entry is named and the message says what happened:
  expect(second.failures[0]?.run_id).toBe(RUN_ID);
  expect(second.failures[0]?.message).toContain('landed run untouched');
  expect(second.failures[0]?.message).toContain('quarantined');
  // The landed evidence is byte-for-byte what it was:
  expect(readFileSync(landed, 'utf8')).toBe('STALE');
  // The incoming payload was quarantined intact, not deleted:
  const qroot = join(cfg.config.root, 'state', 'quarantine');
  const qdirs = readdirSync(qroot);
  const qname = qdirs.find((d) => d.includes(RUN_ID));
  expect(qname).toBeDefined();
  expect(
    readFileSync(join(qroot, qname as string, 'verdict.json'), 'utf8'),
  ).not.toBe('STALE');
});

test('a pre-existing identical run dir with no job record is record-healed, not overwritten', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  // A run dir that predates appliance records (e.g. committed locally):
  const destRun = join(cfg.config.container.results_root, RUN_ID);
  mkdirSync(destRun, { recursive: true });
  // Byte-identical to makeBundle's payload (same body string as makeBundle uses):
  writeFileSync(
    join(destRun, 'verdict.json'),
    JSON.stringify({ schema: 1, final: 'pass' }),
  );

  const result = importBundle(cfg, { bundleDir: bundle });
  expect(result.imported).toBe(0);
  expect(result.healed).toBe(1);
  expect(readJob(cfg, RUN_ID).artifacts.run_id).toBe(RUN_ID);
});

test('healing never modifies a byte of the landed run: an original provenance sidecar survives intact', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  const destRun = join(cfg.config.container.results_root, RUN_ID);
  mkdirSync(destRun, { recursive: true });
  writeFileSync(
    join(destRun, 'verdict.json'),
    JSON.stringify({ schema: 1, final: 'pass' }),
  );
  // A sidecar that predates this import (e.g. from the exporting host's own
  // bookkeeping) with sentinel bytes that must survive byte-for-byte:
  const sidecar = join(destRun, 'appliance-provenance.json');
  const sentinel = 'ORIGINAL-SENTINEL-PROVENANCE-BYTES';
  writeFileSync(sidecar, sentinel);

  const result = importBundle(cfg, { bundleDir: bundle });
  expect(result.healed).toBe(1);
  expect(readFileSync(sidecar, 'utf8')).toBe(sentinel);
  expect(readJob(cfg, RUN_ID).artifacts.run_id).toBe(RUN_ID);
});

test('a partial recording (done job, missing state provenance) is repaired on retry, not skipped', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  importBundle(cfg, { bundleDir: bundle });
  const first = readJob(cfg, RUN_ID);
  // Reproduce the partial failure state: the job landed and is done, but the
  // provenance write never completed.
  rmSync(first.artifacts.provenance, { force: true });

  const retry = importBundle(cfg, { bundleDir: bundle });
  expect(retry.imported).toBe(0);
  expect(retry.healed).toBe(1);
  expect(retry.skipped).toBe(0);
  // The state provenance is restored at the same job's slot:
  expect(existsSync(first.artifacts.provenance)).toBe(true);
  const repaired = readJob(cfg, RUN_ID);
  expect(repaired.job_id).toBe(first.job_id);
  expect(countJobsForRun(cfg, RUN_ID)).toBe(1);
});

test('re-landing after the run dir disappeared reuses the existing job instead of duplicating it', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  importBundle(cfg, { bundleDir: bundle });
  const first = readJob(cfg, RUN_ID);
  // A landed run whose directory later vanished (operator removal, crash):
  rmSync(join(cfg.config.container.results_root, RUN_ID), {
    recursive: true,
    force: true,
  });

  const retry = importBundle(cfg, { bundleDir: bundle });
  expect(retry.imported).toBe(1);
  expect(countJobsForRun(cfg, RUN_ID)).toBe(1);
  expect(readJob(cfg, RUN_ID).job_id).toBe(first.job_id);
  expect(
    existsSync(join(cfg.config.container.results_root, RUN_ID, 'verdict.json')),
  ).toBe(true);
});

test('a failed landing leaves no durable success claim; retry reuses the reserved record and finishes it', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  const resultsRoot = cfg.config.container.results_root;
  const destRun = join(resultsRoot, RUN_ID);
  const staged = join(resultsRoot, `.importing-${RUN_ID}.${process.pid}.tmp`);
  // Scoped fake: only the staged→destRun landing rename faults; everything
  // else (lock churn, cleanup) hits the real fs. Restored in finally.
  const realRename = fs.renameSync;
  const spy = spyOn(fs, 'renameSync').mockImplementation(
    (
      from: Parameters<typeof fs.renameSync>[0],
      to: Parameters<typeof fs.renameSync>[1],
    ) => {
      if (from === staged && to === destRun) {
        const err = new Error('EPERM: cannot land') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realRename(from, to);
    },
  );
  let first: ImportResult;
  try {
    first = importBundle(cfg, { bundleDir: bundle });
  } finally {
    spy.mockRestore();
  }
  expect(first.imported).toBe(0);
  expect(first.failed).toBe(1);
  expect(first.failures[0]?.run_id).toBe(RUN_ID);
  expect(first.failures[0]?.code).toBe('unknown');
  expect(first.failures[0]?.message).toContain('EPERM');
  expect(existsSync(destRun)).toBe(false);
  // Durable state does not claim success: the reserved record is nonterminal,
  // carries no exit code, and no terminal state provenance exists.
  const reserved = readJobByRunId(cfg, RUN_ID);
  expect(reserved.status).toBe('running');
  expect(reserved.result.exit_code).toBeNull();
  expect(existsSync(reserved.artifacts.provenance)).toBe(false);
  expect(countJobsForRun(cfg, RUN_ID)).toBe(1);

  const retry = importBundle(cfg, { bundleDir: bundle });
  expect(retry.imported).toBe(1);
  expect(countJobsForRun(cfg, RUN_ID)).toBe(1);
  const finished = readJobByRunId(cfg, RUN_ID);
  expect(finished.job_id).toBe(reserved.job_id);
  expect(finished.status).toBe('done');
  expect(finished.result.exit_code).toBe(0);
  expect(existsSync(finished.artifacts.provenance)).toBe(true);
  expect(existsSync(join(destRun, 'verdict.json'))).toBe(true);
});

test('a stage cleanup failure is best-effort: the original failure is kept and later entries still land', () => {
  const cfg = loaded();
  const bundle = makeBundle({ runIds: [RUN_ID, RUN_ID_B] });
  const stagedA = join(
    cfg.config.container.results_root,
    `.importing-${RUN_ID}.${process.pid}.tmp`,
  );
  // Scoped fake: rmSync on entry A's exact stage path always faults (both the
  // stale-stage probe and the catch-path cleanup); entry B is untouched.
  const realRm = fs.rmSync;
  const spy = spyOn(fs, 'rmSync').mockImplementation(
    (
      path: Parameters<typeof fs.rmSync>[0],
      options?: Parameters<typeof fs.rmSync>[1],
    ) => {
      if (path === stagedA) {
        const err = new Error(
          `EPERM: stage busy: ${stagedA}`,
        ) as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realRm(path, options);
    },
  );
  let result: ImportResult;
  try {
    result = importBundle(cfg, { bundleDir: bundle });
  } finally {
    spy.mockRestore();
  }
  expect(result.failed).toBe(1);
  // Entry B still landed — one entry's cleanup fault never aborts the rest:
  expect(result.imported).toBe(1);
  expect(
    existsSync(
      join(cfg.config.container.results_root, RUN_ID_B, 'verdict.json'),
    ),
  ).toBe(true);
  // The original fault is retained, with cleanup context appended after it:
  const failure = result.failures[0];
  expect(failure?.run_id).toBe(RUN_ID);
  expect(failure?.code).toBe('unknown');
  expect(failure?.message).toContain('EPERM');
  expect(failure?.message).toContain('cleanup failed');
  // The original fault comes first; cleanup context is appended after it:
  const message = failure?.message ?? '';
  expect(message.indexOf('EPERM')).toBeLessThan(
    message.indexOf('cleanup failed'),
  );
});

test('a non-import job claiming the run_id with no landed dir fails closed instead of conflating records', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  // A live run job whose run dir is absent (pathological but visible state):
  const foreign = createJob(cfg, {
    kind: 'run',
    superpowersRef: 'main',
    argv: ['quorum', 'run'],
    requester: { agent: null, thread: null, task: null },
  });
  updateJob(cfg, foreign.job_id, (current) => ({
    ...current,
    artifacts: { ...current.artifacts, run_id: RUN_ID },
  }));

  const result = importBundle(cfg, { bundleDir: bundle });
  expect(result.imported).toBe(0);
  expect(result.failed).toBe(1);
  expect(result.failures[0]?.code).toBe('config_invalid');
  expect(result.failures[0]?.run_id).toBe(RUN_ID);
  expect(existsSync(join(cfg.config.container.results_root, RUN_ID))).toBe(
    false,
  );
  // The foreign job is untouched and no import duplicate was minted:
  expect(countJobsForRun(cfg, RUN_ID)).toBe(1);
  expect(readJob(cfg, RUN_ID).kind).toBe('run');
});

test('two jobs claiming one run_id fail that entry closed while later entries continue', () => {
  const cfg = loaded();
  const bundle = makeBundle({ runIds: [RUN_ID, RUN_ID_B] });
  // Two legacy records both claiming the same run — ambiguous, ours to
  // surface, never to resolve by minting a third:
  importJobClaiming(cfg, RUN_ID);
  importJobClaiming(cfg, RUN_ID);

  const result = importBundle(cfg, { bundleDir: bundle });
  // The ambiguous entry fails closed with full identity:
  expect(result.failed).toBe(1);
  expect(result.failures[0]?.run_id).toBe(RUN_ID);
  expect(result.failures[0]?.code).toBe('config_invalid');
  expect(result.failures[0]?.message).toContain('claimed by 2 jobs');
  expect(countJobsForRun(cfg, RUN_ID)).toBe(2);
  expect(existsSync(join(cfg.config.container.results_root, RUN_ID))).toBe(
    false,
  );
  // The unambiguous later entry still lands:
  expect(result.imported).toBe(1);
  expect(result.run_ids).toEqual([RUN_ID_B]);
  expect(
    existsSync(
      join(cfg.config.container.results_root, RUN_ID_B, 'verdict.json'),
    ),
  ).toBe(true);
});

test('a run_id equal to an unrelated job id lands its own record and leaves that job byte-for-byte intact', () => {
  const cfg = loaded();
  // An unrelated import job that never claims this run — but whose job_id is
  // exactly the incoming run_id:
  const unrelated = createJob(cfg, {
    kind: 'import',
    superpowersRef: 'unknown',
    argv: ['evals-appliance', 'import', 'some-other-run'],
    requester: { agent: null, thread: null, task: null },
  });
  const unrelatedPath = join(cfg.paths.jobs, unrelated.job_id, 'job.json');
  const unrelatedBytes = readFileSync(unrelatedPath, 'utf8');
  const bundle = makeBundle({ runIds: [unrelated.job_id] });

  const result = importBundle(cfg, { bundleDir: bundle });
  expect(result.imported).toBe(1);
  // The unrelated job was not rewritten:
  expect(readFileSync(unrelatedPath, 'utf8')).toBe(unrelatedBytes);
  // The import got its own record, associated by artifacts.run_id:
  const importJob = readJobByRunId(cfg, unrelated.job_id);
  expect(importJob.job_id).not.toBe(unrelated.job_id);
  expect(importJob.kind).toBe('import');
  expect(importJob.status).toBe('done');
  expect(importJob.artifacts.run_id).toBe(unrelated.job_id);
  expect(countJobsForRun(cfg, unrelated.job_id)).toBe(1);
  expect(
    existsSync(
      join(cfg.config.container.results_root, unrelated.job_id, 'verdict.json'),
    ),
  ).toBe(true);
});

test('a corrupt job record fails entries closed with a typed failure instead of minting duplicates', () => {
  const cfg = loaded();
  const bundle = makeBundle({ runIds: [RUN_ID, RUN_ID_B] });
  const corrupt = createJob(cfg, {
    kind: 'run',
    superpowersRef: 'main',
    argv: ['quorum', 'run'],
    requester: { agent: null, thread: null, task: null },
  });
  writeFileSync(join(cfg.paths.jobs, corrupt.job_id, 'job.json'), 'not json');

  const result = importBundle(cfg, { bundleDir: bundle });
  // Absence can't be proven over corrupt state, so every entry fails closed —
  // as its own typed failure, without aborting the loop:
  expect(result.imported).toBe(0);
  expect(result.failed).toBe(2);
  expect(result.failures.map((f) => f.run_id)).toEqual([RUN_ID, RUN_ID_B]);
  for (const failure of result.failures) {
    expect(failure.code).toBe('config_invalid');
    expect(failure.message).toContain('job record');
  }
  expect(existsSync(join(cfg.config.container.results_root, RUN_ID))).toBe(
    false,
  );
  expect(existsSync(join(cfg.config.container.results_root, RUN_ID_B))).toBe(
    false,
  );
  expect(countJobsForRun(cfg, RUN_ID)).toBe(0);
});

test('a manifest run_id with path traversal is rejected before anything lands', () => {
  const cfg = loaded();
  const dir = makeBundle();
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.entries[0].run_id = '../../evil';
  writeFileSync(manifestPath, JSON.stringify(manifest));

  let caught: unknown;
  try {
    importBundle(cfg, { bundleDir: dir });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApplianceError);
  const err = caught as ApplianceError;
  expect(err.code).toBe('config_invalid');
  // The rejection names the exact offending run_id:
  expect(err.message).toContain('../../evil');
  // The true resolved escape target: results_root/../.. is the appliance root
  // itself, so an unguarded join would have escaped the results root entirely.
  const escapeTarget = resolve(cfg.config.container.results_root, '../../evil');
  expect(escapeTarget).toBe(join(cfg.config.root, 'evil'));
  expect(existsSync(escapeTarget)).toBe(false);
  // Nothing landed, nothing staged:
  expect(readdirSync(cfg.config.container.results_root)).toEqual([]);
});

test('a failing verdict imports with a non-zero exit code', () => {
  const cfg = loaded();
  const dir = makeBundle();
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.entries[0].final = 'fail';
  writeFileSync(manifestPath, JSON.stringify(manifest));

  importBundle(cfg, { bundleDir: dir });
  expect(readJob(cfg, RUN_ID).result.exit_code).toBe(1);
});

test('import refuses while a live job holds run.lock', () => {
  const cfg = loaded();
  const held = acquireLock({
    loaded: cfg,
    name: 'run.lock',
    jobId: 'job-live',
    command: 'run-all',
  });

  try {
    expectCode(
      () => importBundle(cfg, { bundleDir: makeBundle() }),
      'lock_busy',
    );
    expect(existsSync(join(cfg.config.container.results_root, RUN_ID))).toBe(
      false,
    );
  } finally {
    held.release();
  }
});

test('import releases run.lock when a bundle is rejected', () => {
  const cfg = loaded();
  expectCode(
    () =>
      importBundle(cfg, { bundleDir: makeBundle({ corruptChecksum: true }) }),
    'artifact_missing',
  );

  // A rejected import must not strand the lock; the next one has to work.
  const result = importBundle(cfg, { bundleDir: makeBundle() });
  expect(result.imported).toBe(1);
});

test('a malformed manifest is a config error, not a crash', () => {
  const cfg = loaded();
  const dir = mkdtempSync(join(tmpdir(), 'bundle-bad-'));
  writeFileSync(join(dir, 'manifest.json'), '{"schema_version": 99}');
  expectCode(() => importBundle(cfg, { bundleDir: dir }), 'config_invalid');
});
