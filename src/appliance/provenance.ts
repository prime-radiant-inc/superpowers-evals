import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './fs.ts';
import {
  type JobRecord,
  type LoadedApplianceConfig,
  type ProvenanceRecord,
  ProvenanceRecordSchema,
  type RefSnapshot,
} from './types.ts';

export interface ProvenanceContainerRecord {
  readonly name: string;
  readonly id: string | null;
  readonly image_id: string | null;
  readonly mount_signature: string;
  readonly code_mounts_read_only: boolean;
}

export interface ProvenanceSource {
  readonly refs: RefSnapshot;
  readonly credential_bundle: {
    readonly name: 'blessed';
    readonly bundle_id: string;
  };
  readonly container: ProvenanceContainerRecord;
  readonly tool_versions_path: string | null;
  readonly tool_versions_text: string | null;
}

function artifactProvenanceTargets(
  loaded: LoadedApplianceConfig,
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
  loaded: LoadedApplianceConfig,
  jobId: string,
): string {
  return join(loaded.paths.provenance, `${jobId}.json`);
}

export function writeProvenance(
  loaded: LoadedApplianceConfig,
  job: JobRecord,
  result: ProvenanceSource,
  command: readonly string[],
): string {
  const path = provenancePath(loaded, job.job_id);
  const record: ProvenanceRecord = ProvenanceRecordSchema.parse({
    schema_version: 1,
    job_id: job.job_id,
    created_at: new Date().toISOString(),
    refs: result.refs,
    credential_bundle: result.credential_bundle,
    container: result.container,
    tool_versions_path: result.tool_versions_path,
    tool_versions_text: result.tool_versions_text,
    requester: job.requester,
    command_argv: [...command],
  });

  atomicWriteJson(path, record);
  for (const target of artifactProvenanceTargets(loaded, job)) {
    atomicWriteJson(target, record);
  }
  return path;
}
