import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { CommandResult, CommandRunner } from '../agents/command-runner.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import type { SuperpowersSpec } from '../agents/superpowers.ts';
import {
  closePin,
  pinAbsoluteDir,
  readPinnedNoFollowFile,
  writePinnedFile,
} from '../appliance/credential-scope.ts';
import type { CampaignIdentity } from '../contracts/campaign/campaign.ts';
import { CampaignIdentitySchema } from '../contracts/campaign/campaign.ts';
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
import type { PrepareAttemptStageArgs } from './attempt-projection.ts';
import { prepareAttemptStage } from './attempt-projection.ts';
import {
  ATTEMPT_AUTHORITY_PATH,
  PreparedAttemptAuthoritySchema,
} from './child-authority.ts';

interface AttemptMount {
  source: string;
  target: string;
  mode: 'ro' | 'rw';
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

export const ATTEMPT_TMPFS_BYTES = 2 * 1024 * 1024 * 1024;
export const ATTEMPT_RUNTIME_DIR = '/run/quorum/attempt';

const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

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
    const startedAt = new Date().toISOString();
    this.requests.set(bound.container_id, 'settled');
    this.uncertainAttempts.delete(intent.identity.execution_attempt_id);
    let stopped: VerifiedStopped | undefined;
    let failure: string | undefined;
    const stops: ((s: VerifiedStopped) => void)[] = [];
    const failures: ((s: string) => void)[] = [];
    const notify = <T>(
      kind: 'stopped' | 'failure',
      callbacks: readonly ((value: T) => void)[],
      value: T,
    ): void => {
      let thrown = 0;
      // A callback may subscribe during delivery. The latch handles that late
      // subscriber; the snapshot prevents a second notification in this pass.
      for (const callback of [...callbacks]) {
        try {
          callback(value);
        } catch {
          thrown++;
        }
      }
      if (thrown > 0) {
        // Consumer failures belong to the controller's abort path. This last-
        // resort diagnostic exposes the failure without leaking thrown values.
        process.stderr.write(
          `attempt ${intent.identity.execution_attempt_id}: ${kind} notification had ${thrown} throwing subscriber(s); runtime outcome unchanged\n`,
        );
      }
    };
    const monitor: AttemptMonitor = {
      startedAt,
      onStopped(cb) {
        if (stopped) notify('stopped', [cb], stopped);
        else stops.push(cb);
      },
      onMonitorFailure(cb) {
        if (failure) notify('failure', [cb], failure);
        else failures.push(cb);
      },
    };
    // Start success is returned separately from this latched follower result.
    // Only follower/inspection errors select failure; delivery is downstream.
    void Promise.resolve()
      .then(() =>
        (this.options.dockerWait ?? realDockerWait)(bound.container_id),
      )
      .then(() => {
        const observation = this.inspect(intent, bound.container_id);
        if (observation.kind !== 'matching-stopped')
          throw new Error('namespace death not established');
        return this.death(bound, 'inspected_stopped');
      })
      .then(
        (verified) => {
          stopped = verified;
          notify('stopped', stops, stopped);
        },
        () => {
          failure =
            'attempt monitor failed; namespace death remains unverified';
          notify('failure', failures, failure);
        },
      );
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
  /** A finished or rejected client call does not settle the daemon start. */
  assertNoUnsettledStarts(): void {
    if (
      this.uncertainAttempts.size ||
      [...this.requests.values()].some((state) => state === 'uncertain')
    )
      throw new AttemptContainerError(
        'start operation completion is uncertain',
      );
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

export interface CampaignChildArgvArgs {
  readonly evalsRoot: string;
  readonly scenarioDir: string;
  readonly codingAgent: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  readonly os: string;
  readonly credentialName: string;
  readonly credentialsFile: string;
  readonly gauntletBin: string;
  /** The registered grader model (R-REG-20 singular grader). Authoritative
   *  for campaign children: without it the child grades with the runner's
   *  pinned default and the frozen campaign document lies about its grader. */
  readonly graderModel: string;
  readonly superpowers: SuperpowersSpec;
  readonly identity: CampaignIdentity;
}

/** R-SPN-8: the child argv addresses the SNAPSHOT's own entrypoint
 *  (`bun <evalsRoot>/src/cli/index.ts run …`, cwd inside the snapshot).
 *  A PATH-resolved or host-checkout quorum binary is forbidden. Carries the
 *  explicit superpowers mode, gauntletBin, and the campaign identity block
 *  (R-SPN-9, R-SPN-4). */
export function buildCampaignChildArgv(args: CampaignChildArgvArgs): string[] {
  const identity = CampaignIdentitySchema.parse(args.identity);
  const argv: string[] = [
    `${args.evalsRoot}/src/cli/index.ts`,
    'run',
    args.scenarioDir,
    '--coding-agent',
    args.codingAgent,
    '--coding-agents-dir',
    args.codingAgentsDir,
    '--out-root',
    args.outRoot,
    '--os',
    args.os,
    '--credential',
    args.credentialName,
    '--credentials-file',
    args.credentialsFile,
    '--gauntlet-bin',
    args.gauntletBin,
    '--grader-model',
    args.graderModel,
  ];
  if (args.superpowers.mode === 'root') {
    argv.push('--superpowers-root', args.superpowers.root);
  } else {
    argv.push('--no-superpowers');
  }
  argv.push('--campaign-identity', JSON.stringify(identity));
  return argv;
}
