import { join } from 'node:path';
import {
  type CommandRunner,
  defaultCommandRunner,
} from '../agents/command-runner.ts';
import { EMPTY_CREDENTIAL_SCOPE } from '../credentials/scope.ts';
import {
  buildContainer,
  containerMountSignature,
  inspectContainerIdentity,
  reconcileContainer,
  runInContainer,
  statusContainer,
} from './container.ts';
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
import { assertScopedCredentialCutover } from './scoped-cutover.ts';
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

export interface PreflightResult {
  readonly refs: RefSnapshot;
  readonly credential_bundle: {
    readonly name: 'blessed';
    readonly bundle_id: string;
  };
  readonly container: {
    readonly name: string;
    readonly id: string | null;
    readonly image_id: string | null;
    readonly mount_signature: string;
    readonly code_mounts_read_only: boolean;
  };
  readonly tool_versions_path: string;
  readonly tool_versions_text: string;
  readonly provenance_path: string;
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

// A live job may only preflight against a resolved live scope. Records
// written before the credential fields existed read back with a null scope,
// and an empty scope is an assertion of NO material — neither can deliver a
// credential to an agent, and there is no legacy full-bundle fallback to
// widen into. Both fail closed here, before any repo, container, or bundle
// work. prepare is exempt: its probes legitimately assert an empty scope.
function assertLiveScopeForExecution(job: JobRecord): void {
  if (job.kind !== 'run' && job.kind !== 'run-all') {
    return;
  }
  if (job.credential_scope === null) {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${job.job_id} (${job.kind}) has no credential scope; it predates scoped credential delivery and cannot be executed — submit a new job`,
    );
  }
  if (job.credential_scope.kind !== 'live') {
    throw new ApplianceError(
      'config_invalid',
      'preflight',
      `job ${job.job_id} (${job.kind}) asserts an empty credential scope, which delivers no credential material; refusing to execute it`,
    );
  }
}

export async function preflightForJob(
  args: PreflightArgs,
): Promise<PreflightResult> {
  const runner = args.runner ?? defaultCommandRunner;

  try {
    assertLiveScopeForExecution(readJob(args.loaded, args.jobId));

    updateJob(args.loaded, args.jobId, (current) => ({
      ...current,
      status: 'preflighting',
      error: null,
    }));

    for (const path of repos(args.loaded)) {
      ensureCleanWorktree(path, runner);
    }

    fetchRepo(
      args.loaded.config.evals.path,
      args.loaded.config.evals.remote,
      runner,
    );
    fetchRepo(
      args.loaded.config.superpowers.path,
      args.loaded.config.superpowers.remote,
      runner,
    );
    fetchRepo(
      args.loaded.config.gauntlet.path,
      args.loaded.config.gauntlet.remote,
      runner,
    );

    const evalsResolvedSha = fastForwardManagedRepo(
      {
        path: args.loaded.config.evals.path,
        remote: args.loaded.config.evals.remote,
        ref: args.loaded.config.evals.ref,
        label: 'evals',
      },
      runner,
    );
    const gauntletBuiltSha = fastForwardManagedRepo(
      {
        path: args.loaded.config.gauntlet.path,
        remote: args.loaded.config.gauntlet.remote,
        ref: args.loaded.config.gauntlet.ref,
        label: 'gauntlet',
      },
      runner,
    );
    const superpowersResolvedSha = resolveSuperpowersRef(
      {
        path: args.loaded.config.superpowers.path,
        remote: args.loaded.config.superpowers.remote,
      },
      args.superpowersRef,
      runner,
    );
    checkoutDetached(
      args.loaded.config.superpowers.path,
      superpowersResolvedSha,
      runner,
    );

    const refs: RefSnapshot = {
      superpowers_requested_ref: args.superpowersRef,
      superpowers_resolved_sha: superpowersResolvedSha,
      evals_ref: args.loaded.config.evals.ref,
      evals_resolved_sha: evalsResolvedSha,
      gauntlet_ref: args.loaded.config.gauntlet.ref,
      gauntlet_built_sha: gauntletBuiltSha,
    };

    buildContainer(args.loaded, runner);
    reconcileContainer(args.loaded, runner);
    statusContainer(args.loaded, runner);
    const containerIdentity = inspectContainerIdentity(args.loaded, runner);

    const toolVersions = runInContainer(
      args.loaded,
      runner,
      ['evals-tool-versions'],
      'tool_versions_failed',
      'evals-tool-versions failed',
    );
    const toolVersionsPath = jobToolVersionsPath(args.loaded, args.jobId);
    writePrivateText(toolVersionsPath, toolVersions.stdout);

    runInContainer(
      args.loaded,
      runner,
      ['quorum', 'check'],
      'quorum_check_failed',
      'quorum check failed',
    );

    const resultBase = {
      refs,
      credential_bundle: {
        name: 'blessed' as const,
        bundle_id: args.loaded.bundle.bundle_id,
      },
      container: {
        name: args.loaded.config.container.name,
        id: containerIdentity.id,
        image_id: containerIdentity.image_id,
        mount_signature: containerMountSignature(args.loaded),
        code_mounts_read_only: false,
      },
      tool_versions_path: toolVersionsPath,
      tool_versions_text: toolVersions.stdout,
    };

    const job = readJob(args.loaded, args.jobId);
    const provenancePath = writeProvenance(
      args.loaded,
      job,
      resultBase,
      job.command.argv,
    );

    // The durable half of the container record: read-only mount evidence is
    // provenance-only, and this shape carries no scope of its own.
    const containerEvidence: JobContainerEvidence = {
      name: resultBase.container.name,
      id: resultBase.container.id,
      image_id: resultBase.container.image_id,
      mount_signature: resultBase.container.mount_signature,
    };
    updateJob(args.loaded, args.jobId, (current) => ({
      ...current,
      refs,
      credential_bundle: resultBase.credential_bundle,
      container: containerEvidence,
      artifacts: {
        ...current.artifacts,
        provenance: provenancePath,
      },
      error: null,
    }));

    return {
      ...resultBase,
      provenance_path: provenancePath,
    };
  } catch (error) {
    const stable = stableError(error);
    try {
      failJob(args.loaded, args.jobId, stable);
    } catch {}
    throw stable;
  }
}

export async function prepare(args: PrepareArgs): Promise<PreflightResult> {
  // TEMPORARY (Tasks 2-4): the production prepare path is frozen until the
  // scoped credential cutover lands. The guard runs before job creation and
  // lock acquisition; Task 5 deletes it with the complete caller cutover.
  assertScopedCredentialCutover('prepare');
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
        const result = await preflightForJob(
          args.runner === undefined
            ? preflightArgs
            : { ...preflightArgs, runner: args.runner },
        );
        if (job.kind === 'prepare') {
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
        }
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
