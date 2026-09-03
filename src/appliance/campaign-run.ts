import { userInfo } from 'node:os';
import type { CommandRunner } from '../agents/command-runner.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import {
  ContainerAttemptSpawner,
  realDockerWait,
} from '../campaign/container-spawner.ts';
import { type CampaignRunOptions, campaignRun } from '../cli/campaign.ts';
import { RealClock } from '../scheduler/clock.ts';
import { readBundleEnvForProjection } from './credential-scope.ts';
import { ApplianceError } from './errors.ts';
import { readJob, updateJob } from './jobs.ts';
import { acquireLock, type LockHandle } from './locks.ts';
import { appendLog } from './process.ts';
import type { JobRecord, LoadedApplianceConfig } from './types.ts';

export const CAMPAIGN_IMAGE_REF = 'superpowers-evals:local';
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function imageDigestOf(runner: CommandRunner, imageRef: string): string {
  const result = runner.run('docker', [
    'image',
    'inspect',
    imageRef,
    '--format',
    '{{.Id}}',
  ]);
  let value = result.stdout;
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.endsWith('\r')) value = value.slice(0, -1);
  if (result.status !== 0 || !IMAGE_DIGEST_RE.test(value)) {
    throw new ApplianceError(
      'config_invalid',
      'image',
      `worker image ${imageRef} is missing or has a non-canonical digest`,
    );
  }
  return value;
}

export interface RunCampaignWorkerDeps {
  readonly runCampaign?: (
    campaignDir: string,
    options: CampaignRunOptions,
  ) => Promise<number>;
}

function lifecycleAlreadySettled(status: JobRecord['status']): boolean {
  return (
    status === 'stopping' ||
    status === 'done' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'lost' ||
    status === 'quarantined'
  );
}

function failureRecord(error: unknown): {
  readonly code: ApplianceError['code'];
  readonly step: string;
  readonly message: string;
} {
  return {
    code: error instanceof ApplianceError ? error.code : 'config_invalid',
    step: error instanceof ApplianceError ? error.step : 'campaign-worker',
    message: error instanceof Error ? error.message : String(error),
  };
}

function markFailed(
  loaded: LoadedApplianceConfig,
  jobId: string,
  error: unknown,
): void {
  try {
    updateJob(loaded, jobId, (current) => {
      if (lifecycleAlreadySettled(current.status)) {
        return current;
      }
      return {
        ...current,
        status: 'failed',
        finished_at: new Date().toISOString(),
        result: {
          exit_code: null,
          summary: 'campaign journal is the outcome authority',
        },
        error: failureRecord(error),
      };
    });
  } catch {
    // The original worker error is the useful failure when state persistence
    // itself is unavailable.
  }
}

function markReady(loaded: LoadedApplianceConfig, jobId: string): void {
  updateJob(loaded, jobId, (current) => {
    if (lifecycleAlreadySettled(current.status)) {
      return current;
    }
    return {
      ...current,
      status: 'running',
      started_at: current.started_at ?? new Date().toISOString(),
      error: null,
      process: current.process ?? {
        host_pid: process.pid,
        host_pgid: process.pid,
        container_pid: null,
        container_pgid: null,
      },
    };
  });
}

export async function runCampaignWorker(
  loaded: LoadedApplianceConfig,
  jobId: string,
  runner: CommandRunner = defaultCommandRunner,
  deps: RunCampaignWorkerDeps = {},
): Promise<void> {
  let runLock: LockHandle | null = null;
  try {
    const job = readJob(loaded, jobId);
    if (job.kind !== 'campaign-run' || job.campaign === null) {
      throw new ApplianceError(
        'job_not_running',
        'campaign-worker',
        `${jobId} is not a campaign-run job`,
      );
    }
    if (job.campaign.image_ref !== CAMPAIGN_IMAGE_REF) {
      throw new ApplianceError(
        'config_invalid',
        'image',
        `campaign job ${jobId} names unsupported worker image ${job.campaign.image_ref}`,
      );
    }

    const currentDigest = imageDigestOf(runner, CAMPAIGN_IMAGE_REF);
    if (currentDigest !== job.campaign.image_digest) {
      throw new ApplianceError(
        'config_invalid',
        'image',
        `worker image moved between submission and execution (${job.campaign.image_digest} -> ${currentDigest})`,
      );
    }

    runLock = acquireLock({
      loaded,
      name: 'run.lock',
      jobId,
      command: job.kind,
      refs: null,
    });

    const who = userInfo();
    const spawner = new ContainerAttemptSpawner({
      runner,
      clock: new RealClock(),
      stream: {
        write: (chunk) => {
          appendLog(readJob(loaded, jobId).artifacts.stdout_log, chunk);
        },
      },
      campaignId: job.campaign.campaign_id,
      campaignDir: job.campaign.campaign_dir,
      imageRef: job.campaign.image_ref,
      imageDigest: job.campaign.image_digest,
      evalsSha: job.campaign.evals_sha,
      bundleDir: loaded.config.credential_bundle.path,
      uid: who.uid,
      gid: who.gid,
      dockerWait: realDockerWait,
    });
    const options: CampaignRunOptions = {
      spawner,
      containerStop: spawner,
      credentialEnvReader: (names) =>
        readBundleEnvForProjection(loaded.config.credential_bundle.path, names),
      onReady: () => markReady(loaded, jobId),
    };
    const runCampaignFn = deps.runCampaign ?? campaignRun;
    const exitCode = await runCampaignFn(job.campaign.campaign_dir, options);
    updateJob(loaded, jobId, (current) => {
      if (lifecycleAlreadySettled(current.status)) {
        return current;
      }
      return {
        ...current,
        status: exitCode === 0 ? 'done' : 'failed',
        finished_at: new Date().toISOString(),
        result: {
          exit_code: exitCode,
          summary: 'campaign journal is the outcome authority',
        },
        error:
          exitCode === 0
            ? null
            : {
                code: 'config_invalid',
                step: 'campaign-worker',
                message: `campaign controller exited ${exitCode}`,
              },
      };
    });
  } catch (error) {
    markFailed(loaded, jobId, error);
    throw error;
  } finally {
    runLock?.release();
  }
}
