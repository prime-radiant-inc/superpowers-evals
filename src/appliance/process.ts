import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../agents/command-runner.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import { envSnapshot } from '../env.ts';
import { evalsContainerPath, execContainerArgs } from './container.ts';
import { ApplianceError } from './errors.ts';
import { ensureCleanWorktree } from './git.ts';
import { readJob, updateJob } from './jobs.ts';
import { acquireLock, type LockHandle } from './locks.ts';
import { type PreflightResult, preflightForJob } from './preflight.ts';
import { writeProvenance } from './provenance.ts';
import type { JobRecord, JobStatus, LoadedApplianceConfig } from './types.ts';

const PID_DIR = '/workspace/evals/results/.appliance-pids';
const PID_POLL_INTERVAL_MS = 100;
const PID_POLL_TIMEOUT_MS = 10_000;

export interface LiveProcessInfo {
  readonly host_pid: number | null;
  readonly host_pgid: number | null;
}

export interface LiveCommandArgs {
  readonly command: string;
  readonly args: readonly string[];
  readonly runner?: CommandRunner;
  readonly options?: CommandOptions;
  readonly onSpawn?: (processInfo: LiveProcessInfo) => Promise<void> | void;
}

export interface LiveCommandResult extends CommandResult {
  readonly process: LiveProcessInfo;
}

interface ParsedArtifacts {
  readonly batchId: string | null;
  readonly runId: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function managedRepos(loaded: LoadedApplianceConfig): string[] {
  return [
    loaded.config.evals.path,
    loaded.config.superpowers.path,
    loaded.config.gauntlet.path,
  ];
}

function stableError(error: unknown, step = 'worker'): ApplianceError {
  if (error instanceof ApplianceError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApplianceError('config_invalid', step, message);
}

function terminalStatuses(): ReadonlySet<JobStatus> {
  return new Set(['done', 'failed', 'cancelled', 'lost', 'quarantined']);
}

function isTerminal(status: JobStatus): boolean {
  return terminalStatuses().has(status);
}

function pidFilePath(loaded: LoadedApplianceConfig, jobId: string): string {
  return join(
    loaded.config.container.results_root,
    '.appliance-pids',
    `${jobId}.pid`,
  );
}

function containerPidPath(jobId: string): string {
  return `${PID_DIR}/${jobId}.pid`;
}

async function pollContainerPid(
  loaded: LoadedApplianceConfig,
  jobId: string,
  timeoutMs: number,
): Promise<number | null> {
  const path = pidFilePath(loaded, jobId);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8').trim();
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(PID_POLL_INTERVAL_MS);
  }
}

function updateProcess(
  loaded: LoadedApplianceConfig,
  jobId: string,
  processInfo: LiveProcessInfo,
  containerPid: number | null,
): void {
  updateJob(loaded, jobId, (current) => {
    const hostPid =
      processInfo.host_pid ?? current.process?.host_pid ?? process.pid;
    const hostPgid =
      processInfo.host_pgid ?? current.process?.host_pgid ?? hostPid;
    const existingContainerPid = current.process?.container_pid ?? null;
    const existingContainerPgid = current.process?.container_pgid ?? null;
    return {
      ...current,
      process: {
        host_pid: hostPid,
        host_pgid: hostPgid,
        container_pid: containerPid ?? existingContainerPid,
        container_pgid: containerPid ?? existingContainerPgid,
      },
    };
  });
}

function appendLogs(job: JobRecord, result: CommandResult): void {
  if (result.stdout !== '') {
    appendFileSync(job.artifacts.stdout_log, result.stdout);
  }
  if (result.stderr !== '') {
    appendFileSync(job.artifacts.stderr_log, result.stderr);
  }
}

function artifactExists(
  loaded: LoadedApplianceConfig,
  artifacts: ParsedArtifacts,
): boolean {
  if (
    artifacts.batchId !== null &&
    existsSync(
      join(loaded.config.container.results_root, 'batches', artifacts.batchId),
    )
  ) {
    return true;
  }
  if (
    artifacts.runId !== null &&
    existsSync(join(loaded.config.container.results_root, artifacts.runId))
  ) {
    return true;
  }
  return false;
}

function parseArtifacts(stdout: string): ParsedArtifacts {
  const batchFromArtifact = stdout.match(
    /^artifacts:\s+\S*results\/batches\/([A-Za-z0-9_.-]+)/m,
  )?.[1];
  const batchFromLine = stdout.match(
    /\bbatch\s+(batch-\d{8}T\d{6}Z-[0-9a-fA-F]{4})\b/,
  )?.[1];
  const runFromLine = stdout.match(/^run-id:\s+([^\s]+)/m)?.[1];
  const runFromArtifact = stdout.match(
    /^artifacts:\s+\S*results\/(?!batches\/)([A-Za-z0-9_.-]+)/m,
  )?.[1];

  return {
    batchId: batchFromArtifact ?? batchFromLine ?? null,
    runId: runFromLine ?? runFromArtifact ?? null,
  };
}

function updateArtifacts(
  loaded: LoadedApplianceConfig,
  jobId: string,
  artifacts: ParsedArtifacts,
): JobRecord {
  if (artifacts.batchId === null && artifacts.runId === null) {
    return readJob(loaded, jobId);
  }
  return updateJob(loaded, jobId, (current) => ({
    ...current,
    artifacts: {
      ...current.artifacts,
      batch_id: artifacts.batchId ?? current.artifacts.batch_id,
      run_id: artifacts.runId ?? current.artifacts.run_id,
    },
  }));
}

function liveStatus(
  loaded: LoadedApplianceConfig,
  result: LiveCommandResult,
  artifacts: ParsedArtifacts,
  current: JobRecord,
): {
  status: JobStatus;
  summary: string;
} {
  if (current.status === 'cancelled') {
    return { status: 'cancelled', summary: 'cancelled' };
  }
  if (current.status === 'stopping') {
    return { status: 'cancelled', summary: 'cancelled' };
  }
  if (result.status === 0 || artifactExists(loaded, artifacts)) {
    return { status: 'done', summary: 'live command completed' };
  }
  if (result.status === null) {
    return {
      status: 'lost',
      summary: 'live command lost before terminal artifact',
    };
  }
  return {
    status: 'failed',
    summary: `live command exited ${result.status}`,
  };
}

function markTerminal(
  loaded: LoadedApplianceConfig,
  jobId: string,
  status: JobStatus,
  result: LiveCommandResult,
  summary: string,
): JobRecord {
  return updateJob(loaded, jobId, (current) => ({
    ...current,
    status,
    finished_at: new Date().toISOString(),
    result: { exit_code: result.status, summary },
    error:
      status === 'failed' || status === 'lost'
        ? {
            code: 'config_invalid',
            step: 'live-command',
            message: summary,
          }
        : null,
  }));
}

function markFailed(
  loaded: LoadedApplianceConfig,
  jobId: string,
  error: ApplianceError,
): void {
  try {
    const current = readJob(loaded, jobId);
    if (isTerminal(current.status)) {
      return;
    }
    updateJob(loaded, jobId, (job) => ({
      ...job,
      status: 'failed',
      finished_at: new Date().toISOString(),
      result: { exit_code: 1, summary: error.message },
      error: {
        code: error.code,
        step: error.step,
        message: error.message,
      },
    }));
  } catch {}
}

function postflightDirtyCheck(
  loaded: LoadedApplianceConfig,
  jobId: string,
  runner: CommandRunner,
): void {
  try {
    for (const repo of managedRepos(loaded)) {
      ensureCleanWorktree(repo, runner);
    }
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
  }
}

function writeArtifactProvenance(
  loaded: LoadedApplianceConfig,
  jobId: string,
  preflight: PreflightResult,
): void {
  const job = readJob(loaded, jobId);
  writeProvenance(loaded, job, preflight, job.command.argv);
}

export function liveCommandArgs(
  loaded: LoadedApplianceConfig,
  jobId: string,
  argv: readonly string[],
): string[] {
  const script = [
    'set -euo pipefail',
    'pid_path=$1',
    'shift',
    'mkdir -p "$(dirname "$pid_path")"',
    'setsid bash -lc \'echo "$$" > "$1"; shift; exec "$@"\' appliance-live "$pid_path" "$@"',
  ].join('\n');

  return execContainerArgs(loaded, [
    'bash',
    '-lc',
    script,
    'appliance-live',
    containerPidPath(jobId),
    ...argv,
  ]);
}

export async function launchLiveCommand(
  args: LiveCommandArgs,
): Promise<LiveCommandResult> {
  if (args.runner !== undefined) {
    const processInfo = { host_pid: process.pid, host_pgid: process.pid };
    const result = args.runner.run(args.command, args.args, args.options);
    return {
      ...result,
      process: processInfo,
    };
  }

  return new Promise((resolve) => {
    const child = spawn(args.command, [...args.args], {
      cwd: args.options?.cwd,
      detached: true,
      env:
        args.options?.env === undefined ? undefined : { ...args.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const processInfo = {
      host_pid: child.pid ?? null,
      host_pgid: child.pid ?? null,
    };
    const onSpawnDone = Promise.resolve()
      .then(() => args.onSpawn?.(processInfo))
      .catch((error) => {
        stderr +=
          (stderr === '' ? '' : '\n') +
          (error instanceof Error ? error.message : String(error));
      });

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', async (error) => {
      await onSpawnDone;
      resolve({
        status: null,
        stdout,
        stderr: stderr + (stderr === '' ? '' : '\n') + error.message,
        process: processInfo,
      });
    });
    child.on('close', async (status) => {
      await onSpawnDone;
      resolve({
        status,
        stdout,
        stderr,
        process: processInfo,
      });
    });
    if (args.options?.input !== undefined) {
      child.stdin?.write(args.options.input);
    }
    child.stdin?.end();
  });
}

export function spawnDetachedWorker(
  loaded: LoadedApplianceConfig,
  jobId: string,
): void {
  const processModule = new URL('./process.ts', import.meta.url).href;
  const configModule = new URL('./config.ts', import.meta.url).href;
  const script = `
const { loadConfig } = await import(${JSON.stringify(configModule)});
const { runWorker } = await import(${JSON.stringify(processModule)});
const jobId = Bun.env.EVALS_APPLIANCE_JOB_ID;
if (jobId === undefined) {
  throw new Error('EVALS_APPLIANCE_JOB_ID is required');
}
const loaded = loadConfig(Bun.env.EVALS_APPLIANCE_CONFIG);
await runWorker(loaded, jobId);
`;
  const child = spawn(process.execPath, ['--eval', script], {
    cwd: loaded.config.evals.path,
    detached: true,
    env: {
      ...envSnapshot(),
      EVALS_APPLIANCE_CONFIG: loaded.configPath,
      EVALS_APPLIANCE_JOB_ID: jobId,
    },
    stdio: 'ignore',
  });
  child.unref();
}

export async function runWorker(
  loaded: LoadedApplianceConfig,
  jobId: string,
  runner?: CommandRunner,
): Promise<void> {
  let runLock: LockHandle | null = null;
  let syncLock: LockHandle | null = null;
  let preflight: PreflightResult | null = null;

  try {
    const job = readJob(loaded, jobId);
    runLock = acquireLock({
      loaded,
      name: 'run.lock',
      jobId,
      command: job.kind,
      refs: job.refs,
    });
    syncLock = acquireLock({
      loaded,
      name: 'sync.lock',
      jobId,
      command: job.kind,
      refs: job.refs,
    });

    preflight = await preflightForJob({
      loaded,
      jobId,
      superpowersRef: job.request.superpowers_ref,
      ...(runner === undefined ? {} : { runner }),
    });
    syncLock.release();
    syncLock = null;

    const liveJob = updateJob(loaded, jobId, (current) => ({
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
    }));

    mkdirSync(dirname(pidFilePath(loaded, jobId)), { recursive: true });
    const command = evalsContainerPath(loaded);
    const args = liveCommandArgs(loaded, jobId, liveJob.command.argv);
    const launchResult = await launchLiveCommand({
      command,
      args,
      ...(runner === undefined ? {} : { runner }),
      onSpawn: async (processInfo) => {
        const containerPid = await pollContainerPid(
          loaded,
          jobId,
          PID_POLL_TIMEOUT_MS,
        );
        updateProcess(loaded, jobId, processInfo, containerPid);
      },
    });

    if (runner !== undefined) {
      const containerPid = await pollContainerPid(loaded, jobId, 0);
      updateProcess(loaded, jobId, launchResult.process, containerPid);
    }

    appendLogs(readJob(loaded, jobId), launchResult);
    const artifacts = parseArtifacts(launchResult.stdout);
    updateArtifacts(loaded, jobId, artifacts);
    if (preflight !== null) {
      writeArtifactProvenance(loaded, jobId, preflight);
    }

    const current = readJob(loaded, jobId);
    if (!isTerminal(current.status)) {
      const terminal = liveStatus(loaded, launchResult, artifacts, current);
      markTerminal(
        loaded,
        jobId,
        terminal.status,
        launchResult,
        terminal.summary,
      );
    }

    postflightDirtyCheck(loaded, jobId, runner ?? defaultCommandRunner);
  } catch (error) {
    const stable = stableError(error);
    markFailed(loaded, jobId, stable);
    throw stable;
  } finally {
    syncLock?.release();
    runLock?.release();
  }
}

export async function cancelJob(
  loaded: LoadedApplianceConfig,
  jobId: string,
  runner: CommandRunner,
): Promise<JobRecord> {
  const job = readJob(loaded, jobId);
  if (job.status !== 'running' && job.status !== 'stopping') {
    throw new ApplianceError(
      'job_not_running',
      'cancel',
      `${jobId} is ${job.status}`,
    );
  }
  const containerPgid = job.process?.container_pgid ?? null;
  if (containerPgid === null) {
    throw new ApplianceError(
      'job_not_running',
      'cancel',
      `${jobId} has no recorded container process group`,
    );
  }

  updateJob(loaded, jobId, (current) => ({
    ...current,
    status: 'stopping',
    error: null,
  }));

  const result = runner.run(
    evalsContainerPath(loaded),
    execContainerArgs(loaded, ['bash', '-lc', `kill -INT -${containerPgid}`]),
  );

  if (result.status !== 0) {
    const message = `cancel failed: status=${result.status ?? 'null'} stderr=${
      result.stderr.trim() || '<empty>'
    }`;
    updateJob(loaded, jobId, (current) => ({
      ...current,
      error: {
        code: 'cancel_failed',
        step: 'cancel',
        message,
      },
    }));
    throw new ApplianceError('cancel_failed', 'cancel', message);
  }

  return updateJob(loaded, jobId, (current) => ({
    ...current,
    status: 'cancelled',
    finished_at: new Date().toISOString(),
    result: {
      exit_code: 130,
      summary: 'cancelled',
    },
    error: null,
  }));
}
