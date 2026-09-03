import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import type { CommandResult, CommandRunner } from '../agents/command-runner.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import type { Clock } from '../scheduler/clock.ts';
import { COVERED_BY_LOCK_ENV } from './locks.ts';
import {
  type AttemptMount,
  type AttemptSpawnContext,
  type CampaignChildSpec,
  type ChildSpawner,
  SpawnError,
  type SpawnedCampaignChild,
} from './spawn.ts';

export const ATTEMPT_TMPFS_BYTES = 2 * 1024 * 1024 * 1024;
export const ATTEMPT_RUNTIME_DIR = '/run/quorum/attempt';

const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export class AttemptContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptContainerError';
  }
}

/** The Docker command seam used by the attempt spawner. */
export type AttemptDocker = CommandRunner;

/** Production Docker seam. Tests should inject a CommandRunner instead. */
export const realAttemptDocker: AttemptDocker = defaultCommandRunner;

export type DockerWait = (containerId: string) => Promise<number>;

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
  readonly Target?: string;
  readonly ReadOnly?: boolean;
  readonly RW?: boolean;
}

interface InspectedContainer {
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
}

export class ContainerAttemptSpawner implements ChildSpawner {
  readonly kind = 'container' as const;
  private readonly args: ContainerAttemptSpawnerArgs;

  constructor(args: ContainerAttemptSpawnerArgs) {
    if (!IMAGE_DIGEST_RE.test(args.imageDigest)) {
      throw new AttemptContainerError(
        'container image digest is not canonical',
      );
    }
    this.args = args;
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
      this.removeExactContainer(containerId);
      throw error;
    }
    return this.inertHandle(containerId, containerName);
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
      actualName === containerName &&
      imageIds.length > 0 &&
      imageIds.every((image) => image === this.args.imageDigest) &&
      labels?.['quorum.campaign_id'] === this.args.campaignId &&
      labels['quorum.attempt_id'] === attempt.attemptId &&
      labels['quorum.evals_sha'] === this.args.evalsSha;
    if (!identityMatches) {
      throw new AttemptContainerError(
        'container identity, image, or label verification failed',
      );
    }

    const observedMounts = observed.Mounts ?? observed.HostConfig?.Mounts;
    if (!this.sameMounts(attempt.mounts, observedMounts ?? [])) {
      throw new AttemptContainerError('container mount verification failed');
    }
  }

  private sameMounts(
    expected: readonly AttemptMount[],
    observed: readonly InspectedMount[],
  ): boolean {
    const key = (mount: {
      readonly Type?: string;
      readonly Source?: string;
      readonly Target?: string;
      readonly ReadOnly?: boolean;
      readonly RW?: boolean;
    }): string => {
      const readOnly =
        mount.ReadOnly !== undefined ? mount.ReadOnly : mount.RW === false;
      return `${mount.Type ?? ''}|${mount.Source ?? ''}|${mount.Target ?? ''}|${readOnly}`;
    };
    const expectedKeys = expected.map((mount) =>
      key({
        Type: 'bind',
        Source: mount.source,
        Target: mount.target,
        ReadOnly: mount.mode === 'ro',
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
    // Cleanup errors must not replace the original typed failure, and Docker
    // receives only the validated full ID captured from create.
    this.docker(['rm', containerId]);
  }

  private inertHandle(
    containerId: string,
    containerName: string,
  ): SpawnedCampaignChild {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
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
      },
      onStderrLine(cb) {
        for (const line of stderrLines) cb(line);
      },
      onExit(_cb) {
        // Durable following and terminal publication are Task 3.
      },
    };
  }
}
