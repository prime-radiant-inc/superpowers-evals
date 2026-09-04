import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  readSync as fsReadSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CommandResult, CommandRunner } from '../agents/command-runner.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import {
  closePin,
  pinAbsoluteDir,
  readPinnedNoFollowFile,
  writePinnedFile,
} from '../appliance/credential-scope.ts';
import type { CampaignIdentity } from '../contracts/campaign/campaign.ts';
import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import {
  type AttemptIntent,
  AttemptIntentSchema,
  type AttemptMonitor,
  type AttemptRuntime,
  type AttemptRuntimeSpec,
  type BoundExecution,
  ContainerIdSchema,
  type OwnedRuntimeObservation,
  type PreparedExecution,
  type StopObservation,
  type VerifiedStopped,
} from '../contracts/campaign/execution.ts';
import type { Grader } from '../contracts/campaign/experiment.ts';
import type { Clock } from '../scheduler/clock.ts';
import type { PrepareAttemptStageArgs } from './attempt-projection.ts';
import {
  type PreparedAttemptStage,
  prepareAttemptStage,
} from './attempt-projection.ts';
import {
  ATTEMPT_AUTHORITY_PATH,
  PreparedAttemptAuthoritySchema,
} from './child-authority.ts';
import { COVERED_BY_LOCK_ENV } from './locks.ts';
import {
  type AttemptMount,
  type AttemptSpawnContext,
  buildCampaignChildArgv,
  type CampaignChildSpec,
  type ChildExitInfo,
  type ChildSpawner,
  SpawnError,
  type SpawnedCampaignChild,
} from './spawn.ts';

export const ATTEMPT_TMPFS_BYTES = 2 * 1024 * 1024 * 1024;
export const ATTEMPT_RUNTIME_DIR = '/run/quorum/attempt';

const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const FOLLOW_POLL_SECONDS = 0.05;

export class AttemptContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptContainerError';
  }
}

export type ContainerSpawnCleanup = 'verified-absent' | 'unverified';

/** Post-create failures must retain the exact identity and cleanup certainty.
 *  Without this contract a dispatcher cannot distinguish a failed create from
 *  a container that may still be running after cleanup itself failed. */
export class AttemptContainerSpawnError extends AttemptContainerError {
  readonly containerId: string;
  readonly cleanup: ContainerSpawnCleanup;

  constructor(
    message: string,
    containerId: string,
    cleanup: ContainerSpawnCleanup,
  ) {
    super(message);
    this.name = 'AttemptContainerSpawnError';
    this.containerId = containerId;
    this.cleanup = cleanup;
  }
}

/** The Docker command seam used by the attempt spawner. */
export type AttemptDocker = CommandRunner;

/** Production Docker seam. Tests should inject a CommandRunner instead. */
export const realAttemptDocker: AttemptDocker = defaultCommandRunner;

export type DockerWait = (containerId: string) => Promise<number>;

export interface DockerWaitProcess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
}

export type DockerWaitLauncher = (containerId: string) => DockerWaitProcess;

const launchDockerWait: DockerWaitLauncher = (containerId) =>
  Bun.spawn(['docker', 'wait', containerId], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

/** Wait for a container without blocking the controller's event loop. */
export async function realDockerWait(
  containerId: string,
  launch: DockerWaitLauncher = launchDockerWait,
): Promise<number> {
  if (!CONTAINER_ID_RE.test(containerId)) {
    throw new AttemptContainerError(
      'docker wait requires a canonical full container id',
    );
  }
  let proc: DockerWaitProcess;
  try {
    proc = launch(containerId);
  } catch {
    throw new AttemptContainerError('docker wait failed');
  }
  const stdout =
    proc.stdout === null
      ? Promise.resolve('')
      : new Response(proc.stdout).text();
  const stderr =
    proc.stderr === null
      ? Promise.resolve('')
      : new Response(proc.stderr).text();
  let exitCode: number;
  try {
    [exitCode] = await Promise.all([proc.exited, stdout, stderr]);
  } catch {
    throw new AttemptContainerError('docker wait failed');
  }
  if (exitCode !== 0) {
    throw new AttemptContainerError('docker wait failed');
  }
  const value = await stdout;
  if (!/^\d+(?:\n|\r\n)$/.test(value)) {
    throw new AttemptContainerError(
      `docker wait returned malformed exit code for ${containerId}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AttemptContainerError(
      `docker wait returned malformed exit code for ${containerId}`,
    );
  }
  return parsed;
}

export interface ContainerStopper {
  stop(containerId: string, graceSeconds: number): Promise<'dead' | 'alive'>;
}

export interface ContainerAttemptSpawnerArgs {
  readonly runner: CommandRunner;
  readonly clock: Clock;
  readonly stream: { write(s: string): void };
  readonly campaignId: string;
  readonly campaignDir: string;
  /** The mutable local image reference is retained as provenance only. The
   *  create command always launches imageDigest, which is immutable. */
  readonly imageRef: string;
  readonly imageDigest: string;
  readonly evalsSha: string;
  readonly bundleDir: string;
  readonly uid: number;
  readonly gid: number;
  readonly dockerWait?: DockerWait;
  readonly tmpfsBytes?: number;
}

export interface BuildAttemptMountsArgs {
  readonly evalsRoot: string;
  readonly gauntletRoot: string;
  readonly binRoot: string;
  readonly superpowersTree: string | null;
  readonly attemptDir: string;
  readonly subjectEnvFile: string;
  readonly graderEnvFile: string;
  readonly passwdFile: string;
  readonly groupFile: string;
}

/** Docker permits only a restricted name alphabet. The full attempt id is
 *  retained in the identity label; its digest gives a stable, collision-
 *  resistant handle without putting ':' into the Docker name. */
export function containerNameForAttempt(
  campaignId: string,
  attemptId: string,
): string {
  const attemptDigest = createHash('sha256').update(attemptId).digest('hex');
  return `quorum-attempt-${campaignId}-${attemptDigest}`;
}

export function buildAttemptMounts(
  args: BuildAttemptMountsArgs,
): AttemptMount[] {
  const mounts: AttemptMount[] = [
    { source: args.evalsRoot, target: args.evalsRoot, mode: 'ro' },
    { source: args.gauntletRoot, target: args.gauntletRoot, mode: 'ro' },
    { source: args.binRoot, target: args.binRoot, mode: 'ro' },
  ];
  if (args.superpowersTree !== null) {
    mounts.push({
      source: args.superpowersTree,
      target: args.superpowersTree,
      mode: 'ro',
    });
  }
  mounts.push(
    { source: args.attemptDir, target: args.attemptDir, mode: 'rw' },
    {
      source: args.subjectEnvFile,
      target: '/run/quorum/subject.env',
      mode: 'ro',
    },
    {
      source: args.graderEnvFile,
      target: '/run/quorum/grader.env',
      mode: 'ro',
    },
    { source: args.passwdFile, target: '/etc/passwd', mode: 'ro' },
    { source: args.groupFile, target: '/etc/group', mode: 'ro' },
  );
  return mounts;
}

interface InspectedMount {
  readonly Type?: string;
  readonly Source?: string;
  readonly Destination?: string;
  readonly RW?: boolean;
}

interface InspectedContainer {
  readonly Id?: string;
  readonly Name?: string;
  readonly Image?: string;
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Readonly<Record<string, string>> | null;
  };
  readonly Mounts?: readonly InspectedMount[];
  readonly HostConfig?: {
    readonly Mounts?: readonly InspectedMount[];
  };
  readonly State?: {
    readonly Running?: unknown;
    readonly ExitCode?: unknown;
    readonly OOMKilled?: unknown;
    readonly StartedAt?: unknown;
    readonly FinishedAt?: unknown;
  };
}

interface InspectedState {
  readonly running: boolean;
  readonly exitCode: number;
  readonly oomKilled: boolean;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

type StopInspectResult =
  | { readonly kind: 'running'; readonly state: InspectedState }
  | { readonly kind: 'stopped'; readonly state: InspectedState }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' };

export class ContainerAttemptSpawner implements ChildSpawner, ContainerStopper {
  readonly kind = 'container' as const;
  private readonly args: ContainerAttemptSpawnerArgs;
  private readonly dockerWait: DockerWait;

  constructor(args: ContainerAttemptSpawnerArgs) {
    if (!IMAGE_DIGEST_RE.test(args.imageDigest)) {
      throw new AttemptContainerError(
        'container image digest is not canonical',
      );
    }
    this.args = args;
    this.dockerWait = args.dockerWait ?? realDockerWait;
  }

  prepareAttempt(args: {
    readonly attemptId: string;
    readonly agent: string;
    readonly credentialName: string;
    readonly evalsRoot: string;
    readonly superpowersTree: string | null;
  }): PreparedAttemptStage {
    return prepareAttemptStage({
      campaignDir: this.args.campaignDir,
      attemptId: args.attemptId,
      agent: args.agent,
      credentialName: args.credentialName,
      evalsRoot: args.evalsRoot,
      bundleDir: this.args.bundleDir,
      uid: this.args.uid,
      gid: this.args.gid,
    });
  }

  spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
    const attempt = spec.attempt;
    if (attempt === undefined) {
      throw new SpawnError(
        'container spawner requires an attempt context on the child spec',
      );
    }
    const containerName = containerNameForAttempt(
      this.args.campaignId,
      attempt.attemptId,
    );
    const containerId = this.createContainer(spec, attempt, containerName);
    try {
      this.verifyContainer(containerId, containerName, attempt);
      this.createLogFiles(attempt);
      const started = this.docker(['start', containerId]);
      if (started.status !== 0) {
        throw new AttemptContainerError(
          'docker start failed for attempt container',
        );
      }
    } catch (error) {
      try {
        this.removeExactContainer(containerId);
        const originalMessage =
          error instanceof Error ? error.message : 'container operation failed';
        throw new AttemptContainerSpawnError(
          originalMessage,
          containerId,
          'verified-absent',
        );
      } catch (cleanupError) {
        if (cleanupError instanceof AttemptContainerSpawnError) {
          throw cleanupError;
        }
        const originalMessage =
          error instanceof Error ? error.message : 'container operation failed';
        const cleanupMessage =
          cleanupError instanceof Error
            ? cleanupError.message
            : 'exact container cleanup failed';
        throw new AttemptContainerSpawnError(
          `${originalMessage}; ${cleanupMessage}`,
          containerId,
          'unverified',
        );
      }
    }
    return this.settleHandle(containerId, attempt, containerName);
  }

  private docker(dockerArgs: readonly string[]): CommandResult {
    return this.args.runner.run('docker', [...dockerArgs]);
  }

  private createContainer(
    spec: CampaignChildSpec,
    attempt: AttemptSpawnContext,
    containerName: string,
  ): string {
    const tmpfs = this.args.tmpfsBytes ?? ATTEMPT_TMPFS_BYTES;
    const argv: string[] = [
      'create',
      '--init',
      '--name',
      containerName,
      '--label',
      `quorum.campaign_id=${this.args.campaignId}`,
      '--label',
      `quorum.attempt_id=${attempt.attemptId}`,
      '--label',
      `quorum.evals_sha=${this.args.evalsSha}`,
      '--label',
      `quorum.image_digest=${this.args.imageDigest}`,
      '--user',
      `${this.args.uid}:${this.args.gid}`,
      '--workdir',
      spec.cwd,
      '--env',
      `HOME=${attempt.homeDir}`,
      '--env',
      `TMPDIR=${ATTEMPT_RUNTIME_DIR}`,
      '--env',
      `TMUX_TMPDIR=${ATTEMPT_RUNTIME_DIR}`,
      '--env',
      `XDG_CONFIG_HOME=${attempt.homeDir}/.config`,
      '--env',
      `XDG_CACHE_HOME=${attempt.homeDir}/.cache`,
      '--env',
      `XDG_STATE_HOME=${attempt.homeDir}/.local/state`,
      '--env',
      `${COVERED_BY_LOCK_ENV}=1`,
      '--env',
      `QUORUM_ATTEMPT_DIR=${attempt.attemptDir}`,
      '--env',
      'QUORUM_SUBJECT_FILE=/run/quorum/subject.env',
      '--env',
      'QUORUM_GRADER_FILE=/run/quorum/grader.env',
      '--tmpfs',
      `${ATTEMPT_RUNTIME_DIR}:rw,noexec,nosuid,size=${tmpfs}`,
      '--tmpfs',
      `/tmp:rw,size=${tmpfs}`,
    ];
    for (const mount of attempt.mounts) {
      argv.push(
        '--mount',
        `type=bind,source=${mount.source},target=${mount.target}${
          mount.mode === 'ro' ? ',readonly' : ''
        }`,
      );
    }
    // spec.env is deliberately not copied. Credentials only exist in the
    // staged read-only files mounted above, never in Docker's environment.
    argv.push(this.args.imageDigest, attempt.entrypoint, ...spec.args);
    const result = this.docker(argv);
    if (result.status !== 0) {
      throw new AttemptContainerError('docker create failed');
    }
    const id = result.stdout.trim();
    if (!CONTAINER_ID_RE.test(id)) {
      throw new AttemptContainerError(
        'docker create returned a non-canonical container id',
      );
    }
    return id;
  }

  private verifyContainer(
    containerId: string,
    containerName: string,
    attempt: AttemptSpawnContext,
  ): void {
    const result = this.docker(['inspect', containerId]);
    if (result.status !== 0) {
      throw new AttemptContainerError(
        'docker inspect failed for attempt container',
      );
    }
    let observed: InspectedContainer;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1)
        throw new Error('shape');
      observed = parsed[0] as InspectedContainer;
    } catch {
      throw new AttemptContainerError(
        'docker inspect returned invalid container data',
      );
    }

    const actualName = observed.Name?.replace(/^\//, '');
    const imageIds = [observed.Image, observed.Config?.Image].filter(
      (value): value is string => value !== undefined,
    );
    const labels = observed.Config?.Labels;
    const identityMatches =
      observed.Id === containerId &&
      actualName === containerName &&
      imageIds.length > 0 &&
      imageIds.every((image) => image === this.args.imageDigest) &&
      labels?.['quorum.campaign_id'] === this.args.campaignId &&
      labels['quorum.attempt_id'] === attempt.attemptId &&
      labels['quorum.evals_sha'] === this.args.evalsSha &&
      labels['quorum.image_digest'] === this.args.imageDigest;
    if (!identityMatches) {
      throw new AttemptContainerError(
        'container identity, image, or label verification failed',
      );
    }

    const observedMounts = observed.Mounts ?? observed.HostConfig?.Mounts;
    if (!this.sameMounts(attempt.mounts, observedMounts)) {
      throw new AttemptContainerError('container mount verification failed');
    }
  }

  private sameMounts(
    expected: readonly AttemptMount[],
    observed: unknown,
  ): boolean {
    if (!Array.isArray(observed)) return false;
    const key = (mount: unknown): string => {
      if (mount === null || typeof mount !== 'object') return 'malformed';
      const record = mount as InspectedMount;
      if (
        typeof record.Type !== 'string' ||
        typeof record.Source !== 'string' ||
        typeof record.Destination !== 'string' ||
        typeof record.RW !== 'boolean'
      ) {
        return 'malformed';
      }
      return `${record.Type}|${record.Source}|${record.Destination}|${!record.RW}`;
    };
    const expectedKeys = expected.map((mount) =>
      key({
        Type: 'bind',
        Source: mount.source,
        Destination: mount.target,
        RW: mount.mode === 'rw',
      }),
    );
    const observedKeys = observed.map(key);
    if (expectedKeys.length !== observedKeys.length) return false;
    expectedKeys.sort();
    observedKeys.sort();
    return expectedKeys.every((value, index) => value === observedKeys[index]);
  }

  private createLogFiles(attempt: AttemptSpawnContext): void {
    for (const path of [attempt.stdoutLog, attempt.stderrLog]) {
      const fd = openSync(path, 'a', 0o600);
      closeSync(fd);
    }
  }

  private removeExactContainer(containerId: string): void {
    // Docker receives only the validated full ID captured from create. A
    // failed cleanup is itself a hard failure: the caller must not report a
    // verification/start failure as if the created container was removed.
    const result = this.docker(['rm', containerId]);
    if (result.status !== 0) {
      throw new AttemptContainerError('exact container cleanup failed');
    }
  }

  private inspectState(containerId: string): InspectedState | null {
    const result = this.docker(['inspect', containerId]);
    if (result.status !== 0) return null;
    return this.parseInspectState(result.stdout, containerId);
  }

  private inspectForStop(containerId: string): StopInspectResult {
    const result = this.docker(['inspect', containerId]);
    if (result.status !== 0) {
      const stderr = result.stderr.trim();
      if (stderr === `Error: No such object: ${containerId}`) {
        return { kind: 'absent' };
      }
      return { kind: 'unknown' };
    }
    const state = this.parseInspectState(result.stdout, containerId);
    if (state === null) return { kind: 'unknown' };
    return state.running
      ? { kind: 'running', state }
      : { kind: 'stopped', state };
  }

  private parseInspectState(
    stdout: string,
    containerId: string,
  ): InspectedState | null {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1) return null;
      const observed = parsed[0];
      if (
        typeof observed !== 'object' ||
        observed === null ||
        Array.isArray(observed) ||
        (observed as InspectedContainer).Id !== containerId
      ) {
        return null;
      }
      const state = (observed as InspectedContainer).State;
      if (state === undefined || typeof state !== 'object' || state === null) {
        return null;
      }
      if (
        typeof state.Running !== 'boolean' ||
        typeof state.ExitCode !== 'number' ||
        !Number.isSafeInteger(state.ExitCode) ||
        typeof state.OOMKilled !== 'boolean'
      ) {
        return null;
      }
      const timestamps = [state.StartedAt, state.FinishedAt];
      if (
        !timestamps.every(
          (timestamp) => timestamp === null || typeof timestamp === 'string',
        )
      ) {
        return null;
      }
      return {
        running: state.Running,
        exitCode: state.ExitCode,
        oomKilled: state.OOMKilled,
        startedAt: typeof state.StartedAt === 'string' ? state.StartedAt : null,
        finishedAt:
          typeof state.FinishedAt === 'string' ? state.FinishedAt : null,
      };
    } catch {
      return null;
    }
  }

  async stopContainer(
    containerId: string,
    graceSeconds: number,
  ): Promise<'dead' | 'alive'> {
    if (!CONTAINER_ID_RE.test(containerId)) {
      throw new AttemptContainerError(
        'container stop requires a canonical full container id',
      );
    }
    const grace = Number.isFinite(graceSeconds) ? Math.max(0, graceSeconds) : 0;
    const verifiedDead = async (deadline: number): Promise<boolean> => {
      for (;;) {
        const observed = this.inspectForStop(containerId);
        if (observed.kind === 'absent' || observed.kind === 'stopped') {
          return true;
        }
        if (this.args.clock.now() >= deadline) return false;
        await this.args.clock.sleepUntil(
          this.args.clock.now() + FOLLOW_POLL_SECONDS,
        );
      }
    };

    const stopped = this.docker([
      'stop',
      '--time',
      String(Math.max(1, Math.floor(grace))),
      containerId,
    ]);
    if (
      stopped.status !== 0 &&
      stopped.stderr.trim() !==
        `Error response from daemon: No such container: ${containerId}` &&
      stopped.stderr.trim() !== `Error: No such container: ${containerId}`
    ) {
      this.args.stream.write(
        `docker stop ${containerId} failed: ${stopped.stderr.trim()} — continuing to verify\n`,
      );
    }
    if (await verifiedDead(this.args.clock.now() + grace)) return 'dead';

    const killed = this.docker(['kill', containerId]);
    if (
      killed.status !== 0 &&
      killed.stderr.trim() !==
        `Error response from daemon: No such container: ${containerId}` &&
      killed.stderr.trim() !== `Error: No such container: ${containerId}`
    ) {
      this.args.stream.write(
        `docker kill ${containerId} failed: ${killed.stderr.trim()} — continuing to verify\n`,
      );
    }
    if (await verifiedDead(this.args.clock.now() + grace)) return 'dead';

    this.args.stream.write(
      `container ${containerId} survived stop+kill past ${graceSeconds}s grace — verify-death FAILED; abort the enclosing operation loudly\n`,
    );
    return 'alive';
  }

  async stop(
    containerId: string,
    graceSeconds: number,
  ): Promise<'dead' | 'alive'> {
    return await this.stopContainer(containerId, graceSeconds);
  }

  private settleHandle(
    containerId: string,
    attempt: AttemptSpawnContext,
    containerName: string,
  ): SpawnedCampaignChild {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const stdoutCbs: ((line: string) => void)[] = [];
    const stderrCbs: ((line: string) => void)[] = [];
    const exitCbs: ((info: ChildExitInfo) => void)[] = [];
    let exitInfo: ChildExitInfo | null = null;
    let published = false;

    const deliver = (
      buffer: string,
      lines: string[],
      cbs: ((line: string) => void)[],
      chunk: string,
    ): string => {
      const parts = (buffer + chunk).split('\n');
      const rest = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        for (const cb of cbs) cb(line);
      }
      return rest;
    };

    const writeExit = (
      state: InspectedState | null,
      info: ChildExitInfo,
    ): void => {
      const finalPath = join(attempt.attemptDir, 'exit.json');
      const stagePath = join(
        attempt.attemptDir,
        `.exit.json.${process.pid}.tmp`,
      );
      const bytes = Buffer.from(
        `${JSON.stringify(
          {
            code: info.code,
            signal: info.signal,
            oom_killed: state?.oomKilled === true,
            started_at: state?.startedAt ?? null,
            finished_at: state?.finishedAt ?? null,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      let fd: number | null = null;
      try {
        // wx prevents an old stage from being mistaken for this publication.
        fd = openSync(stagePath, 'wx', 0o600);
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset);
          if (written <= 0)
            throw new Error('exit publication made no progress');
          offset += written;
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        renameSync(stagePath, finalPath);
        chmodSync(finalPath, 0o600);
        const dirFd = openSync(attempt.attemptDir, 'r');
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch (error) {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {}
        }
        try {
          unlinkSync(stagePath);
        } catch {}
        throw error;
      }
    };

    const publish = (
      state: InspectedState | null,
      waitCode: number | null,
      waitValid: boolean,
    ): void => {
      if (published) return;
      const trustworthy =
        waitValid &&
        state !== null &&
        !state.running &&
        waitCode === state.exitCode;
      const code = trustworthy ? state.exitCode : null;
      const signal: ChildExitInfo['signal'] =
        trustworthy && state.oomKilled ? 'SIGKILL' : null;
      const info: ChildExitInfo = { code, signal };
      writeExit(state, info);
      published = true;
      exitInfo = info;
      for (const cb of exitCbs) cb(info);
    };

    const follow = async (): Promise<void> => {
      const stdoutFd = openSync(attempt.stdoutLog, 'r');
      const stderrFd = openSync(attempt.stderrLog, 'r');
      let stdoutOffset = 0;
      let stderrOffset = 0;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let waitDone = false;
      let waitCode: number | null = null;
      let waitValid = false;
      const waitPromise = Promise.resolve().then(() =>
        this.dockerWait(containerId),
      );
      void waitPromise.then(
        (code: unknown) => {
          if (
            typeof code === 'number' &&
            Number.isSafeInteger(code) &&
            code >= 0
          ) {
            waitCode = code;
            waitValid = true;
          }
          waitDone = true;
        },
        () => {
          waitDone = true;
        },
      );
      const buffer = Buffer.alloc(64 * 1024);
      try {
        for (;;) {
          const stdoutRead = fsReadSync(
            stdoutFd,
            buffer,
            0,
            buffer.length,
            stdoutOffset,
          );
          if (stdoutRead > 0) {
            stdoutOffset += stdoutRead;
            stdoutBuffer = deliver(
              stdoutBuffer,
              stdoutLines,
              stdoutCbs,
              buffer.subarray(0, stdoutRead).toString('utf8'),
            );
          }
          const stderrRead = fsReadSync(
            stderrFd,
            buffer,
            0,
            buffer.length,
            stderrOffset,
          );
          if (stderrRead > 0) {
            stderrOffset += stderrRead;
            stderrBuffer = deliver(
              stderrBuffer,
              stderrLines,
              stderrCbs,
              buffer.subarray(0, stderrRead).toString('utf8'),
            );
          }
          if (waitDone && stdoutRead === 0 && stderrRead === 0) {
            if (stdoutBuffer !== '') {
              stdoutBuffer = deliver(
                stdoutBuffer,
                stdoutLines,
                stdoutCbs,
                '\n',
              );
            }
            if (stderrBuffer !== '') {
              stderrBuffer = deliver(
                stderrBuffer,
                stderrLines,
                stderrCbs,
                '\n',
              );
            }
            break;
          }
          await this.args.clock.sleepUntil(
            this.args.clock.now() + FOLLOW_POLL_SECONDS,
          );
        }
      } finally {
        closeSync(stdoutFd);
        closeSync(stderrFd);
      }
      const state = this.inspectState(containerId);
      publish(state, waitCode, waitValid);
    };

    void follow().catch(() => {
      // A malformed attempt log or an unexpected follower failure is a typed
      // failed child, never an unhandled rejection or a fabricated success.
      publish(null, null, false);
    });

    return {
      handle: {
        kind: 'container',
        containerName,
        containerId,
        imageDigest: this.args.imageDigest,
      },
      get stdoutLines() {
        return [...stdoutLines];
      },
      get stderrLines() {
        return [...stderrLines];
      },
      onStdoutLine(cb) {
        for (const line of stdoutLines) cb(line);
        stdoutCbs.push(cb);
      },
      onStderrLine(cb) {
        for (const line of stderrLines) cb(line);
        stderrCbs.push(cb);
      },
      onExit(cb) {
        if (exitInfo !== null) {
          cb(exitInfo);
          return;
        }
        exitCbs.push(cb);
      },
    };
  }
}

/** Controller-local checks must consult the current durable fold, writer fence,
 * host claim, cancel sidecar and credential authority. They throw on refusal;
 * neither a caller-provided bound object nor an environment marker is authority. */
export interface ContainerAttemptRuntimeArgs {
  readonly runner: CommandRunner;
  readonly assertCreateAuthorized: (prepared: PreparedExecution) => void;
  readonly assertStartAuthorized: (bound: BoundExecution) => void;
  /** After controller-death proof, a durably unbound intent is never-issued;
   * a bound intent without runtime_started is uncertain; a durable successful
   * runtime_started receipt is settled. Missing runtime_started alone can
   * never settle a bound attempt. No elapsed-time inference is permitted. */
  readonly startSettlement: (
    bound: BoundExecution,
  ) => 'never-issued' | 'settled' | 'uncertain';
  readonly dockerWait?: DockerWait;
  readonly clientTimeoutMs?: number;
}

function sameRuntimeValue(a: unknown, b: unknown): boolean {
  return jcsCanonicalize(a) === jcsCanonicalize(b);
}
function runtimeCommand(spec: AttemptRuntimeSpec): string[] {
  return [
    '--signal=TERM',
    '--kill-after=5s',
    `${spec.max_time_s}s`,
    spec.command,
    ...spec.args,
  ];
}
function runtimeTmpfs(spec: AttemptRuntimeSpec): Record<string, string> {
  return {
    [ATTEMPT_RUNTIME_DIR]: `rw,noexec,nosuid,size=${spec.tmpfs_bytes}`,
    '/tmp': `rw,size=${spec.tmpfs_bytes}`,
  };
}
function parseEnvironment(entries: unknown): Record<string, string> {
  if (!Array.isArray(entries))
    throw new AttemptContainerError('invalid image or container environment');
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry))
      throw new AttemptContainerError('invalid image or container environment');
    const index = entry.indexOf('=');
    const key = entry.slice(0, index);
    if (Object.hasOwn(result, key))
      throw new AttemptContainerError('duplicate environment name');
    result[key] = entry.slice(index + 1);
  }
  return result;
}

/** V2 runtime: prepare/commit/create/commit/start are separate boundaries.
 * No follower failure publishes an exit artifact or supplies namespace death. */
export class ContainerAttemptRuntime implements AttemptRuntime {
  private readonly requests = new Map<
    string,
    'never-issued' | 'uncertain' | 'settled'
  >();
  private readonly owned = new Map<string, string>();
  private readonly uncertainAttempts = new Set<string>();
  private readonly timeoutMs: number;
  private readonly options: ContainerAttemptRuntimeArgs;
  constructor(options: ContainerAttemptRuntimeArgs) {
    this.options = options;
    this.timeoutMs = options.clientTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
      throw new AttemptContainerError(
        'client timeout must be positive and finite',
      );
  }
  private docker(args: string[]): CommandResult {
    return this.options.runner.run('docker', args, {
      timeoutMs: this.timeoutMs,
    });
  }
  private intent(prepared: PreparedExecution): AttemptIntent {
    const intent = AttemptIntentSchema.parse(prepared.intent);
    const spec = intent.runtime_spec;
    const authority = spec.mounts.filter(
      (m) => m.target === ATTEMPT_AUTHORITY_PATH,
    );
    const contains = (root: string, path: string) =>
      path === root || path.startsWith(`${root}/`);
    if (
      sha256Hex(jcsCanonicalize(spec)) !== intent.runtime_spec_digest ||
      !sameRuntimeValue(spec.entrypoint, ['/usr/bin/timeout']) ||
      !spec.command.startsWith('/') ||
      spec.labels['quorum.campaign_id'] !== intent.identity.campaign_id ||
      spec.labels['quorum.attempt_id'] !==
        intent.identity.execution_attempt_id ||
      spec.labels['quorum.image_digest'] !== spec.image_digest ||
      spec.public_env.QUORUM_ATTEMPT_DIR !== intent.output_root ||
      spec.public_env.QUORUM_ATTEMPT_AUTHORITY_FILE !==
        ATTEMPT_AUTHORITY_PATH ||
      authority.length !== 1 ||
      authority[0]?.mode !== 'ro' ||
      contains(intent.output_root, ATTEMPT_AUTHORITY_PATH) ||
      contains(intent.output_root, authority[0].source) ||
      spec.mounts.some(
        (m) =>
          m.mode === 'rw' && contains(m.source, authority[0]?.source ?? ''),
      ) ||
      new Set(spec.mounts.map((m) => m.target)).size !== spec.mounts.length ||
      spec.mounts.some((m) => m.source.includes(',') || m.target.includes(','))
    ) {
      throw new AttemptContainerError(
        'invalid prepared runtime specification or authority mount',
      );
    }
    return intent;
  }
  private verifyCredentialProjection(intent: AttemptIntent): void {
    const spec = intent.runtime_spec;
    const projection = spec.credential_projection;
    const matches = spec.mounts.filter((m) => m.target === projection.path);
    const mount = matches[0];
    const within = (root: string, path: string) =>
      path === root || path.startsWith(`${root}/`);
    const index = spec.args.indexOf('--credentials-file');
    if (
      matches.length !== 1 ||
      mount?.mode !== 'ro' ||
      within(intent.output_root, mount.source) ||
      spec.mounts.some(
        (m) => m.mode === 'rw' && within(m.source, mount.source),
      ) ||
      index < 0 ||
      spec.args[index + 1] !== projection.path ||
      spec.args.lastIndexOf('--credentials-file') !== index
    )
      throw new AttemptContainerError(
        'selected credential projection mount or argv mismatch',
      );
    const body = readPinnedNoFollowFile(
      dirname(mount.source),
      [basename(mount.source)],
      'selected credential registry',
      true,
    );
    if (body === null || sha256Hex(body) !== projection.sha256)
      throw new AttemptContainerError(
        'selected credential projection digest mismatch',
      );
  }
  private image(spec: AttemptRuntimeSpec): {
    env: Record<string, string>;
    labels: Record<string, string>;
  } {
    const result = this.docker(['image', 'inspect', spec.image_digest]);
    if (result.status !== 0)
      throw new AttemptContainerError('image inspection failed');
    const images = JSON.parse(result.stdout);
    if (
      !Array.isArray(images) ||
      images.length !== 1 ||
      images[0]?.Id !== spec.image_digest ||
      !images[0].Config ||
      Object.keys(images[0].Config.Volumes ?? {}).length !== 0
    )
      throw new AttemptContainerError(
        'immutable image identity or volumes mismatch',
      );
    const labels = images[0].Config.Labels ?? {};
    if (
      typeof labels !== 'object' ||
      Array.isArray(labels) ||
      Object.values(labels).some((v) => typeof v !== 'string')
    )
      throw new AttemptContainerError('invalid image labels');
    return { env: parseEnvironment(images[0].Config.Env ?? []), labels };
  }
  private inspect(
    intent: AttemptIntent,
    target: string,
  ): OwnedRuntimeObservation {
    try {
      const spec = intent.runtime_spec;
      const defaults = this.image(spec);
      const response = this.docker(['inspect', target]);
      if (response.status !== 0)
        return response.stderr.trim() === `Error: No such object: ${target}`
          ? { kind: 'absent' }
          : { kind: 'unresolved', reason: 'container inspection failed' };
      const parsed = JSON.parse(response.stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1)
        throw new Error('inspection shape');
      const actual = parsed[0];
      const config = actual.Config;
      const host = actual.HostConfig;
      const expectedMounts = spec.mounts.map((m) => ({
        Type: 'bind',
        Source: m.source,
        Destination: m.target,
        RW: m.mode === 'rw',
        Propagation: 'rprivate',
      }));
      // Docker exposes tmpfs either in Mounts or only HostConfig.Tmpfs depending
      // on engine version. Every exposed mount must still match an exact target.
      const mounts = actual.Mounts.filter(
        (m: { Type: string; Destination: string; RW: boolean }) => {
          if (m.Type !== 'tmpfs') return true;
          if (
            !Object.hasOwn(runtimeTmpfs(spec), m.Destination) ||
            m.RW !== true
          )
            throw new Error('unexpected tmpfs mount');
          return false;
        },
      ).map(
        (m: {
          Type: string;
          Source: string;
          Destination: string;
          RW: boolean;
          Propagation: string;
        }) => ({
          Type: m.Type,
          Source: m.Source,
          Destination: m.Destination,
          RW: m.RW,
          Propagation: m.Propagation,
        }),
      );
      const order = (a: { Destination: string }, b: { Destination: string }) =>
        a.Destination.localeCompare(b.Destination);
      if (
        !CONTAINER_ID_RE.test(actual.Id) ||
        (CONTAINER_ID_RE.test(target) && actual.Id !== target) ||
        actual.Name !== `/${intent.container_name}` ||
        actual.Image !== spec.image_digest ||
        config.Image !== spec.image_digest ||
        !sameRuntimeValue(config.Labels, {
          ...defaults.labels,
          ...spec.labels,
        }) ||
        !sameRuntimeValue(parseEnvironment(config.Env), {
          ...defaults.env,
          ...spec.public_env,
        }) ||
        !sameRuntimeValue(config.Entrypoint, spec.entrypoint) ||
        !sameRuntimeValue(config.Cmd, runtimeCommand(spec)) ||
        actual.Path !== spec.entrypoint[0] ||
        !sameRuntimeValue(actual.Args, runtimeCommand(spec)) ||
        config.User !== `${spec.user.uid}:${spec.user.gid}` ||
        config.WorkingDir !== spec.cwd ||
        host.Init !== true ||
        !sameRuntimeValue(host.RestartPolicy, {
          Name: 'no',
          MaximumRetryCount: 0,
        }) ||
        host.PidMode !== '' ||
        host.IpcMode !== 'private' ||
        host.Privileged !== false ||
        !sameRuntimeValue(host.SecurityOpt, ['no-new-privileges']) ||
        !sameRuntimeValue(host.Tmpfs, runtimeTmpfs(spec)) ||
        !sameRuntimeValue(mounts.sort(order), expectedMounts.sort(order)) ||
        (host.CapAdd?.length ?? 0) !== 0 ||
        (host.CapDrop?.length ?? 0) !== 0 ||
        (host.Devices?.length ?? 0) !== 0 ||
        (host.DeviceRequests?.length ?? 0) !== 0 ||
        (host.Binds?.length ?? 0) !== 0 ||
        (host.VolumesFrom?.length ?? 0) !== 0 ||
        host.NetworkMode !== 'default' ||
        host.ReadonlyRootfs !== false
      )
        throw new Error('complete runtime specification mismatch');
      const state = actual.State;
      if (
        state?.Dead !== false ||
        state.Restarting !== false ||
        typeof state.Running !== 'boolean' ||
        !Number.isInteger(state.Pid)
      )
        throw new Error('unknown namespace state');
      const kind =
        state.Running && state.Pid > 0 && state.Status === 'running'
          ? 'matching-running'
          : !state.Running && state.Pid === 0 && state.Status === 'created'
            ? 'matching-created'
            : !state.Running && state.Pid === 0 && state.Status === 'exited'
              ? 'matching-stopped'
              : null;
      if (kind === null) throw new Error('unknown namespace state');
      return {
        kind,
        container_id: actual.Id,
        runtime_spec_digest: intent.runtime_spec_digest,
      };
    } catch {
      return {
        kind: 'unresolved',
        reason:
          'runtime identity, specification or namespace inspection unresolved',
      };
    }
  }
  async create(prepared: PreparedExecution): Promise<BoundExecution> {
    const intent = this.intent(prepared);
    this.options.assertCreateAuthorized({ intent });
    this.verifyCredentialProjection(intent);
    this.image(intent.runtime_spec);
    const spec = intent.runtime_spec;
    const argv = [
      'create',
      '--init',
      '--restart=no',
      '--name',
      intent.container_name,
      '--user',
      `${spec.user.uid}:${spec.user.gid}`,
      '--workdir',
      spec.cwd,
      '--ipc=private',
      '--security-opt=no-new-privileges',
      '--entrypoint',
      '/usr/bin/timeout',
    ];
    for (const [key, value] of Object.entries(spec.labels))
      argv.push('--label', `${key}=${value}`);
    for (const [key, value] of Object.entries(spec.public_env))
      argv.push('--env', `${key}=${value}`);
    for (const [path, options] of Object.entries(runtimeTmpfs(spec)))
      argv.push('--tmpfs', `${path}:${options}`);
    for (const m of spec.mounts)
      argv.push(
        '--mount',
        `type=bind,source=${m.source},target=${m.target}${m.mode === 'ro' ? ',readonly' : ''}`,
      );
    argv.push(spec.image_digest, ...runtimeCommand(spec));
    this.verifyCredentialProjection(intent);
    this.options.assertCreateAuthorized({ intent });
    const created = this.docker(argv);
    if (created.status !== 0 || !CONTAINER_ID_RE.test(created.stdout.trim()))
      throw new AttemptContainerError(
        'docker create did not return a canonical container identity; discover by prepared specification',
      );
    const id = created.stdout.trim();
    const observed = this.inspect(intent, id);
    if (observed.kind !== 'matching-created')
      throw new AttemptContainerError(
        'created container specification unresolved',
      );
    this.requests.set(id, 'never-issued');
    this.owned.set(id, intent.runtime_spec_digest);
    return { intent, container_id: id };
  }
  async start(bound: BoundExecution): Promise<AttemptMonitor> {
    const intent = this.intent(bound);
    ContainerIdSchema.parse(bound.container_id);
    this.options.assertStartAuthorized(bound);
    if (this.requests.get(bound.container_id) !== 'never-issued')
      throw new AttemptContainerError(
        'start request already issued or not created by this controller',
      );
    const observed = this.inspect(intent, bound.container_id);
    if (observed.kind !== 'matching-created')
      throw new AttemptContainerError(
        'start requires an exact created container',
      );
    this.verifyCredentialProjection(intent);
    this.options.assertStartAuthorized(bound);
    this.requests.set(bound.container_id, 'uncertain');
    this.uncertainAttempts.add(intent.identity.execution_attempt_id);
    const result = this.docker(['start', bound.container_id]);
    if (result.status !== 0)
      throw new AttemptContainerError('docker start completion unresolved');
    this.requests.set(bound.container_id, 'settled');
    this.uncertainAttempts.delete(intent.identity.execution_attempt_id);
    let stopped: VerifiedStopped | undefined;
    let failure: string | undefined;
    const stops: ((s: VerifiedStopped) => void)[] = [];
    const failures: ((s: string) => void)[] = [];
    const monitor: AttemptMonitor = {
      onStopped(cb) {
        stops.push(cb);
        if (stopped) cb(stopped);
      },
      onMonitorFailure(cb) {
        failures.push(cb);
        if (failure) cb(failure);
      },
    };
    // Start success is returned separately from this latched follower result.
    void Promise.resolve()
      .then(() =>
        (this.options.dockerWait ?? realDockerWait)(bound.container_id),
      )
      .then(() => {
        const observation = this.inspect(intent, bound.container_id);
        if (observation.kind !== 'matching-stopped')
          throw new Error('namespace death not established');
        stopped = this.death(bound, 'inspected_stopped');
        for (const cb of stops) cb(stopped);
      })
      .catch(() => {
        failure = 'attempt monitor failed; namespace death remains unverified';
        for (const cb of failures) cb(failure);
      });
    return monitor;
  }
  async inspectOwned(
    prepared: PreparedExecution,
  ): Promise<OwnedRuntimeObservation> {
    const intent = this.intent(prepared);
    if (this.uncertainAttempts.has(intent.identity.execution_attempt_id))
      return {
        kind: 'unresolved',
        reason: 'start operation completion is uncertain',
      };
    const observed = this.inspect(intent, intent.container_name);
    if (
      'container_id' in observed &&
      this.requests.get(observed.container_id) === 'uncertain'
    )
      return {
        kind: 'unresolved',
        reason: 'start operation completion is uncertain',
      };
    return observed;
  }
  private death(
    bound: BoundExecution,
    proof: 'inspected_stopped' | 'verified_absent',
  ): VerifiedStopped {
    return {
      execution_attempt_id: bound.intent.identity.execution_attempt_id,
      container_id: bound.container_id,
      proof,
      observed_at: new Date().toISOString(),
    };
  }
  async stop(
    bound: BoundExecution,
    graceSeconds: number,
  ): Promise<StopObservation> {
    const intent = this.intent(bound);
    ContainerIdSchema.parse(bound.container_id);
    if (!Number.isFinite(graceSeconds) || graceSeconds < 0)
      throw new AttemptContainerError('invalid stop grace');
    // Authenticate the complete spec even for cancellation-discovered IDs.
    const before = this.inspect(intent, bound.container_id);
    if (
      before.kind === 'unresolved' &&
      this.owned.get(bound.container_id) !== intent.runtime_spec_digest
    )
      return before;
    if (before.kind !== 'absent') {
      try {
        this.docker([
          'stop',
          '--time',
          String(Math.ceil(graceSeconds)),
          bound.container_id,
        ]);
      } catch {
        /* Inspect may prove death, but never settles a start request. */
      }
    }
    const settlement =
      this.requests.get(bound.container_id) ??
      this.options.startSettlement(bound);
    if (settlement === 'uncertain')
      return {
        kind: 'unresolved',
        reason: 'start operation completion is uncertain',
      };
    const after = this.inspect(intent, bound.container_id);
    if (after.kind === 'matching-stopped' || after.kind === 'matching-created')
      return { kind: 'dead', stopped: this.death(bound, 'inspected_stopped') };
    if (after.kind === 'absent')
      return { kind: 'dead', stopped: this.death(bound, 'verified_absent') };
    return { kind: 'unresolved', reason: 'namespace death remains unverified' };
  }
}

export interface PrepareContainerExecutionArgs extends PrepareAttemptStageArgs {
  readonly grader: Grader;
  readonly identity: CampaignIdentity;
  readonly inputDigest: string;
  readonly startId: string;
  readonly primaryBlockId: string;
  readonly attemptNumber: number;
  readonly imageDigest: string;
  readonly evalsSha: string;
  readonly maxTimeSeconds: number;
  readonly gauntletRoot: string;
  readonly binRoot: string;
  readonly superpowersTree: string | null;
  readonly scenarioDir: string;
}

/** Prepare private inputs before committing the intent. The one authority file
 * is outside every writable source and is never a host lease or bundle mount. */
export function prepareContainerExecution(
  args: PrepareContainerExecutionArgs,
): PreparedExecution {
  if (args.identity.execution_attempt_id !== args.attemptId)
    throw new AttemptContainerError('attempt identity mismatch');
  const stage = prepareAttemptStage(args);
  const credentialsBody = stage.credentialRegistry;
  if (credentialsBody === undefined)
    throw new AttemptContainerError('selected credential registry missing');
  const credentialsRelative = [
    'control',
    sha256Hex(args.attemptId),
    'credentials.yaml',
  ];
  const credentialsSource = join(args.campaignDir, ...credentialsRelative);
  const credentialsTarget = '/run/quorum/credentials.yaml';
  const authorityRelative = [
    'control',
    sha256Hex(args.attemptId),
    'attempt-authority.json',
  ];
  const authoritySource = join(args.campaignDir, ...authorityRelative);
  const mounts = buildAttemptMounts({
    ...args,
    attemptDir: stage.attemptDir,
    subjectEnvFile: stage.subjectEnvFile,
    graderEnvFile: stage.graderEnvFile,
    passwdFile: stage.passwdFile,
    groupFile: stage.groupFile,
  });
  mounts.push({
    source: authoritySource,
    target: ATTEMPT_AUTHORITY_PATH,
    mode: 'ro',
  });
  mounts.push({
    source: credentialsSource,
    target: credentialsTarget,
    mode: 'ro',
  });
  const runtimeSpec: AttemptRuntimeSpec = {
    credential_projection: {
      path: credentialsTarget,
      sha256: sha256Hex(credentialsBody),
    },
    image_digest: args.imageDigest,
    command: join(args.evalsRoot, 'container', 'attempt-entrypoint.sh'),
    entrypoint: ['/usr/bin/timeout'],
    labels: {
      'quorum.campaign_id': args.identity.campaign_id,
      'quorum.attempt_id': args.attemptId,
      'quorum.evals_sha': args.evalsSha,
      'quorum.image_digest': args.imageDigest,
    },
    args: buildCampaignChildArgv({
      evalsRoot: args.evalsRoot,
      scenarioDir: args.scenarioDir,
      codingAgent: args.agent,
      codingAgentsDir: join(args.evalsRoot, 'coding-agents'),
      outRoot: stage.stagingDir,
      os: 'linux',
      credentialName: args.credentialName,
      credentialsFile: credentialsTarget,
      gauntletBin: join(args.binRoot, 'gauntlet'),
      graderModel: args.grader.model,
      superpowers:
        args.superpowersTree === null
          ? { mode: 'none' }
          : { mode: 'root', root: args.superpowersTree },
      identity: args.identity,
    }),
    cwd: args.evalsRoot,
    user: { uid: args.uid, gid: args.gid },
    mounts,
    public_env: {
      HOME: stage.homeDir,
      TMPDIR: ATTEMPT_RUNTIME_DIR,
      TMUX_TMPDIR: ATTEMPT_RUNTIME_DIR,
      XDG_CONFIG_HOME: join(stage.homeDir, '.config'),
      XDG_CACHE_HOME: join(stage.homeDir, '.cache'),
      XDG_STATE_HOME: join(stage.homeDir, '.local/state'),
      QUORUM_COVERED_BY_LIVE_SPEND_LOCK: '1',
      QUORUM_GRADER_SOURCE_MODE: 'appliance-scoped',
      QUORUM_ATTEMPT_DIR: stage.attemptDir,
      QUORUM_SUBJECT_FILE: '/run/quorum/subject.env',
      QUORUM_GRADER_FILE: '/run/quorum/grader.env',
      QUORUM_ATTEMPT_AUTHORITY_FILE: ATTEMPT_AUTHORITY_PATH,
    },
    init: true,
    restart: 'no',
    pid_namespace: 'private',
    ipc_namespace: 'private',
    privileged: false,
    no_new_privileges: true,
    tmpfs_bytes: ATTEMPT_TMPFS_BYTES,
    max_time_s: args.maxTimeSeconds,
    graceful_shutdown_s: 5,
  };
  const intent = AttemptIntentSchema.parse({
    identity: args.identity,
    primary_block_id: args.primaryBlockId,
    attempt_number: args.attemptNumber,
    output_root: stage.attemptDir,
    container_name: containerNameForAttempt(
      args.identity.campaign_id,
      args.attemptId,
    ),
    runtime_spec_digest: sha256Hex(jcsCanonicalize(runtimeSpec)),
    runtime_spec: runtimeSpec,
  });
  const authority = PreparedAttemptAuthoritySchema.parse({
    schema_version: 1,
    campaign_id: args.identity.campaign_id,
    input_digest: args.inputDigest,
    start_id: args.startId,
    intent,
  });
  const campaignPin = pinAbsoluteDir(args.campaignDir, 'campaign directory');
  try {
    writePinnedFile(
      campaignPin,
      credentialsRelative,
      credentialsBody,
      'selected credential registry',
      0o400,
    );
    writePinnedFile(
      campaignPin,
      authorityRelative,
      `${JSON.stringify(authority)}\n`,
      'private attempt authority',
      0o400,
    );
  } finally {
    closePin(campaignPin);
  }
  const attemptPin = pinAbsoluteDir(stage.attemptDir, 'attempt directory');
  try {
    writePinnedFile(attemptPin, ['stdout.log'], '', 'attempt stdout', 0o600);
    writePinnedFile(attemptPin, ['stderr.log'], '', 'attempt stderr', 0o600);
  } finally {
    closePin(attemptPin);
  }
  return { intent };
}
