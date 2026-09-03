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
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '../agents/command-runner.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import type { Clock } from '../scheduler/clock.ts';
import {
  type PreparedAttemptStage,
  prepareAttemptStage,
} from './attempt-projection.ts';
import { COVERED_BY_LOCK_ENV } from './locks.ts';
import {
  type AttemptMount,
  type AttemptSpawnContext,
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
