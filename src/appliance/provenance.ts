import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApplianceError } from './errors.ts';
import { atomicWriteJson } from './fs.ts';
import {
  type JobRecord,
  type LoadedApplianceStateConfig,
  type ProvenanceRecord,
  ProvenanceRecordSchema,
} from './types.ts';

// The only material provenance cannot read back off the job: the tool
// versions the probe container reported. Everything else — refs, bundle,
// container evidence, credential scope, requester, argv — is derived from the
// record, so a retry heals the derived file without a caller being able to
// restate any of it.
export interface ProvenanceToolVersions {
  readonly path: string | null;
  readonly text: string | null;
}

function artifactProvenanceTargets(
  loaded: LoadedApplianceStateConfig,
  job: JobRecord,
): string[] {
  const targets: string[] = [];
  if (job.artifacts.run_id !== null) {
    const runDir = join(
      loaded.config.container.results_root,
      job.artifacts.run_id,
    );
    if (existsSync(runDir)) {
      targets.push(join(runDir, 'appliance-provenance.json'));
    }
  }
  if (job.artifacts.batch_id !== null) {
    const batchDir = join(
      loaded.config.container.results_root,
      'batches',
      job.artifacts.batch_id,
    );
    if (existsSync(batchDir)) {
      targets.push(join(batchDir, 'appliance-provenance.json'));
    }
  }
  return targets;
}

export function provenancePath(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
): string {
  return join(loaded.paths.provenance, `${jobId}.json`);
}

function requireCommitted<T>(value: T | null, jobId: string, what: string): T {
  if (value === null) {
    throw new ApplianceError(
      'config_invalid',
      'provenance',
      `job ${jobId} has not committed its ${what}; provenance is derived from the job, never from the caller`,
    );
  }
  return value;
}

/**
 * Write the live provenance record for a job that has already committed its
 * evidence. Identity comes from the reread job — refs, bundle, container
 * evidence, and the authoritative credential scope — so this file can never
 * disagree with the record it describes, and a failed write can be retried
 * from the job alone.
 *
 * Read-only code-mount evidence is provenance-only: it is a property of how
 * the appliance mounts code, not of the job, so it is stated here rather than
 * duplicated into durable job evidence.
 */
export function writeProvenance(
  loaded: LoadedApplianceStateConfig,
  job: JobRecord,
  toolVersions: ProvenanceToolVersions,
): string {
  const path = provenancePath(loaded, job.job_id);
  const container = requireCommitted(
    job.container,
    job.job_id,
    'container evidence',
  );
  const record: ProvenanceRecord = ProvenanceRecordSchema.parse({
    schema_version: 1,
    job_id: job.job_id,
    created_at: new Date().toISOString(),
    refs: requireCommitted(job.refs, job.job_id, 'refs'),
    credential_bundle: requireCommitted(
      job.credential_bundle,
      job.job_id,
      'credential bundle',
    ),
    container: { ...container, code_mounts_read_only: false },
    credential_scope: job.credential_scope,
    tool_versions_path: toolVersions.path,
    tool_versions_text: toolVersions.text,
    requester: job.requester,
    command_argv: [...job.command.argv],
  });

  atomicWriteJson(path, record);
  for (const target of artifactProvenanceTargets(loaded, job)) {
    atomicWriteJson(target, record);
  }
  return path;
}
