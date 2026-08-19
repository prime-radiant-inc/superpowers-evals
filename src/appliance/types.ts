import { z } from 'zod';
import { ApplianceErrorCodeSchema } from './errors.ts';

// --- persisted credential request -------------------------------------------
// The durable mirror of src/credentials/scope.ts. A job's credential authority
// is persisted once, in the job record, and read back by preflight and the
// live execution binding. These schemas exist so a record cannot claim a
// delivery shape the resolver and the container boundary do not both
// understand; the contract tests round-trip real resolver output through them.

export const CredentialSelectionSchema = z.object({
  agent: z.string(),
  credential: z.string().nullable(),
});

// The arrays are .readonly() so the persisted shape is interchangeable with
// the runtime CredentialScope type in BOTH directions — a resolver-produced
// scope can be written, and a parsed record can be handed to the container
// boundary — without anyone casting between two nearly-identical types.
const AgentEnvProjectionSchema = z.object({
  destinationName: z.string(),
  sourceNames: z.array(z.string()).readonly(),
});

// Closed set: an OAuth kind outside the audited projection table has no
// container mount, so a record naming one could never be executed.
const OAuthProjectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codex'), mountName: z.literal('codex') }),
  z.object({ kind: z.literal('gemini'), mountName: z.literal('gemini') }),
  z.object({ kind: z.literal('antigravity'), mountName: z.literal('gemini') }),
  z.object({ kind: z.literal('kimi'), mountName: z.literal('kimi') }),
  z.object({
    kind: z.literal('pi'),
    mountName: z.literal('pi'),
    provider: z.string(),
  }),
]);

// An ASSERTED zero-material scope, not "unscoped": every field is pinned to
// its empty value, so an empty scope can never carry material.
const EmptyCredentialScopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('empty'),
  agent: z.null(),
  runtimeFamily: z.null(),
  credential: z.null(),
  // Exactly the empty tuple. z.tuple([]).readonly() would infer
  // `readonly never[]`, which is assignable FROM the runtime type but not
  // back TO it, so a parsed empty scope could not be handed to the container
  // boundary without a cast.
  agentEnv: z.custom<readonly []>(
    (value) => Array.isArray(value) && value.length === 0,
    { message: 'an empty credential scope must carry no agent env' },
  ),
  geminiAuthType: z.null(),
  oauth: z.null(),
});

const LiveCredentialScopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('live'),
  agent: z.string(),
  runtimeFamily: z.string(),
  credential: z.string(),
  agentEnv: z.array(AgentEnvProjectionSchema).readonly(),
  geminiAuthType: z.enum(['gemini-api-key', 'oauth-personal']).nullable(),
  oauth: OAuthProjectionSchema.nullable(),
});

export const CredentialScopeSchema = z.discriminatedUnion('kind', [
  EmptyCredentialScopeSchema,
  LiveCredentialScopeSchema,
]);

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

// The durable container evidence a job carries: snake-case, and nullable in
// the ID it never recorded on older records. It deliberately embeds NO scope —
// the job's top-level credential_scope is the only persisted authority — and
// it is not a runnable lease. `leaseToJobContainerEvidence` and
// `liveLeaseFromJob` convert between this and the in-memory ContainerLease;
// preflight builds it only through this type, so the interface and the
// persisted shape cannot drift apart.
export interface JobContainerEvidence {
  readonly name: string;
  readonly id: string | null;
  readonly image_id: string | null;
  readonly mount_signature: string;
}

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
  // The one authoritative credential request, written in the INITIAL atomic
  // job.json and never patched afterwards: what was selected, what that
  // resolved to, and the evals HEAD it resolved against (Task 5 refuses to
  // execute if the checkout has since moved). The defaults exist ONLY so
  // records written before these fields parse — as null, never as a
  // fabricated scope. Every writer supplies all three explicitly; see the
  // kind-discriminated CreateJobRequest in jobs.ts.
  credential_selection: CredentialSelectionSchema.nullable().default(null),
  credential_scope: CredentialScopeSchema.nullable().default(null),
  credential_scope_source_evals_sha: z.string().nullable().default(null),
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
    // Supplied explicitly from the job's own scope: live provenance is
    // derived from the reread record after its evidence is committed, so this
    // cannot disagree with the job. The null default reads records written
    // before the field existed.
    credential_scope: CredentialScopeSchema.nullable().default(null),
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
  // Always null, written explicitly: an imported run predates this appliance
  // and received no bundle material through it. Defaulted for records written
  // before the field existed.
  credential_scope: CredentialScopeSchema.nullable().default(null),
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
