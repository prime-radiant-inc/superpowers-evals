import { join } from 'node:path';
import {
  type CommandResult,
  type CommandRunner,
  defaultCommandRunner,
} from '../agents/command-runner.ts';
import {
  type CredentialSelection,
  EMPTY_CREDENTIAL_SCOPE,
  type LiveCredentialScope,
} from '../credentials/scope.ts';
import {
  activeSupervisorExecEnvFile,
  buildContainer,
  type ContainerLease,
  credentialScopesEqual,
  leaseToJobContainerEvidence,
  reconcileScopedContainer,
  requireDockerExecEnvFile,
  runInLeasedContainer,
} from './container.ts';
import { buildLiveCredentialRequest } from './credential-request.ts';
import {
  retireScopedCredentialMaterial,
  type StagedCredentialMaterial,
  stageLiveCredentialMaterial,
  stageProbeCredentialMaterial,
} from './credential-scope.ts';
import { installEvalsDeps } from './deps.ts';
import { ApplianceError } from './errors.ts';
import { writePrivateText } from './fs.ts';
import {
  checkoutDetached,
  ensureCleanWorktree,
  fastForwardManagedRepo,
  fetchRepo,
  resolveSuperpowersRef,
} from './git.ts';
import { createJob, readJob, updateJob } from './jobs.ts';
import { withMutationLocks } from './locks.ts';
import { writeProvenance } from './provenance.ts';
import type {
  ApplianceCommandKind,
  JobContainerEvidence,
  JobRecord,
  JobStatus,
  LoadedApplianceConfig,
  LoadedApplianceStateConfig,
  RefSnapshot,
} from './types.ts';

export interface PreflightArgs {
  readonly loaded: LoadedApplianceConfig;
  readonly jobId: string;
  readonly superpowersRef: string;
  readonly runner?: CommandRunner;
}

export interface PrepareArgs {
  readonly loaded: LoadedApplianceConfig;
  readonly superpowersRef: string;
  readonly argv: readonly string[];
  readonly requester: {
    readonly agent: string | null;
    readonly thread?: string | null;
    readonly task?: string | null;
  };
  readonly runner?: CommandRunner;
  readonly jobId?: string;
}

/**
 * The PUBLIC evidence a preflight produces: what the job ran against. It
 * carries the durable container evidence only — no credential path, and no
 * second copy of the scope (the job's top-level credential_scope is the sole
 * authority).
 */
export interface PreflightResult {
  readonly refs: RefSnapshot;
  readonly credential_bundle: {
    readonly name: 'blessed';
    readonly bundle_id: string;
  };
  readonly container: JobContainerEvidence;
  readonly tool_versions_path: string;
  readonly tool_versions_text: string;
  readonly provenance_path: string;
}

/**
 * The PRIVATE result of a live preflight, for runWorker alone. `lease` is the
 * exact value `evidence.container` was derived from, not a separate authority,
 * and `supervisorExecEnvFile` is a host path that must never be spread into
 * CLI output, job JSON, or provenance — it crosses only into the live Quorum
 * exec's `docker exec --env-file`.
 */
export interface LivePreflightResult {
  readonly evidence: PreflightResult;
  readonly lease: ContainerLease;
  readonly supervisorExecEnvFile: string;
}

function repos(loaded: LoadedApplianceStateConfig) {
  return [
    loaded.config.evals.path,
    loaded.config.superpowers.path,
    loaded.config.gauntlet.path,
  ];
}

const TERMINAL_JOB_STATUSES = new Set<JobStatus>([
  'done',
  'failed',
  'cancelled',
  'lost',
  'quarantined',
]);

function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

function failJob(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
  error: ApplianceError,
): void {
  updateJob(loaded, jobId, (current) => {
    if (isTerminalJobStatus(current.status)) {
      return current;
    }
    return {
      ...current,
      status: 'failed',
      finished_at: new Date().toISOString(),
      result: { exit_code: 1, summary: error.message },
      error: {
        code: error.code,
        step: error.step,
        message: error.message,
      },
    };
  });
}

function stableError(error: unknown, step = 'preflight'): ApplianceError {
  if (error instanceof ApplianceError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApplianceError('config_invalid', step, message);
}

function appendCleanupFailure(
  original: ApplianceError,
  message: string,
): ApplianceError {
  return new ApplianceError(
    original.code,
    original.step,
    `${original.message}; ${message}`,
  );
}

function cleanupPreflightLease(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
  lease: ContainerLease,
  error: unknown,
): ApplianceError {
  const stable = stableError(error);
  let removal: CommandResult;
  try {
    removal = runner.run('docker', ['rm', '-f', lease.id]);
  } catch (cleanupError) {
    const message =
      cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
    return appendCleanupFailure(
      stable,
      `cleanup of leased container ${lease.id} failed: ${message}`,
    );
  }
  if (removal.status !== 0) {
    return appendCleanupFailure(
      stable,
      `cleanup of leased container ${lease.id} failed with exit ${removal.status}`,
    );
  }
  try {
    retireScopedCredentialMaterial(loaded);
  } catch (cleanupError) {
    const message =
      cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
    return appendCleanupFailure(
      stable,
      `credential-material cleanup after removing leased container ${lease.id} failed: ${message}`,
    );
  }
  return stable;
}

function withPreflightLeaseCleanup<T>(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
  lease: ContainerLease,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    throw cleanupPreflightLease(loaded, runner, lease, error);
  }
}

function jobToolVersionsPath(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
): string {
  return join(loaded.paths.jobs, jobId, 'evals-tool-versions.txt');
}

export function postflightDirtyCheck(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
  runner: CommandRunner,
): ApplianceError | null {
  try {
    for (const repo of repos(loaded)) {
      ensureCleanWorktree(repo, runner);
    }
    return null;
  } catch (error) {
    const stable = stableError(error, 'postflight');
    updateJob(loaded, jobId, (current) => ({
      ...current,
      status: 'quarantined',
      finished_at: current.finished_at ?? new Date().toISOString(),
      result: {
        exit_code: current.result.exit_code,
        summary: `postflight dirty check failed: ${stable.message}`,
      },
      error: {
        code: stable.code,
        step: stable.step,
        message: stable.message,
      },
    }));
    return stable;
  }
}

// The single (agent, credential) cell a live job was born asserting, read back
// off its own record. Records written before the credential fields existed
// read back with a null scope, and an empty scope is an assertion of NO
// material — neither can deliver a credential to an agent, and there is no
// legacy full-bundle fallback to widen into. Both fail closed, before any
// repo, container, or bundle work.
interface LivePlan {
  readonly selection: CredentialSelection;
  readonly scope: LiveCredentialScope;
  readonly sourceEvalsSha: string;
}

function livePlanForJob(job: JobRecord): LivePlan {
  if (job.kind !== 'run' && job.kind !== 'run-all') {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${job.job_id} is a ${job.kind} job; only run and run-all jobs execute live`,
    );
  }
  const scope = job.credential_scope;
  if (scope === null) {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${job.job_id} (${job.kind}) has no credential scope; it predates scoped credential delivery and cannot be executed — submit a new job`,
    );
  }
  if (scope.kind !== 'live') {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${job.job_id} (${job.kind}) asserts an empty credential scope, which delivers no credential material; refusing to execute it`,
    );
  }
  const selection = job.credential_selection;
  const sourceEvalsSha = job.credential_scope_source_evals_sha;
  if (selection === null || sourceEvalsSha === null) {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${job.job_id} (${job.kind}) carries a live scope with no selection or source SHA to re-verify it against; refusing to execute it`,
    );
  }
  return { selection, scope, sourceEvalsSha };
}

// Submission read the corpus at one commit; preflight then fast-forwards it.
// Executing a stale scope would deliver material for a cell the current corpus
// no longer describes, so the SHA must still match AND the selection must
// still resolve to exactly the persisted scope. Both run before any credential
// value is evaluated and before Docker.
function requireFreshCredentialScope(
  loaded: LoadedApplianceConfig,
  jobId: string,
  plan: LivePlan,
  evalsResolvedSha: string,
): void {
  if (plan.sourceEvalsSha !== evalsResolvedSha) {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${jobId} resolved its credential scope against evals checkout ${plan.sourceEvalsSha}, but the fast-forwarded evals checkout is ${evalsResolvedSha}; submit a new job`,
    );
  }
  const recomputed = buildLiveCredentialRequest(
    loaded.config.evals.path,
    plan.selection,
    evalsResolvedSha,
  ).scope;
  if (!credentialScopesEqual(plan.scope, recomputed)) {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${jobId} persists a credential scope for agent '${plan.selection.agent}' credential '${plan.selection.credential ?? '(default)'}' that does not match the scope recomputed from the evals corpus at ${evalsResolvedSha}; submit a new job`,
    );
  }
}

interface ProbedPreflight {
  readonly refs: RefSnapshot;
  readonly probeLease: ContainerLease;
  readonly toolVersionsPath: string;
  readonly toolVersionsText: string;
}

/**
 * Everything both preflight kinds do, in the one binding order: sync the
 * managed repos (reconciling the evals checkout's deps from the frozen
 * lockfile), gate a live plan's freshness, require the docker capability
 * scoped delivery depends on, build, then run the probes inside an
 * ASSERTED-EMPTY container. No credential material exists at any point here.
 */
async function preflightThroughEmptyProbe(
  args: PreflightArgs,
  plan: LivePlan | null,
): Promise<ProbedPreflight> {
  const runner = args.runner ?? defaultCommandRunner;
  const loaded = args.loaded;

  updateJob(loaded, args.jobId, (current) => ({
    ...current,
    status: 'preflighting',
    error: null,
  }));

  for (const path of repos(loaded)) {
    ensureCleanWorktree(path, runner);
  }

  fetchRepo(loaded.config.evals.path, loaded.config.evals.remote, runner);
  fetchRepo(
    loaded.config.superpowers.path,
    loaded.config.superpowers.remote,
    runner,
  );
  fetchRepo(loaded.config.gauntlet.path, loaded.config.gauntlet.remote, runner);

  const evalsResolvedSha = fastForwardManagedRepo(
    {
      path: loaded.config.evals.path,
      remote: loaded.config.evals.remote,
      ref: loaded.config.evals.ref,
      label: 'evals',
    },
    runner,
  );
  // node_modules must match the just-synced lockfile before anything builds
  // or executes from this checkout (PRI-2833).
  installEvalsDeps(loaded.config.evals.path, runner);
  const gauntletBuiltSha = fastForwardManagedRepo(
    {
      path: loaded.config.gauntlet.path,
      remote: loaded.config.gauntlet.remote,
      ref: loaded.config.gauntlet.ref,
      label: 'gauntlet',
    },
    runner,
  );
  const superpowersResolvedSha = resolveSuperpowersRef(
    {
      path: loaded.config.superpowers.path,
      remote: loaded.config.superpowers.remote,
    },
    args.superpowersRef,
    runner,
  );
  checkoutDetached(
    loaded.config.superpowers.path,
    superpowersResolvedSha,
    runner,
  );

  const refs: RefSnapshot = {
    superpowers_requested_ref: args.superpowersRef,
    superpowers_resolved_sha: superpowersResolvedSha,
    evals_ref: loaded.config.evals.ref,
    evals_resolved_sha: evalsResolvedSha,
    gauntlet_ref: loaded.config.gauntlet.ref,
    gauntlet_built_sha: gauntletBuiltSha,
  };

  if (plan !== null) {
    requireFreshCredentialScope(loaded, args.jobId, plan, evalsResolvedSha);
  }

  requireDockerExecEnvFile(runner);
  buildContainer(loaded, runner);

  const probeLease = reconcileScopedContainer(
    loaded,
    runner,
    stageProbeCredentialMaterial(loaded),
  );
  return withPreflightLeaseCleanup(loaded, runner, probeLease, () => {
    const toolVersions = runInLeasedContainer(
      loaded,
      runner,
      probeLease,
      ['evals-tool-versions'],
      'tool_versions_failed',
      'evals-tool-versions failed',
    );
    const toolVersionsPath = jobToolVersionsPath(loaded, args.jobId);
    writePrivateText(toolVersionsPath, toolVersions.stdout);

    runInLeasedContainer(
      loaded,
      runner,
      probeLease,
      ['quorum', 'check'],
      'quorum_check_failed',
      'quorum check failed',
    );

    return {
      refs,
      probeLease,
      toolVersionsPath,
      toolVersionsText: toolVersions.stdout,
    };
  });
}

/**
 * Commit the job's durable evidence, then derive provenance from the reread
 * record. Evidence first is what makes a provenance fault recoverable: the
 * job already states what it ran against, so a retry heals only the derived
 * file. The authoritative scope is never part of this patch.
 */
function commitPreflightEvidence(
  loaded: LoadedApplianceConfig,
  jobId: string,
  probed: ProbedPreflight,
  lease: ContainerLease,
): PreflightResult {
  const credentialBundle = {
    name: 'blessed' as const,
    bundle_id: loaded.bundle.bundle_id,
  };
  const container = leaseToJobContainerEvidence(lease);
  updateJob(loaded, jobId, (current) => ({
    ...current,
    refs: probed.refs,
    credential_bundle: credentialBundle,
    container,
    error: null,
  }));

  const provenance = writeProvenance(loaded, jobId, {
    path: probed.toolVersionsPath,
    text: probed.toolVersionsText,
  });

  return {
    refs: probed.refs,
    credential_bundle: credentialBundle,
    container,
    tool_versions_path: probed.toolVersionsPath,
    tool_versions_text: probed.toolVersionsText,
    provenance_path: provenance,
  };
}

/**
 * Preflight one live job: probe empty, then recreate the container around
 * exactly this job's credential generation and return the lease the worker
 * must execute inside. The probe container is downed before the live
 * generation is activated and mounted.
 */
export async function preflightLiveJob(
  args: PreflightArgs,
): Promise<LivePreflightResult> {
  const runner = args.runner ?? defaultCommandRunner;
  try {
    const plan = livePlanForJob(readJob(args.loaded, args.jobId));
    const probed = await preflightThroughEmptyProbe(args, plan);
    const staged: StagedCredentialMaterial = withPreflightLeaseCleanup(
      args.loaded,
      runner,
      probed.probeLease,
      () => stageLiveCredentialMaterial(args.loaded, plan.scope),
    );
    const lease = reconcileScopedContainer(args.loaded, runner, staged);
    return withPreflightLeaseCleanup(args.loaded, runner, lease, () => {
      return {
        evidence: commitPreflightEvidence(
          args.loaded,
          args.jobId,
          probed,
          lease,
        ),
        lease,
        supervisorExecEnvFile: activeSupervisorExecEnvFile(args.loaded),
      };
    });
  } catch (error) {
    const stable = stableError(error);
    try {
      failJob(args.loaded, args.jobId, stable);
    } catch {}
    throw stable;
  }
}

// The credential triple a prepare record is born with, re-proved on the way
// back in. prepare resolves no cell: it asserts zero material, selects no
// (agent, credential), and pins no source SHA. A resumed record that claims
// kind 'prepare' while carrying any of those is not a prepare record — it
// predates scoped delivery or was edited underneath the job — and probing it
// would run the whole preflight against a shape prepare never produces.
function requirePrepareRecord(job: JobRecord): void {
  if (job.kind !== 'prepare') {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${job.job_id} is a ${job.kind} job; prepare probes only prepare jobs`,
    );
  }
  const scope = job.credential_scope;
  if (scope === null || scope.kind !== 'empty') {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${job.job_id} (prepare) does not assert an empty credential scope; refusing to probe it`,
    );
  }
  if (
    job.credential_selection !== null ||
    job.credential_scope_source_evals_sha !== null
  ) {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${job.job_id} (prepare) carries a credential selection or source SHA, which prepare never resolves; refusing to probe it`,
    );
  }
}

// prepare stops at the empty probe: its evidence comes from the probe lease,
// and no credential material is ever staged, activated, or mounted.
async function preflightPrepareJob(
  args: PreflightArgs,
): Promise<PreflightResult> {
  try {
    requirePrepareRecord(readJob(args.loaded, args.jobId));
    const probed = await preflightThroughEmptyProbe(args, null);
    return withPreflightLeaseCleanup(
      args.loaded,
      args.runner ?? defaultCommandRunner,
      probed.probeLease,
      () =>
        commitPreflightEvidence(
          args.loaded,
          args.jobId,
          probed,
          probed.probeLease,
        ),
    );
  } catch (error) {
    const stable = stableError(error);
    try {
      failJob(args.loaded, args.jobId, stable);
    } catch {}
    throw stable;
  }
}

export async function prepare(args: PrepareArgs): Promise<PreflightResult> {
  const job =
    args.jobId === undefined
      ? createJob(args.loaded, {
          kind: 'prepare',
          superpowersRef: args.superpowersRef,
          argv: args.argv,
          requester: args.requester,
          // prepare asserts zero credential material and pins no source SHA:
          // it resolves no cell.
          credentialSelection: null,
          credentialScope: EMPTY_CREDENTIAL_SCOPE,
          credentialScopeSourceEvalsSha: null,
        })
      : readJob(args.loaded, args.jobId);
  const command: ApplianceCommandKind = job.kind;

  try {
    return await withMutationLocks(
      args.loaded,
      job.job_id,
      command,
      async () => {
        const preflightArgs: PreflightArgs = {
          loaded: args.loaded,
          jobId: job.job_id,
          superpowersRef: args.superpowersRef,
        };
        const result = await preflightPrepareJob(
          args.runner === undefined
            ? preflightArgs
            : { ...preflightArgs, runner: args.runner },
        );
        const postflightError = postflightDirtyCheck(
          args.loaded,
          job.job_id,
          args.runner ?? defaultCommandRunner,
        );
        if (postflightError !== null) {
          throw postflightError;
        }
        updateJob(args.loaded, job.job_id, (current) => ({
          ...current,
          status: 'done',
          finished_at: new Date().toISOString(),
          result: { exit_code: 0, summary: 'preflight ok' },
        }));
        return result;
      },
    );
  } catch (error) {
    const stable = stableError(error);
    try {
      failJob(args.loaded, job.job_id, stable);
    } catch {}
    throw stable;
  }
}
