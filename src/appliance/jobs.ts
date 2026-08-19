import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { ApplianceError } from './errors.ts';
import { atomicWriteJson, mkdirPrivate, readJsonFile } from './fs.ts';
import { provenancePath } from './provenance.ts';
import { assertNoFollowDirChain, ensurePrivateDirNoFollow } from './safe-fs.ts';
import {
  type ApplianceCommandKind,
  type JobRecord,
  JobRecordSchema,
  type LoadedApplianceStateConfig,
} from './types.ts';

export interface CreateJobRequest {
  readonly kind: ApplianceCommandKind;
  readonly superpowersRef: string;
  readonly argv: readonly string[];
  // Present when the job is born already associated with a run (import
  // reservations): carried in the INITIAL atomic job.json write, so a crash
  // right after creation still leaves a record that exact run-id lookup can
  // find and reuse instead of minting a duplicate.
  readonly runId?: string;
  readonly requester: {
    readonly agent: string | null;
    readonly thread?: string | null;
    readonly task?: string | null;
  };
}

type JobPatcher = (current: JobRecord) => JobRecord;

function compactIsoTimestamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function newJobId(now: Date): string {
  return `job-${compactIsoTimestamp(now)}-${randomBytes(2).toString('hex')}`;
}

function jobDir(loaded: LoadedApplianceStateConfig, jobId: string): string {
  return join(loaded.paths.jobs, jobId);
}

function jobPath(loaded: LoadedApplianceStateConfig, jobId: string): string {
  return join(jobDir(loaded, jobId), 'job.json');
}

function readJobPath(path: string): JobRecord {
  return readJsonFile(path, JobRecordSchema, `job record ${path}`);
}

function hostUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

function remoteIdentity(user: string, agent: string | null): string {
  if (agent) {
    return agent;
  }
  return `local:${user}`;
}

function createEmptyLog(path: string): void {
  writeFileSync(path, '', { mode: 0o600 });
}

function allocateJobDir(
  loaded: LoadedApplianceStateConfig,
  now: Date,
): {
  id: string;
  dir: string;
} {
  // The jobs root is a mutable namespace boundary: creating a job through a
  // symlinked component would file the record wherever the link points.
  ensurePrivateDirNoFollow(loaded.config.root, loaded.paths.jobs, 'state/jobs');

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = newJobId(now);
    const dir = jobDir(loaded, id);
    try {
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
      return { id, dir };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new ApplianceError(
    'config_invalid',
    'job',
    'could not allocate unique job id',
  );
}

export function createJob(
  loaded: LoadedApplianceStateConfig,
  request: CreateJobRequest,
): JobRecord {
  const now = new Date();
  const { id, dir } = allocateJobDir(loaded, now);
  const stdoutLog = join(dir, 'stdout.log');
  const stderrLog = join(dir, 'stderr.log');
  createEmptyLog(stdoutLog);
  createEmptyLog(stderrLog);

  const user = hostUser();
  const createdAt = now.toISOString();
  const record = JobRecordSchema.parse({
    schema_version: 1,
    job_id: id,
    kind: request.kind,
    status: 'preflighting',
    created_at: createdAt,
    updated_at: createdAt,
    started_at: null,
    finished_at: null,
    requester: {
      agent: request.requester.agent,
      thread: request.requester.thread ?? null,
      task: request.requester.task ?? null,
      host_user: user,
      remote_identity: remoteIdentity(user, request.requester.agent),
    },
    command: {
      argv: [...request.argv],
      sanitized: true,
    },
    request: {
      superpowers_ref: request.superpowersRef,
    },
    refs: null,
    credential_bundle: null,
    container: null,
    process: null,
    artifacts: {
      run_id: request.runId ?? null,
      batch_id: null,
      stdout_log: stdoutLog,
      stderr_log: stderrLog,
      provenance: join(loaded.paths.provenance, `${id}.json`),
    },
    progress: null,
    result: { exit_code: null, summary: null },
    error: null,
  });

  atomicWriteJson(join(dir, 'job.json'), record);
  return record;
}

export function readJob(
  loaded: LoadedApplianceStateConfig,
  jobOrArtifactId: string,
): JobRecord {
  const directPath = jobPath(loaded, jobOrArtifactId);
  if (existsSync(directPath)) {
    return readJobPath(directPath);
  }

  if (existsSync(loaded.paths.jobs)) {
    const matches: JobRecord[] = [];
    for (const entry of readdirSync(loaded.paths.jobs, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidatePath = jobPath(loaded, entry.name);
      if (!existsSync(candidatePath)) {
        continue;
      }
      const job = readJobPath(candidatePath);
      if (
        job.artifacts.run_id === jobOrArtifactId ||
        job.artifacts.batch_id === jobOrArtifactId
      ) {
        matches.push(job);
      }
    }
    if (matches.length === 1) {
      const match = matches[0];
      if (match !== undefined) {
        return match;
      }
    }
    if (matches.length > 1) {
      throw new ApplianceError(
        'artifact_missing',
        'job',
        `${jobOrArtifactId} matches multiple jobs`,
      );
    }
  }

  throw new ApplianceError(
    'job_not_found',
    'job',
    `${jobOrArtifactId} not found`,
  );
}

// A job directory is part of the state integrity boundary: it must hold a
// readable job.json whose job_id equals the directory name. A missing or
// unreadable record may have claimed anything, and a mismatched one would
// send updateJob writing into a DIFFERENT directory — none of them can prove
// absence, so all fail closed as config_invalid for manual repair.
function readJobDirStrict(
  loaded: LoadedApplianceStateConfig,
  dirName: string,
): JobRecord {
  const path = jobPath(loaded, dirName);
  const recordStats = lstatSync(path, { throwIfNoEntry: false });
  if (recordStats === undefined) {
    throw new ApplianceError(
      'config_invalid',
      'job',
      `job directory ${dirName} has no job.json; repair state/jobs manually`,
    );
  }
  // A symlinked (or otherwise non-regular) record is content from outside the
  // integrity boundary wearing this job's name; it can prove nothing.
  if (!recordStats.isFile()) {
    throw new ApplianceError(
      'config_invalid',
      'job',
      `job directory ${dirName} job.json is not a regular file; repair state/jobs manually`,
    );
  }
  let job: JobRecord;
  try {
    job = readJobPath(path);
  } catch (error) {
    throw new ApplianceError(
      'config_invalid',
      'job',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (job.job_id !== dirName) {
    throw new ApplianceError(
      'config_invalid',
      'job',
      `job directory ${dirName} holds a record for job_id ${job.job_id}; repair state/jobs manually`,
    );
  }
  // The provenance field is record-controlled; anything acting on it (like
  // import's terminal-provenance retirement) would follow a redirected path
  // wherever it points — including at landed evidence. Exact lookups only
  // accept records carrying the canonical derived path.
  const canonical = provenancePath(loaded, job.job_id);
  if (job.artifacts.provenance !== canonical) {
    throw new ApplianceError(
      'config_invalid',
      'job',
      `job ${job.job_id} record points provenance at ${job.artifacts.provenance} (expected ${canonical}); repair state/jobs manually`,
    );
  }
  return job;
}

// A symlink where a job directory belongs is corrupt state for exact
// lookups: following it would accept a record from outside the integrity
// boundary, while skipping it would fake absence. Both exact paths reject
// it the same way, so they can never disagree about the same entry.
function rejectSymlinkedJobDir(name: string): never {
  throw new ApplianceError(
    'config_invalid',
    'job',
    `state/jobs entry ${name} is a symlink; repair state/jobs manually`,
  );
}

// Exact job-id lookup in the directory namespace — no artifact scan, no
// generic fallback, and symlinks are never followed. An absent (or
// non-directory) entry is null; a symlink or a directory that exists but is
// malformed fails closed as config_invalid, because it can prove nothing.
export function readJobById(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
): JobRecord | null {
  // The jobs root itself is part of the boundary: an entry probed through a
  // symlinked root would come from outside the namespace.
  if (
    !assertNoFollowDirChain(loaded.config.root, loaded.paths.jobs, 'state/jobs')
  ) {
    return null;
  }
  const stats = lstatSync(jobDir(loaded, jobId), { throwIfNoEntry: false });
  if (stats === undefined) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    rejectSymlinkedJobDir(jobId);
  }
  if (!stats.isDirectory()) {
    return null;
  }
  return readJobDirStrict(loaded, jobId);
}

// Strict enumeration of every job record in the directory namespace, under
// the same integrity boundary as the exact lookups: symlinked entries,
// non-directory entries, and malformed job directories fail closed as
// config_invalid, because state that cannot be read may have claimed
// anything. Shared by exact run-id resolution and prune's reference
// collection.
export function readAllJobsStrict(
  loaded: LoadedApplianceStateConfig,
): JobRecord[] {
  const jobs: JobRecord[] = [];
  // A symlinked jobs root would enumerate records from outside the
  // namespace and hide the real ones — including the reference that makes a
  // run ineligible for prune. Validated no-follow before enumeration; a
  // missing root is provable absence.
  if (
    assertNoFollowDirChain(loaded.config.root, loaded.paths.jobs, 'state/jobs')
  ) {
    // An enumeration failure proves nothing about which runs job records
    // reference, so it is the same typed manual-repair fault as any other
    // unreadable state — never a raw fs error.
    let entries: Dirent[];
    try {
      entries = readdirSync(loaded.paths.jobs, { withFileTypes: true });
    } catch (error) {
      throw new ApplianceError(
        'config_invalid',
        'job',
        `state/jobs is unreadable — cannot prove which runs are referenced: ${error instanceof Error ? error.message : String(error)}; repair state/jobs manually`,
      );
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        rejectSymlinkedJobDir(entry.name);
      }
      if (!entry.isDirectory()) {
        throw new ApplianceError(
          'config_invalid',
          'job',
          `state/jobs entry ${entry.name} is not a job directory; repair state/jobs manually`,
        );
      }
      jobs.push(readJobDirStrict(loaded, entry.name));
    }
  }
  return jobs;
}

// Exact artifacts.run_id resolution. Unlike readJob, this never consults job
// ids, so a run_id that happens to equal an unrelated job's id cannot resolve
// that job. Zero claimants throw job_not_found — the only error that means
// absence. Multiple claimants or any malformed job directory fail closed as
// config_invalid: absence cannot be proven over ambiguous or corrupt state,
// which needs manual repair, not a guess.
export function readJobByRunId(
  loaded: LoadedApplianceStateConfig,
  runId: string,
): JobRecord {
  const matches = readAllJobsStrict(loaded).filter(
    (job) => job.artifacts.run_id === runId,
  );
  if (matches.length > 1) {
    const ids = matches.map((job) => job.job_id).join(', ');
    throw new ApplianceError(
      'config_invalid',
      'job',
      `run_id ${runId} is claimed by ${matches.length} jobs (${ids}); refusing to resolve — repair state/jobs manually`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new ApplianceError(
      'job_not_found',
      'job',
      `no job claims run_id ${runId}`,
    );
  }
  return match;
}

export function updateJob(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
  patcher: JobPatcher,
): JobRecord {
  const path = jobPath(loaded, jobId);
  if (!existsSync(path)) {
    throw new ApplianceError('job_not_found', 'job', `${jobId} not found`);
  }

  const current = readJobPath(path);
  const patched = patcher(structuredClone(current));
  if (patched.job_id !== jobId) {
    throw new ApplianceError(
      'config_invalid',
      'job',
      `patcher changed immutable job_id for ${jobId}`,
    );
  }

  const record = JobRecordSchema.parse({
    ...patched,
    updated_at: new Date().toISOString(),
  });
  atomicWriteJson(path, record);

  // atomicWriteJson recreates the file mode; keep the containing job dir private
  // if it was restored from a less strict backup.
  if ((statSync(jobDir(loaded, jobId)).mode & 0o777) !== 0o700) {
    mkdirPrivate(jobDir(loaded, jobId));
  }

  return record;
}
