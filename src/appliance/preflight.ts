import { join } from 'node:path';
import {
  type CommandRunner,
  defaultCommandRunner,
} from '../agents/command-runner.ts';
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
import type {
  ApplianceCommandKind,
  LoadedApplianceConfig,
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

function repos(loaded: LoadedApplianceConfig) {
  return [
    loaded.config.evals.path,
    loaded.config.superpowers.path,
    loaded.config.gauntlet.path,
  ];
}

function failJob(
  loaded: LoadedApplianceConfig,
  jobId: string,
  error: ApplianceError,
): void {
  updateJob(loaded, jobId, (current) => ({
    ...current,
    status: 'failed',
    finished_at: new Date().toISOString(),
    result: { exit_code: 1, summary: error.message },
    error: {
      code: error.code,
      step: error.step,
      message: error.message,
    },
  }));
}

function stableError(error: unknown): ApplianceError {
  if (error instanceof ApplianceError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApplianceError('config_invalid', 'preflight', message);
}

function jobToolVersionsPath(
  loaded: LoadedApplianceConfig,
  jobId: string,
): string {
  return join(loaded.paths.jobs, jobId, 'evals-tool-versions.txt');
}

export async function preflightForJob(
  args: PreflightArgs,
): Promise<PreflightResult> {
  const runner = args.runner ?? defaultCommandRunner;

  try {
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

    const { code_mounts_read_only: _codeMountsReadOnly, ...jobContainer } =
      resultBase.container;
    updateJob(args.loaded, args.jobId, (current) => ({
      ...current,
      refs,
      credential_bundle: resultBase.credential_bundle,
      container: jobContainer,
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
  const job =
    args.jobId === undefined
      ? createJob(args.loaded, {
          kind: 'prepare',
          superpowersRef: args.superpowersRef,
          argv: args.argv,
          requester: args.requester,
        })
      : readJob(args.loaded, args.jobId);
  const command: ApplianceCommandKind = job.kind;

  return withMutationLocks(args.loaded, job.job_id, command, async () => {
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
      updateJob(args.loaded, job.job_id, (current) => ({
        ...current,
        status: 'done',
        finished_at: new Date().toISOString(),
        result: { exit_code: 0, summary: 'preflight ok' },
      }));
    }
    return result;
  });
}
