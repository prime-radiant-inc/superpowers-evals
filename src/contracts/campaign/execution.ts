import { z } from 'zod';
import { FiniteNumberSchema } from '../finite.ts';
import { CampaignIdentitySchema } from './campaign.ts';
import {
  ExperimentIdentitySchema,
  IdSchema,
  Sha256Schema,
  TimestampSchema,
} from './experiment.ts';

// Paths in evidence are rooted by the authenticated publisher, never by the caller.
export const RelativeArtifactPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      !/^[a-zA-Z]:/.test(path) &&
      path
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    'artifact path must be a relative canonical path',
  );
export const AbsoluteRuntimePathSchema = z.string().refine(
  (path) =>
    path.startsWith('/') &&
    path !== '/' &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path
      .slice(1)
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..'),
  'runtime path must be an absolute canonical private path',
);
export const ArtifactRefSchema = z
  .object({
    path: RelativeArtifactPathSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export const CampaignEvidenceRefSchema = ArtifactRefSchema;
export type CampaignEvidenceRef = z.infer<typeof CampaignEvidenceRefSchema>;
export function observedSchema<T extends z.ZodTypeAny>(value: T) {
  return z.union([
    z.object({ value, artifact: ArtifactRefSchema }).strict(),
    z
      .object({
        missing: z.enum(['absent', 'invalid', 'unpriced', 'not_recorded']),
      })
      .strict(),
  ]);
}
export type Observed<T> =
  | { value: T; artifact: ArtifactRef }
  | { missing: 'absent' | 'invalid' | 'unpriced' | 'not_recorded' };
export const ProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    birth: IdSchema,
    boot_id: IdSchema,
  })
  .strict();
export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>;
export const ExecutionStartSchema = ExperimentIdentitySchema.extend({
  start_id: IdSchema,
  launcher: ProcessIdentitySchema,
  claimed_at: TimestampSchema,
}).strict();
export type ExecutionStart = z.infer<typeof ExecutionStartSchema>;
export const HostCampaignClaimSchema = ExecutionStartSchema.extend({
  campaign_dir: AbsoluteRuntimePathSchema,
}).strict();
export type HostCampaignClaim = z.infer<typeof HostCampaignClaimSchema>;
export const PublicRuntimeEnvSchema = z
  .object({
    HOME: AbsoluteRuntimePathSchema,
    TMPDIR: z.literal('/run/quorum/attempt'),
    TMUX_TMPDIR: z.literal('/run/quorum/attempt'),
    XDG_CONFIG_HOME: AbsoluteRuntimePathSchema,
    XDG_CACHE_HOME: AbsoluteRuntimePathSchema,
    XDG_STATE_HOME: AbsoluteRuntimePathSchema,
    QUORUM_COVERED_BY_LIVE_SPEND_LOCK: z.literal('1'),
    QUORUM_GRADER_SOURCE_MODE: z.literal('appliance-scoped'),
    QUORUM_ATTEMPT_DIR: AbsoluteRuntimePathSchema,
    QUORUM_SUBJECT_FILE: z.literal('/run/quorum/subject.env'),
    QUORUM_GRADER_FILE: z.literal('/run/quorum/grader.env'),
    QUORUM_ATTEMPT_AUTHORITY_FILE: AbsoluteRuntimePathSchema,
  })
  .strict();
export const AttemptRuntimeSpecSchema = z
  .object({
    image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    credential_projection: z
      .object({ path: AbsoluteRuntimePathSchema, sha256: Sha256Schema })
      .strict(),
    command: IdSchema,
    entrypoint: z.array(z.string().min(1)),
    labels: z
      .object({
        'quorum.campaign_id': IdSchema,
        'quorum.attempt_id': IdSchema,
        'quorum.evals_sha': z.string().regex(/^[0-9a-f]{40}$/),
        'quorum.image_digest': z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .strict(),
    args: z.array(z.string()),
    cwd: AbsoluteRuntimePathSchema,
    user: z
      .object({
        uid: z.number().int().positive(),
        gid: z.number().int().positive(),
      })
      .strict(),
    mounts: z.array(
      z
        .object({
          source: AbsoluteRuntimePathSchema,
          target: AbsoluteRuntimePathSchema,
          mode: z.enum(['ro', 'rw']),
        })
        .strict(),
    ),
    // Public path values are frozen; credential values remain in mounted private files.
    public_env: PublicRuntimeEnvSchema,
    init: z.literal(true),
    restart: z.literal('no'),
    pid_namespace: z.literal('private'),
    ipc_namespace: z.literal('private'),
    privileged: z.literal(false),
    no_new_privileges: z.literal(true),
    tmpfs_bytes: z.number().int().positive(),
    max_time_s: FiniteNumberSchema.positive(),
    graceful_shutdown_s: z.literal(5),
  })
  .strict();
export type AttemptRuntimeSpec = z.infer<typeof AttemptRuntimeSpecSchema>;
export const AttemptIntentSchema = z
  .object({
    identity: CampaignIdentitySchema,
    primary_block_id: IdSchema,
    attempt_number: z.number().int().positive(),
    output_root: AbsoluteRuntimePathSchema,
    container_name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
    runtime_spec_digest: Sha256Schema,
    runtime_spec: AttemptRuntimeSpecSchema,
  })
  .strict();
export type AttemptIntent = z.infer<typeof AttemptIntentSchema>;
export const BlockActivationSchema = z
  .object({
    block_id: IdSchema,
    primary_block_id: IdSchema,
    reserve_id: IdSchema.nullable(),
    predecessor_block_id: IdSchema.nullable(),
    attempts: z.array(AttemptIntentSchema).min(1),
  })
  .strict();
export type BlockActivation = z.infer<typeof BlockActivationSchema>;
export const ContainerIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const VerifiedStoppedSchema = z
  .object({
    execution_attempt_id: IdSchema,
    container_id: ContainerIdSchema.nullable(),
    proof: z.enum(['inspected_stopped', 'verified_absent', 'never_created']),
    observed_at: TimestampSchema,
  })
  .strict()
  .superRefine((stopped, ctx) => {
    if (
      (stopped.proof === 'never_created' && stopped.container_id !== null) ||
      (stopped.proof === 'inspected_stopped' && stopped.container_id === null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'death proof and container identity disagree',
      });
  });
export type VerifiedStopped = z.infer<typeof VerifiedStoppedSchema>;
export const ValidityCauseSchema = z.enum([
  'contention',
  'exposure',
  'skew',
  'missing_telemetry',
  'provenance',
]);
export type ValidityCause = z.infer<typeof ValidityCauseSchema>;
export const ReplacementCauseSchema = z.enum([
  'grader_rate_limited',
  'subject_rate_limited',
  'subject_spawn_failed',
  'subject_crashed',
  'grader_crashed',
  'setup_failed',
  'capture_failed',
  'checks_crashed',
  'contention',
  'exposure',
  'skew',
  'missing_telemetry',
]);
export type ReplacementCause = z.infer<typeof ReplacementCauseSchema>;
export const AttemptObservationSchema = z
  .object({
    execution_attempt_id: IdSchema,
    stopped: VerifiedStoppedSchema,
    outcome: z.enum(['pass', 'fail', 'indeterminate']),
    failure_class: z.enum(['evidence', 'instrument', 'aborted']),
    cause: IdSchema.nullable(),
    artifacts: z.array(ArtifactRefSchema),
    evidence_missing: IdSchema.nullable(),
    validity: z.enum(['valid', 'invalid', 'unknown']),
  })
  .strict()
  .superRefine((observation, ctx) => {
    if (
      observation.outcome !== 'indeterminate' &&
      observation.artifacts.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message: 'pass or fail requires supporting behavior evidence',
      });
    }
  });
export type AttemptObservation = z.infer<typeof AttemptObservationSchema>;
const AccountingSchema = z
  .object({
    execution_attempt_id: IdSchema,
    stopped: VerifiedStoppedSchema,
    artifacts: z.array(ArtifactRefSchema),
    evidence_missing: IdSchema.nullable(),
  })
  .strict();
export type AccountingObservation = z.infer<typeof AccountingSchema>;
function transition<T extends string, P extends z.ZodTypeAny>(
  type: T,
  payload: P,
) {
  return z
    .object({
      transition_id: IdSchema,
      at: TimestampSchema,
      type: z.literal(type),
      payload,
    })
    .strict();
}
export const CampaignTransitionSchema = z.discriminatedUnion('type', [
  transition('registered', ExperimentIdentitySchema),
  transition('started', ExecutionStartSchema),
  transition(
    'controller_bound',
    z
      .object({ start_id: IdSchema, controller: ProcessIdentitySchema })
      .strict(),
  ),
  transition('block_activated', BlockActivationSchema),
  transition(
    'block_replaced',
    z
      .object({
        activation: BlockActivationSchema,
        reason: ReplacementCauseSchema,
      })
      .strict(),
  ),
  transition(
    'runtime_bound',
    z
      .object({
        execution_attempt_id: IdSchema,
        container_id: ContainerIdSchema,
        runtime_spec_digest: Sha256Schema,
      })
      .strict(),
  ),
  transition(
    'runtime_started',
    z
      .object({
        execution_attempt_id: IdSchema,
        observed_at: TimestampSchema,
        receipt: z.literal('docker_start_succeeded'),
      })
      .strict(),
  ),
  transition(
    'attempt_observed',
    z
      .object({
        observation: AttemptObservationSchema,
        excluded_block: z
          .object({ block_id: IdSchema, reason: ValidityCauseSchema })
          .strict()
          .nullable(),
      })
      .strict(),
  ),
  transition('accounting_observed', AccountingSchema),
  transition(
    'block_validated',
    z
      .object({
        block_id: IdSchema,
        evidence_refs: z.array(CampaignEvidenceRefSchema).min(1),
      })
      .strict(),
  ),
  transition(
    'block_invalidated',
    z
      .object({
        block_id: IdSchema,
        reason: ValidityCauseSchema,
        evidence_refs: z.array(CampaignEvidenceRefSchema).min(1),
      })
      .strict(),
  ),
  transition(
    'block_exhausted',
    z
      .object({ primary_block_id: IdSchema, reason: ReplacementCauseSchema })
      .strict(),
  ),
  transition(
    'ended',
    z
      .object({
        outcome: z.enum(['completed', 'cancelled', 'interrupted']),
        reason: IdSchema,
        cancel_intent: CampaignEvidenceRefSchema.nullable(),
      })
      .strict(),
  ),
  transition(
    'termination_verified',
    z
      .object({
        start_id: IdSchema,
        stopped: z.array(VerifiedStoppedSchema),
        process_evidence: z.array(CampaignEvidenceRefSchema).min(1),
      })
      .strict(),
  ),
]);
export type CampaignTransition = z.infer<typeof CampaignTransitionSchema>;
export type PreparedExecution = { intent: AttemptIntent };
export type BoundExecution = PreparedExecution & { container_id: string };
export type StopObservation =
  | { kind: 'dead'; stopped: VerifiedStopped }
  | { kind: 'unresolved'; reason: string };
export type OwnedRuntimeObservation =
  | { kind: 'absent' }
  | {
      kind: 'matching-created' | 'matching-running' | 'matching-stopped';
      container_id: string;
      runtime_spec_digest: string;
    }
  | { kind: 'unresolved'; reason: string };
export interface AttemptMonitor {
  onStopped(callback: (stopped: VerifiedStopped) => void): void;
  onMonitorFailure(callback: (reason: string) => void): void;
}
export interface AttemptRuntime {
  create(prepared: PreparedExecution): Promise<BoundExecution>;
  start(bound: BoundExecution): Promise<AttemptMonitor>;
  inspectOwned(prepared: PreparedExecution): Promise<OwnedRuntimeObservation>;
  stop(bound: BoundExecution, graceSeconds: number): Promise<StopObservation>;
}
