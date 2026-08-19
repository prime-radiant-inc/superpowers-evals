import { z } from 'zod';
import { ApplianceErrorCodeSchema } from './errors.ts';

export const ApplianceConfigSchema = z.object({
  root: z.string(),
  evals: z.object({
    path: z.string(),
    remote: z.string(),
    ref: z.string(),
  }),
  superpowers: z.object({
    path: z.string(),
    remote: z.string(),
  }),
  gauntlet: z.object({
    path: z.string(),
    remote: z.string(),
    ref: z.string(),
  }),
  credential_bundle: z.object({
    name: z.literal('blessed'),
    path: z.string(),
  }),
  container: z.object({
    name: z.string(),
    results_root: z.string(),
  }),
});
export type ApplianceConfig = z.infer<typeof ApplianceConfigSchema>;

export const CredentialBundleMetadataSchema = z.object({
  bundle_id: z.string(),
  rotated_at: z.string(),
  providers: z.array(z.string()),
  note: z.string().optional(),
});
export type CredentialBundleMetadata = z.infer<
  typeof CredentialBundleMetadataSchema
>;

export const JobStatusSchema = z.enum([
  'preflighting',
  'queued',
  'running',
  'stopping',
  'done',
  'failed',
  'cancelled',
  'lost',
  'quarantined',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const ApplianceCommandKindSchema = z.enum([
  'prepare',
  'run',
  'run-all',
  'import',
  'prune',
]);
export type ApplianceCommandKind = z.infer<typeof ApplianceCommandKindSchema>;

export const REV_RECOVERY_STATUSES = [
  'recorded',
  'recovered',
  'tree_only',
  'inferred',
  'unknown',
] as const;

// What an imported run knows about its own provenance. This block exists
// because an imported run cannot honestly fill in RefSnapshot: it predates the
// appliance, ran on local credentials, and in many cases had no rev recorded at
// all. Loosening RefSnapshotSchema to hold partial data would weaken the
// guarantee it exists to give live jobs, so the uncertainty lives here instead,
// named explicitly.
export const OriginSchema = z.object({
  kind: z.literal('imported'),
  imported_at: z.string(),
  source_host: z.string(),
  source_path: z.string(),
  superpowers_sha: z.string().nullable(),
  superpowers_tree_sha: z.string().nullable(),
  inferred_superpowers_sha: z.string().nullable(),
  rev_recovery: z.enum(REV_RECOVERY_STATUSES),
  harness_rev: z.string().nullable(),
  scenario: z.string().nullable(),
  coding_agent: z.string().nullable(),
  credential: z.string().nullable(),
});
export type Origin = z.infer<typeof OriginSchema>;

export const RefSnapshotSchema = z.object({
  superpowers_requested_ref: z.string(),
  superpowers_resolved_sha: z.string(),
  evals_ref: z.string(),
  evals_resolved_sha: z.string(),
  gauntlet_ref: z.string(),
  gauntlet_built_sha: z.string(),
});
export type RefSnapshot = z.infer<typeof RefSnapshotSchema>;

const JobCredentialBundleSchema = z.object({
  name: z.literal('blessed'),
  bundle_id: z.string(),
});

const JobContainerSchema = z.object({
  name: z.string(),
  id: z.string().nullable(),
  image_id: z.string().nullable(),
  mount_signature: z.string(),
});

// A signalable process group id: `kill -0/-INT -- -PGID` targets the whole
// group, so 0 (caller's group), 1 (init), negatives, and non-integers are
// never recordable. runRecordedContainerLifecycle repeats this exact check at
// its own runtime boundary before any signal is issued.
export const ProcessGroupIdSchema = z.number().int().safe().gt(1);

const JobProcessSchema = z.object({
  host_pid: z.number().int(),
  host_pgid: ProcessGroupIdSchema,
  container_pid: z.number().int().nullable(),
  container_pgid: ProcessGroupIdSchema.nullable(),
});

const JobProgressSchema = z.object({
  last_heartbeat_at: z.string().nullable(),
  running: z.number().int().nullable(),
  done: z.number().int().nullable(),
  queued: z.number().int().nullable(),
});

export const JobRecordSchema = z.object({
  schema_version: z.literal(1),
  job_id: z.string(),
  kind: ApplianceCommandKindSchema,
  status: JobStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  requester: z.object({
    agent: z.string().nullable(),
    thread: z.string().nullable().optional(),
    task: z.string().nullable().optional(),
    host_user: z.string(),
    remote_identity: z.string(),
  }),
  command: z.object({
    argv: z.array(z.string()),
    sanitized: z.boolean(),
  }),
  request: z.object({
    superpowers_ref: z.string(),
  }),
  refs: RefSnapshotSchema.nullable(),
  credential_bundle: JobCredentialBundleSchema.nullable(),
  container: JobContainerSchema.nullable(),
  process: JobProcessSchema.nullable(),
  artifacts: z.object({
    run_id: z.string().nullable(),
    batch_id: z.string().nullable(),
    stdout_log: z.string(),
    stderr_log: z.string(),
    provenance: z.string(),
  }),
  progress: JobProgressSchema.nullable(),
  // Present only on imported jobs; absent on anything this appliance ran.
  origin: OriginSchema.optional(),
  result: z.object({
    exit_code: z.number().int().nullable(),
    summary: z.string().nullable(),
  }),
  error: z
    .object({
      code: ApplianceErrorCodeSchema,
      step: z.string(),
      message: z.string(),
    })
    .nullable(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export const LockRecordSchema = z.object({
  schema_version: z.literal(1).optional(),
  job_id: z.string(),
  name: z.enum(['run.lock', 'sync.lock']),
  host: z.string(),
  pid: z.number().int(),
  pgid: z.number().int(),
  started_at: z.string(),
  command: ApplianceCommandKindSchema,
  refs: RefSnapshotSchema.nullable(),
});
export type LockRecord = z.infer<typeof LockRecordSchema>;

export const ProvenanceRecordSchema = z
  .object({
    schema_version: z.literal(1),
    job_id: z.string(),
    created_at: z.string(),
    refs: RefSnapshotSchema,
    credential_bundle: z.object({
      name: z.literal('blessed'),
      bundle_id: z.string(),
    }),
    container: JobContainerSchema.extend({
      code_mounts_read_only: z.boolean(),
    }),
    tool_versions_path: z.string().nullable(),
    tool_versions_text: z.string().nullable(),
    requester: z.object({
      agent: z.string().nullable().optional(),
      thread: z.string().nullable().optional(),
      task: z.string().nullable().optional(),
      host_user: z.string(),
      remote_identity: z.string(),
    }),
    command_argv: z.array(z.string()),
  })
  .refine(
    (record) =>
      record.tool_versions_path !== null || record.tool_versions_text !== null,
    {
      message: 'tool_versions_path or tool_versions_text is required',
      path: ['tool_versions_path'],
    },
  );
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

// Provenance for an imported run. `kind` discriminates it from a live record,
// which has no such field, so provenance written before this existed still
// parses unchanged.
export const ImportedProvenanceRecordSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('imported'),
  job_id: z.string(),
  created_at: z.string(),
  origin: OriginSchema,
  requester: z.object({
    agent: z.string().nullable().optional(),
    thread: z.string().nullable().optional(),
    task: z.string().nullable().optional(),
    host_user: z.string(),
    remote_identity: z.string(),
  }),
  command_argv: z.array(z.string()),
});
export type ImportedProvenanceRecord = z.infer<
  typeof ImportedProvenanceRecordSchema
>;

export const AnyProvenanceRecordSchema = z.union([
  ImportedProvenanceRecordSchema,
  ProvenanceRecordSchema,
]);

// The structural half of a loaded appliance config: everything read and
// recovery operations (status/show/costs, jobs, locks, import, prune,
// identity-verified cancellation) need, and nothing credential-shaped. It is
// produced by loadStateConfig, which never stats or reads the credential
// bundle — so a missing, unreadable, or unsafe bundle cannot strand those
// operations. Credential-aware operations require LoadedApplianceConfig,
// whose extra `bundle` field only exists after loadCredentialConfig has
// validated the bundle boundary and read metadata.json no-follow. `bundle`
// is deliberately NOT an optional field on one shared type: the compiler,
// not a runtime check, enforces which operations may touch bundle metadata.
export interface LoadedApplianceStateConfig {
  readonly config: ApplianceConfig;
  readonly configPath: string;
  readonly paths: {
    readonly jobs: string;
    readonly locks: string;
    readonly provenance: string;
  };
}

export interface LoadedApplianceConfig extends LoadedApplianceStateConfig {
  readonly bundle: CredentialBundleMetadata;
}
