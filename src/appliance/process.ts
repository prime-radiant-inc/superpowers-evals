import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
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
import type { CredentialSelection } from '../credentials/scope.ts';
import { envSnapshot } from '../env.ts';
import {
  type ParsedRunAllArgv,
  parseRunAllArgv,
  RunAllArgvError,
} from '../run-all/options.ts';
import {
  type ContainerLease,
  credentialScopesEqual,
  evalsContainerPath,
  leaseToJobContainerEvidence,
  liveLeaseFromJob,
  type RecordedContainerIdentity,
  runRecordedContainerLifecycle,
  scopedExecContainerArgs,
} from './container.ts';
import { ApplianceError } from './errors.ts';
import { mkdirPrivate } from './fs.ts';
import { readJob, updateJob } from './jobs.ts';
import { acquireLock, type LockHandle, updateLockRefs } from './locks.ts';
import {
  type LivePreflightResult,
  postflightDirtyCheck,
  preflightLiveJob,
} from './preflight.ts';
import { writeProvenance } from './provenance.ts';
import type {
  JobRecord,
  JobStatus,
  LoadedApplianceConfig,
  LoadedApplianceStateConfig,
} from './types.ts';

const PID_DIR = '/workspace/evals/results/.appliance-pids';
const PID_POLL_INTERVAL_MS = 100;
const PID_POLL_TIMEOUT_MS = 10_000;
const LIVE_COMPLETION_POLL_INTERVAL_MS = 1_000;
const LIVE_COMPLETION_POST_EXIT_GRACE_MS = 30_000;
const CANCEL_GRACE_MS = 120_000;
const CANCEL_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TRUSTED_PATH = '/usr/local/bin:/usr/bin:/bin';
const DETACHED_SPAWN_FAILURE_MESSAGE = 'detached worker spawn failed';
const DETACHED_UNSAFE_PID_MESSAGE =
  'detached worker did not return a safe host pid';

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
  readonly processKill?: ProcessKill;
}

export type ProcessKill = (
  pid: number,
  signal?: NodeJS.Signals | number,
) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function pidFilePath(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
): string {
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
  loaded: LoadedApplianceStateConfig,
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
  loaded: LoadedApplianceStateConfig,
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
  loaded: LoadedApplianceStateConfig,
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
  loaded: LoadedApplianceStateConfig,
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
  loaded: LoadedApplianceStateConfig,
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
  loaded: LoadedApplianceStateConfig,
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

function discoverBatchArtifact(
  loaded: LoadedApplianceStateConfig,
  job: JobRecord,
): string | null {
  if (job.kind !== 'run-all') {
    return null;
  }
  const batchRoot = join(loaded.config.container.results_root, 'batches');
  if (!existsSync(batchRoot)) {
    return null;
  }
  const startedAt = Date.parse(job.started_at ?? job.created_at);
  const earliestStartedAt = Number.isFinite(startedAt) ? startedAt - 5_000 : 0;
  const candidates: { id: string; mtimeMs: number }[] = [];

  for (const entry of readdirSync(batchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const headerPath = join(batchRoot, entry.name, 'batch.json');
    if (!existsSync(headerPath)) {
      continue;
    }
    const stat = statSync(headerPath);
    try {
      const header = BatchHeaderSchema.parse(
        JSON.parse(readFileSync(headerPath, 'utf8')) as unknown,
      );
      const batchStartedAt = Date.parse(header.started_at);
      if (
        Number.isFinite(batchStartedAt) &&
        batchStartedAt < earliestStartedAt
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
  loaded: LoadedApplianceStateConfig,
  jobId: string,
): ParsedArtifacts {
  const job = readJob(loaded, jobId);
  const artifacts = jobArtifacts(job);
  if (artifacts.runId !== null || artifacts.batchId !== null) {
    return artifacts;
  }
  const discovered = {
    runId: discoverRunArtifact(loaded, job),
    batchId: discoverBatchArtifact(loaded, job),
  };
  if (discovered.runId === null && discovered.batchId === null) {
    return artifacts;
  }
  return jobArtifacts(
    updateJob(loaded, jobId, (current) => ({
      ...current,
      artifacts: {
        ...current.artifacts,
        run_id: discovered.runId ?? current.artifacts.run_id,
        batch_id: discovered.batchId ?? current.artifacts.batch_id,
      },
    })),
  );
}

async function waitForTerminalArtifact(
  loaded: LoadedApplianceStateConfig,
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
  loaded: LoadedApplianceStateConfig,
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
  loaded: LoadedApplianceStateConfig,
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
  if (terminalArtifact) {
    return { status: 'done', summary: 'live command completed' };
  }
  if (result.status === 0) {
    return {
      status: 'lost',
      summary: 'live command exited before terminal artifact',
    };
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
  loaded: LoadedApplianceStateConfig,
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

export function appendLog(path: string, chunk: string): void {
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

/**
 * The container identity a job's liveness or cancellation may verify against,
 * or null when the job can prove none.
 *
 * A scoped job (one carrying a live credential scope) must reconstruct its
 * immutable lease first: a record whose evidence or scope was tampered with,
 * or which never captured an id, yields nothing runnable and therefore
 * nothing signalable.
 *
 * The ONE durable-identity exception is a GENUINE legacy live record: a run or
 * run-all job whose whole credential triple is absent, because it was written
 * before scoped delivery existed and so has no lease to reconstruct. A record
 * that kept part of that triple was not written that way, an asserted-empty
 * scope is a claim of no material rather than a missing claim, and a kind that
 * never executed live has no in-container process group of its own — none of
 * them may read raw evidence.
 *
 * Either way the signal itself goes ONLY through runRecordedContainerLifecycle
 * — the fixed docker inspect + exec seam — never through a wrapper argument
 * path, and a replacement container under the configured name is refused
 * there, after inspect, with no exec.
 */
function lifecycleIdentity(job: JobRecord): RecordedContainerIdentity | null {
  if (job.credential_scope?.kind === 'live') {
    try {
      const lease = liveLeaseFromJob(job);
      return { name: lease.name, id: lease.id };
    } catch (error) {
      if (error instanceof ApplianceError) {
        return null;
      }
      throw error;
    }
  }
  const isGenuineLegacyRecord =
    (job.kind === 'run' || job.kind === 'run-all') &&
    job.credential_selection === null &&
    job.credential_scope === null &&
    job.credential_scope_source_evals_sha === null;
  if (!isGenuineLegacyRecord) {
    return null;
  }
  const name = job.container?.name ?? null;
  const id = job.container?.id ?? null;
  if (name === null || id === null || id.trim() === '') {
    return null;
  }
  return { name, id };
}

function containerProcessGroupAlive(
  loaded: LoadedApplianceStateConfig,
  job: JobRecord,
  pgid: number,
  runner: CommandRunner,
): boolean {
  const identity = lifecycleIdentity(job);
  if (identity === null) {
    return false;
  }
  try {
    return (
      runRecordedContainerLifecycle(
        loaded,
        runner,
        identity,
        'probe-process-group',
        pgid,
      ).status === 0
    );
  } catch (error) {
    if (error instanceof ApplianceError) {
      // A replacement container (or an unverifiable identity) reports lost:
      // the recorded process group cannot be proven alive.
      return false;
    }
    throw error;
  }
}

function hostProcessGroupState(
  pgid: number,
  processKill: ProcessKill = process.kill.bind(process),
): 'alive' | 'absent' | 'unknown' {
  try {
    processKill(-pgid, 0);
    return 'alive';
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    ) {
      return 'absent';
    }
    return 'unknown';
  }
}

function hostProcessGroupAlive(
  pgid: number,
  processKill: ProcessKill = process.kill.bind(process),
): boolean {
  return hostProcessGroupState(pgid, processKill) !== 'absent';
}

function signalHostProcessGroup(
  pgid: number,
  processKill: ProcessKill = process.kill.bind(process),
): boolean {
  try {
    processKill(-pgid, 'SIGINT');
    return true;
  } catch {
    return false;
  }
}

function jobProcessGroupAlive(
  loaded: LoadedApplianceStateConfig,
  job: JobRecord,
  runner: CommandRunner,
  processKill: ProcessKill = process.kill.bind(process),
): boolean {
  const containerPgid = job.process?.container_pgid ?? null;
  if (containerPgid !== null) {
    return containerProcessGroupAlive(loaded, job, containerPgid, runner);
  }
  const hostPgid = job.process?.host_pgid ?? null;
  return hostPgid !== null && hostProcessGroupAlive(hostPgid, processKill);
}

async function waitForLiveTerminalArtifact(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
  runner: CommandRunner,
  result: LiveCommandResult,
): Promise<ParsedArtifacts> {
  if (result.status !== 0) {
    return currentArtifacts(loaded, jobId);
  }

  while (true) {
    const artifacts = currentArtifacts(loaded, jobId);
    if (hasTerminalArtifact(loaded, artifacts)) {
      return artifacts;
    }

    const current = readJob(loaded, jobId);
    if (!jobProcessGroupAlive(loaded, current, runner)) {
      break;
    }

    await sleep(LIVE_COMPLETION_POLL_INTERVAL_MS);
  }

  await waitForTerminalArtifact(
    loaded,
    jobId,
    LIVE_COMPLETION_POST_EXIT_GRACE_MS,
    LIVE_COMPLETION_POLL_INTERVAL_MS,
  );
  return currentArtifacts(loaded, jobId);
}

function markFailed(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
  error: ApplianceError,
): void {
  try {
    updateJob(loaded, jobId, (job) => {
      if (job.status === 'stopping' || isTerminal(job.status)) {
        return job;
      }
      return {
        ...job,
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
  } catch {}
}

// Re-derives provenance from the job after the live command lands, so the
// artifact directories receive a copy. Everything but the tool versions comes
// off the record itself, which is what lets this heal a preflight-time write
// failure without restating any scope or container evidence.
function writeArtifactProvenance(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
  preflight: LivePreflightResult,
): void {
  writeProvenance(loaded, jobId, {
    path: preflight.evidence.tool_versions_path,
    text: preflight.evidence.tool_versions_text,
  });
}

// Flags the appliance never forwards to run-all: the first three would
// relocate the trusted roots it controls, --credentials-file would swap the
// blessed registry the bundle was built for, and --credential is run's flag,
// which would leave the real selection (--credentials) unmade while looking
// like it had been made. Submission refuses each of them; so does this.
const FORBIDDEN_RUN_ALL_FLAGS: readonly string[] = [
  '--coding-agents-dir',
  '--out-root',
  '--scenarios-root',
  '--credentials-file',
  '--credential',
];

const TRUSTED_SCENARIO_PREFIX = 'scenarios/';

function liveCommandFault(job: JobRecord, message: string): ApplianceError {
  return new ApplianceError(
    'config_invalid',
    'live-command',
    `job ${job.job_id} (${job.kind}) ${message}`,
  );
}

// A run-all cell option: absent exactly when the record selected nothing,
// otherwise ONE occurrence naming exactly the one selected entry. A repeated,
// widened, or renamed option is a command for a cell this record never
// asserted.
function requireSelectedRunAllOption(
  job: JobRecord,
  parsed: ParsedRunAllArgv,
  name: string,
  selected: string | null,
): void {
  const occurrences = parsed.values.get(name) ?? [];
  if (selected === null) {
    if (occurrences.length > 0) {
      throw liveCommandFault(
        job,
        `command passes ${name}, but the record asserts none`,
      );
    }
    return;
  }
  const entries = (occurrences[0] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (
    occurrences.length !== 1 ||
    entries.length !== 1 ||
    entries[0] !== selected
  ) {
    throw liveCommandFault(
      job,
      `command must pass ${name} naming exactly '${selected}'`,
    );
  }
}

/**
 * The exact Quorum command a `run` record authorizes. Submission builds this
 * argv from the normalized scenario and the one selected cell and forwards
 * nothing else, so it is RECONSTRUCTED here rather than pattern matched: the
 * scenario is the only free token, and it must still be a relative path under
 * the trusted scenarios root the normalizer produces.
 */
function requireRunCommand(
  job: JobRecord,
  selection: CredentialSelection,
): void {
  const argv = job.command.argv;
  const scenario = argv[2] ?? '';
  if (
    !scenario.startsWith(TRUSTED_SCENARIO_PREFIX) ||
    scenario.length === TRUSTED_SCENARIO_PREFIX.length ||
    scenario.split('/').includes('..')
  ) {
    throw liveCommandFault(
      job,
      `command does not name a scenario under ${TRUSTED_SCENARIO_PREFIX}`,
    );
  }
  const expected = [
    'quorum',
    'run',
    scenario,
    '--coding-agent',
    selection.agent,
    ...(selection.credential === null
      ? []
      : ['--credential', selection.credential]),
  ];
  if (
    argv.length !== expected.length ||
    argv.some((arg, index) => arg !== expected[index])
  ) {
    throw liveCommandFault(
      job,
      `command is not the quorum run of scenario ${scenario} for agent '${selection.agent}' credential '${selection.credential ?? '(default)'}'`,
    );
  }
}

/**
 * The structural rules a `run-all` record's command must satisfy. Unlike run,
 * submission forwards the operator's remaining Quorum arguments verbatim, so
 * there is no argv to reconstruct — this re-checks exactly what submission
 * checked: the program and subcommand, the flags the appliance refuses to
 * forward, the single OS it supports, and that the command still names the one
 * (agent, credential) cell the record asserts.
 */
function requireRunAllCommand(
  job: JobRecord,
  selection: CredentialSelection,
): void {
  const argv = job.command.argv;
  if (argv[0] !== 'quorum' || argv[1] !== 'run-all') {
    throw liveCommandFault(job, 'command is not a quorum run-all');
  }
  let parsed: ParsedRunAllArgv;
  try {
    parsed = parseRunAllArgv(argv.slice(2));
  } catch (error) {
    if (!(error instanceof RunAllArgvError)) {
      throw error;
    }
    throw liveCommandFault(job, error.message);
  }
  for (const flag of FORBIDDEN_RUN_ALL_FLAGS) {
    if ((parsed.values.get(flag) ?? []).length > 0) {
      throw liveCommandFault(
        job,
        `command passes ${flag}, which the appliance never forwards to run-all`,
      );
    }
  }
  requireSelectedRunAllOption(job, parsed, '--coding-agents', selection.agent);
  requireSelectedRunAllOption(
    job,
    parsed,
    '--credentials',
    selection.credential,
  );
}

/**
 * The ONE Quorum command a live record authorizes, read off that record. Its
 * `command.argv` is durable, mutable job state, and the live exec below is the
 * only place the worker-only supervisor env file crosses into a process — so a
 * record naming any other program, subcommand, or (agent, credential) cell is
 * refused typed HERE, against its own kind and selection, before a runner
 * call, a staged credential, or any output exists.
 */
function requireRecordQuorumCommand(job: JobRecord): readonly string[] {
  if (job.kind !== 'run' && job.kind !== 'run-all') {
    throw liveCommandFault(
      job,
      'is not a run or run-all job; it executes no live Quorum command',
    );
  }
  const selection = job.credential_selection;
  if (selection === null) {
    throw liveCommandFault(
      job,
      'has no credential selection to validate its command against',
    );
  }
  if (job.kind === 'run') {
    requireRunCommand(job, selection);
  } else {
    requireRunAllCommand(job, selection);
  }
  return job.command.argv;
}

/**
 * The record the lease was attested for. Preflight validates ONE job, stages
 * ONE credential generation for it, and returns the lease that generation
 * produced — but the worker rereads the record from disk before executing, and
 * that record is durable, mutable state. So the two halves of the attestation
 * are re-proved against the record actually being executed: its authoritative
 * scope must canonically equal the lease's, and its recorded container
 * evidence must be exactly what this lease produces. Otherwise a job could be
 * re-pointed at another cell between attestation and exec, and run that cell's
 * command inside this cell's credentials.
 */
function requireLeaseBoundRecord(job: JobRecord, lease: ContainerLease): void {
  const scope = job.credential_scope;
  if (scope === null || !credentialScopesEqual(scope, lease.credentialScope)) {
    throw liveCommandFault(
      job,
      'no longer asserts the credential scope its preflight attested; refusing to execute it',
    );
  }
  const expected = leaseToJobContainerEvidence(lease);
  const recorded = job.container;
  if (
    recorded === null ||
    recorded.name !== expected.name ||
    recorded.id !== expected.id ||
    recorded.image_id !== expected.image_id ||
    recorded.mount_signature !== expected.mount_signature
  ) {
    throw liveCommandFault(
      job,
      'does not record the container evidence its preflight attested; refusing to execute it',
    );
  }
}

/**
 * The live Quorum exec: pinned to the immutable container the job preflighted
 * against, and the ONE place the worker-only supervisor env file crosses into
 * a process. The command launched is the job's own validated Quorum command,
 * never an argv handed in beside the record; a replacement container under the
 * configured name can neither be targeted here nor pass the wrapper's own
 * identity check.
 */
export function liveCommandArgs(
  loaded: LoadedApplianceConfig,
  job: JobRecord,
  lease: ContainerLease,
  supervisorExecEnvFile: string,
): string[] {
  const argv = requireRecordQuorumCommand(job);
  requireLeaseBoundRecord(job, lease);
  const runAllEnv =
    job.kind === 'run-all'
      ? ['export QUORUM_RUN_ALL_SIGNAL_MODE=detached']
      : [];
  const script = [
    'set -euo pipefail',
    'pid_path=$1',
    'shift',
    ...runAllEnv,
    'mkdir -p "$(dirname "$pid_path")"',
    'setsid bash -lc \'echo "$$" > "$1"; shift; exec "$@"\' appliance-live "$pid_path" "$@"',
  ].join('\n');

  return scopedExecContainerArgs(
    loaded,
    lease,
    [
      'bash',
      '-lc',
      script,
      'appliance-live',
      containerPidPath(job.job_id),
      ...argv,
    ],
    { execEnvFile: supervisorExecEnvFile },
  );
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

export type DetachedSpawnPrimitive = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export function spawnDetachedWorker(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
  spawnPrimitive: DetachedSpawnPrimitive = (command, args, options) =>
    spawn(command, [...args], options),
): LiveProcessInfo {
  const processModule = new URL('./process.ts', import.meta.url).href;
  const configModule = new URL('./config.ts', import.meta.url).href;
  const script = `
const { loadStateConfig, loadCredentialConfig } = await import(${JSON.stringify(configModule)});
const { dispatchDetachedWorker } = await import(${JSON.stringify(processModule)});
const jobId = Bun.env.EVALS_APPLIANCE_JOB_ID;
if (jobId === undefined) {
  throw new Error('EVALS_APPLIANCE_JOB_ID is required');
}
// Structural validation first, then the credential-aware loader the live
// worker needs: a resumed job stages its own credential generation.
loadStateConfig(Bun.env.EVALS_APPLIANCE_CONFIG);
const loaded = loadCredentialConfig(Bun.env.EVALS_APPLIANCE_CONFIG);
await dispatchDetachedWorker(loaded, jobId);
`;
  const job = readJob(loaded, jobId);
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  try {
    stdoutFd = openSync(job.artifacts.stdout_log, 'a', 0o600);
    stderrFd = openSync(job.artifacts.stderr_log, 'a', 0o600);
    const child = spawnPrimitive(process.execPath, ['--eval', script], {
      cwd: loaded.config.evals.path,
      detached: true,
      env: detachedWorkerEnv(loaded, jobId),
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    child.once('error', () => {
      markFailed(
        loaded,
        jobId,
        new ApplianceError(
          'config_invalid',
          'spawn',
          DETACHED_SPAWN_FAILURE_MESSAGE,
        ),
      );
    });
    const pid = child.pid;
    if (pid === undefined || !Number.isInteger(pid) || pid <= 1) {
      throw new ApplianceError(
        'config_invalid',
        'spawn',
        DETACHED_UNSAFE_PID_MESSAGE,
      );
    }
    child.unref();
    return { host_pid: pid, host_pgid: pid };
  } catch (error) {
    if (
      error instanceof ApplianceError &&
      error.code === 'config_invalid' &&
      error.step === 'spawn' &&
      error.message === DETACHED_UNSAFE_PID_MESSAGE
    ) {
      throw error;
    }
    throw new ApplianceError(
      'config_invalid',
      'spawn',
      DETACHED_SPAWN_FAILURE_MESSAGE,
    );
  } finally {
    if (stdoutFd !== null) closeSync(stdoutFd);
    if (stderrFd !== null) closeSync(stderrFd);
  }
}

export interface DetachedWorkerDispatchDeps {
  readonly runWorker?: (
    loaded: LoadedApplianceConfig,
    jobId: string,
  ) => Promise<void>;
  readonly runCampaignWorker?: (
    loaded: LoadedApplianceConfig,
    jobId: string,
  ) => Promise<void>;
}

/** Selects exactly one worker implementation from the persisted job kind. */
export async function dispatchDetachedWorker(
  loaded: LoadedApplianceConfig,
  jobId: string,
  deps: DetachedWorkerDispatchDeps = {},
): Promise<void> {
  const job = readJob(loaded, jobId);
  if (job.kind === 'campaign-run') {
    const worker =
      deps.runCampaignWorker ??
      (await import('./campaign-run.ts')).runCampaignWorker;
    await worker(loaded, jobId);
    return;
  }
  const worker = deps.runWorker ?? runWorker;
  await worker(loaded, jobId);
}

export function detachedWorkerEnv(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
  _source: Readonly<Record<string, string | undefined>> = envSnapshot(),
): Record<string, string> {
  const env: Record<string, string> = {
    EVALS_APPLIANCE_CONFIG: loaded.configPath,
    EVALS_APPLIANCE_JOB_ID: jobId,
    PATH: DEFAULT_TRUSTED_PATH,
    HOME: loaded.config.root,
    GAUNTLET_ROOT: loaded.config.gauntlet.path,
    SUPERPOWERS_ROOT: loaded.config.superpowers.path,
  };
  if (loaded.config.live_spend_lock !== undefined) {
    env['QUORUM_LIVE_SPEND_LOCK'] = loaded.config.live_spend_lock;
  }
  return env;
}

export async function runWorker(
  loaded: LoadedApplianceConfig,
  jobId: string,
  runner?: CommandRunner,
): Promise<void> {
  let runLock: LockHandle | null = null;
  let syncLock: LockHandle | null = null;
  let preflight: LivePreflightResult | null = null;

  try {
    const job = readJob(loaded, jobId);
    // The record's own Quorum command, validated before any lock, repo sync,
    // container, or credential work: a rewritten command must never reach
    // staging, let alone the supervisor env file the live exec attaches.
    requireRecordQuorumCommand(job);
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

    preflight = await preflightLiveJob({
      loaded,
      jobId,
      superpowersRef: job.request.superpowers_ref,
      ...(runner === undefined ? {} : { runner }),
    });
    updateLockRefs(runLock, preflight.evidence.refs);
    updateLockRefs(syncLock, preflight.evidence.refs);
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

    mkdirPrivate(dirname(pidFilePath(loaded, jobId)));
    const command = evalsContainerPath(loaded);
    // The supervisor env file reaches exactly one process: this one.
    const args = liveCommandArgs(
      loaded,
      liveJob,
      preflight.lease,
      preflight.supervisorExecEnvFile,
    );
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
    const artifacts = await waitForLiveTerminalArtifact(
      loaded,
      jobId,
      runner ?? defaultCommandRunner,
      launchResult,
    );
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

    const postflightError = postflightDirtyCheck(
      loaded,
      jobId,
      runner ?? defaultCommandRunner,
    );
    if (postflightError !== null) {
      throw postflightError;
    }
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
  loaded: LoadedApplianceStateConfig,
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
    if (job.kind === 'campaign-run' && hostPgid !== null) {
      interrupted = signalHostProcessGroup(hostPgid, options.processKill);
    } else if (containerPgid !== null) {
      // Identity-verified cancellation: the SIGINT goes only through the
      // fixed recorded-container seam. A replacement container (or a job
      // with no verifiable recorded identity) receives no signal at all.
      const identity = lifecycleIdentity(job);
      if (identity !== null) {
        try {
          interrupted =
            runRecordedContainerLifecycle(
              loaded,
              runner,
              identity,
              'interrupt-process-group',
              containerPgid,
            ).status === 0;
        } catch (error) {
          if (!(error instanceof ApplianceError)) {
            throw error;
          }
          interrupted = false;
        }
      }
    } else if (hostPgid !== null) {
      interrupted = signalHostProcessGroup(hostPgid, options.processKill);
    }

    if (
      !interrupted &&
      jobProcessGroupAlive(loaded, job, runner, options.processKill)
    ) {
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

  if (job.kind === 'campaign-run') {
    const controllerPgid = hostPgid ?? containerPgid;
    const deadline = Date.now() + (options.graceMs ?? CANCEL_GRACE_MS);
    while (controllerPgid !== null) {
      const state =
        hostPgid !== null
          ? hostProcessGroupState(controllerPgid, options.processKill)
          : jobProcessGroupAlive(
                loaded,
                readJob(loaded, jobId),
                runner,
                options.processKill,
              )
            ? 'alive'
            : 'absent';
      if (state === 'absent') {
        return updateJob(loaded, jobId, (current) => ({
          ...current,
          status: 'cancelled',
          finished_at: new Date().toISOString(),
          result: {
            exit_code: null,
            summary:
              'controller signalled and verified dead; campaign journal is the outcome authority',
          },
          error: null,
        }));
      }
      if (Date.now() >= deadline) {
        return updateJob(loaded, jobId, (current) => ({
          ...current,
          status: 'stopping',
          result: {
            exit_code: null,
            summary: 'cancel signal sent; controller still live past the grace',
          },
          error: null,
        }));
      }
      await sleep(
        Math.min(
          options.pollIntervalMs ?? CANCEL_POLL_INTERVAL_MS,
          Math.max(0, deadline - Date.now()),
        ),
      );
    }
  }

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
