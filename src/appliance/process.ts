import { type ChildProcess, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../agents/command-runner.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import { BatchHeaderSchema } from '../contracts/batch.ts';
import { FinalVerdictSchema } from '../contracts/verdict.ts';
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
const CANCEL_GRACE_MS = 120_000;
const CANCEL_POLL_INTERVAL_MS = 1_000;

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
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface LiveCommandResult extends CommandResult {
  readonly process: LiveProcessInfo;
}

interface ParsedArtifacts {
  readonly batchId: string | null;
  readonly runId: string | null;
}

export interface CancelOptions {
  readonly graceMs?: number;
  readonly pollIntervalMs?: number;
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
    const nextContainerPid = containerPid ?? existingContainerPid;
    const nextContainerPgid = containerPid ?? existingContainerPgid;
    const hasSignalTarget = hostPgid !== null || nextContainerPgid !== null;
    return {
      ...current,
      status:
        current.status === 'preflighting' && hasSignalTarget
          ? 'running'
          : current.status,
      process: {
        host_pid: hostPid,
        host_pgid: hostPgid,
        container_pid: nextContainerPid,
        container_pgid: nextContainerPgid,
      },
    };
  });
}

function hasTerminalArtifact(
  loaded: LoadedApplianceConfig,
  artifacts: ParsedArtifacts,
): boolean {
  if (artifacts.batchId !== null) {
    const batchPath = join(
      loaded.config.container.results_root,
      'batches',
      artifacts.batchId,
      'batch.json',
    );
    if (existsSync(batchPath)) {
      try {
        const header = BatchHeaderSchema.parse(
          JSON.parse(readFileSync(batchPath, 'utf8')) as unknown,
        );
        if (header.finished_at !== null) {
          return true;
        }
      } catch {}
    }
  }
  if (artifacts.runId !== null) {
    const verdictPath = join(
      loaded.config.container.results_root,
      artifacts.runId,
      'verdict.json',
    );
    if (existsSync(verdictPath)) {
      try {
        FinalVerdictSchema.parse(
          JSON.parse(readFileSync(verdictPath, 'utf8')) as unknown,
        );
        return true;
      } catch {}
    }
  }
  return false;
}

function runArtifactStopped(
  loaded: LoadedApplianceConfig,
  runId: string,
): boolean {
  const verdictPath = join(
    loaded.config.container.results_root,
    runId,
    'verdict.json',
  );
  if (!existsSync(verdictPath)) {
    return false;
  }
  try {
    const verdict = FinalVerdictSchema.parse(
      JSON.parse(readFileSync(verdictPath, 'utf8')) as unknown,
    );
    return verdict.error?.stage === 'stopped';
  } catch {
    return false;
  }
}

function cancellationTerminal(
  loaded: LoadedApplianceConfig,
  artifacts: ParsedArtifacts,
): {
  readonly status: 'cancelled' | 'done';
  readonly exitCode: number;
  readonly summary: string;
} | null {
  if (artifacts.batchId !== null && hasTerminalArtifact(loaded, artifacts)) {
    return { status: 'cancelled', exitCode: 130, summary: 'cancelled' };
  }
  if (artifacts.runId !== null && hasTerminalArtifact(loaded, artifacts)) {
    return runArtifactStopped(loaded, artifacts.runId)
      ? { status: 'cancelled', exitCode: 130, summary: 'cancelled' }
      : { status: 'done', exitCode: 0, summary: 'live command completed' };
  }
  return null;
}

function jobArtifacts(job: JobRecord): ParsedArtifacts {
  return {
    batchId: job.artifacts.batch_id,
    runId: job.artifacts.run_id,
  };
}

function runIdentity(job: JobRecord): {
  readonly scenario: string;
  readonly codingAgent: string;
} | null {
  if (job.kind !== 'run') {
    return null;
  }
  const argv = job.command.argv;
  if (argv[0] !== 'quorum' || argv[1] !== 'run') {
    return null;
  }
  const scenario = argv[2];
  const agentFlag = argv.indexOf('--coding-agent');
  const codingAgent = agentFlag >= 0 ? argv[agentFlag + 1] : undefined;
  if (scenario === undefined || codingAgent === undefined) {
    return null;
  }
  return { scenario: basename(scenario), codingAgent };
}

function discoverRunArtifact(
  loaded: LoadedApplianceConfig,
  job: JobRecord,
): string | null {
  const identity = runIdentity(job);
  if (identity === null || !existsSync(loaded.config.container.results_root)) {
    return null;
  }
  const startedAt = Date.parse(job.started_at ?? job.created_at);
  const earliestMtime = Number.isFinite(startedAt) ? startedAt - 5_000 : 0;
  const candidates: { id: string; mtimeMs: number }[] = [];

  for (const entry of readdirSync(loaded.config.container.results_root, {
    withFileTypes: true,
  })) {
    if (
      !entry.isDirectory() ||
      entry.name === 'batches' ||
      entry.name.startsWith('.')
    ) {
      continue;
    }
    const verdictPath = join(
      loaded.config.container.results_root,
      entry.name,
      'verdict.json',
    );
    if (!existsSync(verdictPath)) {
      continue;
    }
    const stat = statSync(verdictPath);
    if (stat.mtimeMs < earliestMtime) {
      continue;
    }
    try {
      const verdict = FinalVerdictSchema.parse(
        JSON.parse(readFileSync(verdictPath, 'utf8')) as unknown,
      );
      if (
        verdict.scenario !== undefined &&
        verdict.scenario !== identity.scenario
      ) {
        continue;
      }
      if (
        verdict.coding_agent !== undefined &&
        verdict.coding_agent !== identity.codingAgent
      ) {
        continue;
      }
      candidates.push({ id: entry.name, mtimeMs: stat.mtimeMs });
    } catch {}
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.id ?? null;
}

function currentArtifacts(
  loaded: LoadedApplianceConfig,
  jobId: string,
): ParsedArtifacts {
  const job = readJob(loaded, jobId);
  const artifacts = jobArtifacts(job);
  if (artifacts.runId !== null || job.kind !== 'run') {
    return artifacts;
  }
  const discoveredRunId = discoverRunArtifact(loaded, job);
  if (discoveredRunId === null) {
    return artifacts;
  }
  return jobArtifacts(
    updateJob(loaded, jobId, (current) => ({
      ...current,
      artifacts: {
        ...current.artifacts,
        run_id: discoveredRunId,
      },
    })),
  );
}

async function waitForTerminalArtifact(
  loaded: LoadedApplianceConfig,
  jobId: string,
  graceMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (true) {
    if (hasTerminalArtifact(loaded, currentArtifacts(loaded, jobId))) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    const waitMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    await sleep(waitMs);
  }
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
  const terminalArtifact = hasTerminalArtifact(loaded, artifacts);
  if (current.status === 'cancelled') {
    return { status: 'cancelled', summary: 'cancelled' };
  }
  if (current.status === 'lost' && terminalArtifact) {
    return (
      cancellationTerminal(loaded, artifacts) ?? {
        status: 'cancelled',
        summary: 'cancelled',
      }
    );
  }
  if (current.status === 'stopping') {
    const terminal = cancellationTerminal(loaded, artifacts);
    return terminal !== null
      ? { status: terminal.status, summary: terminal.summary }
      : {
          status: 'lost',
          summary:
            'cancelled signal sent but terminal artifact was not observed',
        };
  }
  if (result.status === 0 || terminalArtifact) {
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

function hasContainerProcessGroup(job: JobRecord): boolean {
  return (job.process?.container_pgid ?? null) !== null;
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

function appendLog(path: string, chunk: string): void {
  if (chunk !== '') {
    appendFileSync(path, chunk);
  }
}

function interruptHostProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGINT');
    return;
  }
  try {
    process.kill(-pid, 'SIGINT');
  } catch {
    child.kill('SIGINT');
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {}
  }, 250).unref();
}

function containerProcessGroupAlive(
  loaded: LoadedApplianceConfig,
  pgid: number,
  runner: CommandRunner,
): boolean {
  const result = runner.run(
    evalsContainerPath(loaded),
    execContainerArgs(loaded, ['bash', '-lc', `kill -0 -${pgid}`]),
  );
  return result.status === 0;
}

function hostProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalHostProcessGroup(pgid: number): boolean {
  try {
    process.kill(-pgid, 'SIGINT');
    return true;
  } catch {
    return false;
  }
}

function jobProcessGroupAlive(
  loaded: LoadedApplianceConfig,
  job: JobRecord,
  runner: CommandRunner,
): boolean {
  const containerPgid = job.process?.container_pgid ?? null;
  if (containerPgid !== null) {
    return containerProcessGroupAlive(loaded, containerPgid, runner);
  }
  const hostPgid = job.process?.host_pgid ?? null;
  return hostPgid !== null && hostProcessGroupAlive(hostPgid);
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
  let callbackError: unknown = null;
  const emitStdout = (chunk: string): void => {
    try {
      args.onStdout?.(chunk);
    } catch (error) {
      callbackError ??= error;
    }
  };
  const emitStderr = (chunk: string): void => {
    try {
      args.onStderr?.(chunk);
    } catch (error) {
      callbackError ??= error;
    }
  };
  const withCallbackError = (stderr: string): string => {
    if (callbackError === null) {
      return stderr;
    }
    const message =
      callbackError instanceof Error
        ? callbackError.message
        : String(callbackError);
    return stderr + (stderr === '' ? '' : '\n') + message;
  };

  if (args.runner !== undefined) {
    const processInfo = { host_pid: process.pid, host_pgid: process.pid };
    try {
      await args.onSpawn?.(processInfo);
    } catch (error) {
      callbackError ??= error;
      return {
        status: null,
        stdout: '',
        stderr: withCallbackError(''),
        process: processInfo,
      };
    }
    const result = args.runner.run(args.command, args.args, args.options);
    if (result.stdout !== '') {
      emitStdout(result.stdout);
    }
    if (result.stderr !== '') {
      emitStderr(result.stderr);
    }
    return {
      ...result,
      status: callbackError === null ? result.status : null,
      stderr: withCallbackError(result.stderr),
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
        callbackError ??= error;
        interruptHostProcessGroup(child);
      });

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      emitStdout(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      emitStderr(text);
    });
    child.on('error', async (error) => {
      await onSpawnDone;
      resolve({
        status: null,
        stdout,
        stderr: withCallbackError(
          stderr + (stderr === '' ? '' : '\n') + error.message,
        ),
        process: processInfo,
      });
    });
    child.on('close', async (status) => {
      await onSpawnDone;
      resolve({
        status: callbackError === null ? status : null,
        stdout,
        stderr: withCallbackError(stderr),
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
    let observedStdout = '';
    const streamStdout = (chunk: string): void => {
      observedStdout += chunk;
      appendLog(readJob(loaded, jobId).artifacts.stdout_log, chunk);
      updateArtifacts(loaded, jobId, parseArtifacts(observedStdout));
    };
    const streamStderr = (chunk: string): void => {
      appendLog(readJob(loaded, jobId).artifacts.stderr_log, chunk);
    };
    const launchResult = await launchLiveCommand({
      command,
      args,
      ...(runner === undefined ? {} : { runner }),
      onStdout: streamStdout,
      onStderr: streamStderr,
      onSpawn: async (processInfo) => {
        updateProcess(loaded, jobId, processInfo, null);
        const containerPid = await pollContainerPid(
          loaded,
          jobId,
          runner === undefined ? PID_POLL_TIMEOUT_MS : 0,
        );
        if (containerPid === null) {
          throw new ApplianceError(
            'config_invalid',
            'live-command',
            'container process id was not captured',
          );
        }
        updateProcess(loaded, jobId, processInfo, containerPid);
      },
    });

    if (runner !== undefined) {
      const containerPid = await pollContainerPid(loaded, jobId, 0);
      updateProcess(loaded, jobId, launchResult.process, containerPid);
    }

    updateArtifacts(loaded, jobId, parseArtifacts(launchResult.stdout));
    const artifacts = currentArtifacts(loaded, jobId);
    if (preflight !== null) {
      writeArtifactProvenance(loaded, jobId, preflight);
    }

    const current = readJob(loaded, jobId);
    const terminalArtifact = hasTerminalArtifact(loaded, artifacts);
    if (!hasContainerProcessGroup(current)) {
      markTerminal(
        loaded,
        jobId,
        'failed',
        launchResult,
        'container process id was not captured',
      );
    } else if (!isTerminal(current.status) || terminalArtifact) {
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
  options: CancelOptions = {},
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
  const hostPgid = job.process?.host_pgid ?? null;
  if (containerPgid === null && hostPgid === null) {
    throw new ApplianceError(
      'job_not_running',
      'cancel',
      `${jobId} has no recorded process group`,
    );
  }

  let signalAccepted = job.status === 'stopping';
  if (job.status === 'running') {
    let interrupted = false;
    if (containerPgid !== null) {
      const result = runner.run(
        evalsContainerPath(loaded),
        execContainerArgs(loaded, [
          'bash',
          '-lc',
          `kill -INT -${containerPgid}`,
        ]),
      );
      interrupted = result.status === 0;
    } else if (hostPgid !== null) {
      interrupted = signalHostProcessGroup(hostPgid);
    }

    if (!interrupted && jobProcessGroupAlive(loaded, job, runner)) {
      const message = 'cancel signal failed while process group is still alive';
      updateJob(loaded, jobId, (current) => ({
        ...current,
        status: 'running',
        error: {
          code: 'cancel_failed',
          step: 'cancel',
          message,
        },
      }));
      throw new ApplianceError('cancel_failed', 'cancel', message);
    }
    signalAccepted = interrupted;
  }

  updateJob(loaded, jobId, (current) => ({
    ...current,
    status: 'stopping',
    error: null,
    result: signalAccepted
      ? current.result
      : {
          exit_code: null,
          summary: 'process group disappeared before cancel signal completed',
        },
  }));

  const sawTerminalArtifact = await waitForTerminalArtifact(
    loaded,
    jobId,
    options.graceMs ?? CANCEL_GRACE_MS,
    options.pollIntervalMs ?? CANCEL_POLL_INTERVAL_MS,
  );
  if (!sawTerminalArtifact) {
    const stillAlive = jobProcessGroupAlive(
      loaded,
      readJob(loaded, jobId),
      runner,
    );
    if (stillAlive) {
      return updateJob(loaded, jobId, (current) => ({
        ...current,
        status: 'stopping',
        result: {
          exit_code: null,
          summary: 'cancelled signal sent; waiting for terminal artifact',
        },
        error: null,
      }));
    }
  }

  const observedTerminal =
    sawTerminalArtifact === true
      ? cancellationTerminal(loaded, currentArtifacts(loaded, jobId))
      : null;
  const terminalStatus: JobStatus = observedTerminal?.status ?? 'lost';
  const summary =
    observedTerminal?.summary ??
    'cancelled signal sent but terminal artifact was not observed';
  const exitCode = observedTerminal?.exitCode ?? 130;

  return updateJob(loaded, jobId, (current) => ({
    ...current,
    status: terminalStatus,
    finished_at: new Date().toISOString(),
    result: {
      exit_code: exitCode,
      summary,
    },
    error:
      terminalStatus === 'lost'
        ? {
            code: 'cancel_failed',
            step: 'cancel',
            message: summary,
          }
        : null,
  }));
}
