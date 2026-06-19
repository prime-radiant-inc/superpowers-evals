import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { ApplianceError } from './errors.ts';
import { atomicWriteJson, mkdirPrivate, readJsonFile } from './fs.ts';
import {
  type ApplianceCommandKind,
  type JobRecord,
  JobRecordSchema,
  type LoadedApplianceConfig,
} from './types.ts';

export interface CreateJobRequest {
  readonly kind: ApplianceCommandKind;
  readonly superpowersRef: string;
  readonly argv: readonly string[];
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

function jobDir(loaded: LoadedApplianceConfig, jobId: string): string {
  return join(loaded.paths.jobs, jobId);
}

function jobPath(loaded: LoadedApplianceConfig, jobId: string): string {
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
  loaded: LoadedApplianceConfig,
  now: Date,
): {
  id: string;
  dir: string;
} {
  mkdirPrivate(loaded.paths.jobs);

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
  loaded: LoadedApplianceConfig,
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
      run_id: null,
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
  loaded: LoadedApplianceConfig,
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

export function updateJob(
  loaded: LoadedApplianceConfig,
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
