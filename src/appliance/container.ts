import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { CommandResult, CommandRunner } from '../agents/command-runner.ts';
import type { CredentialScope } from '../credentials/scope.ts';
import {
  type ActiveCredentialMaterial,
  activateScopedCredentialMaterial,
  assertCredentialBundleBoundary,
  assertScopedCredentialStateBoundary,
  discardStagedCredentialMaterial,
  type ProjectedAuthMount,
  recoverScopedCredentialActivation,
  type StagedCredentialMaterial,
} from './credential-scope.ts';
import { ApplianceError, type ApplianceErrorCode } from './errors.ts';
import {
  type LoadedApplianceConfig,
  type LoadedApplianceStateConfig,
  ProcessGroupIdSchema,
} from './types.ts';

type AuthMountName = 'codex' | 'gemini' | 'kimi' | 'pi';
type ContainerState = 'missing' | 'stopped' | 'running';

export interface AuthMount {
  readonly name: AuthMountName;
  readonly path: string;
}

export interface ContainerIdentity {
  readonly id: string | null;
  readonly image_id: string | null;
}

const AUTH_DIRS: readonly {
  readonly name: AuthMountName;
  readonly bundleSubdir: string;
}[] = [
  { name: 'codex', bundleSubdir: 'codex' },
  { name: 'gemini', bundleSubdir: 'gemini' },
  { name: 'kimi', bundleSubdir: 'kimi-code' },
  { name: 'pi', bundleSubdir: 'pi' },
];

function commandSummary(result: {
  status: number | null;
  stdout: string;
  stderr: string;
}): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return [
    `status=${result.status ?? 'null'}`,
    `stdout=${stdout === '' ? '<empty>' : stdout}`,
    `stderr=${stderr === '' ? '<empty>' : stderr}`,
  ].join(' ');
}

function requireContainerCommand(
  result: { status: number | null; stdout: string; stderr: string },
  code: ApplianceErrorCode,
  action: string,
): void {
  if (result.status !== 0) {
    throw new ApplianceError(
      code,
      'container',
      `${action}: ${commandSummary(result)}`,
    );
  }
}

export function evalsContainerPath(loaded: LoadedApplianceStateConfig): string {
  return join(loaded.config.evals.path, 'scripts/evals-container');
}

export function discoveredAuthDirs(loaded: LoadedApplianceConfig): AuthMount[] {
  return AUTH_DIRS.flatMap(({ name, bundleSubdir }) => {
    const path = join(loaded.config.credential_bundle.path, bundleSubdir);
    return existsSync(path) ? [{ name, path }] : [];
  });
}

export function baseContainerArgs(loaded: LoadedApplianceConfig): string[] {
  const bundle = loaded.config.credential_bundle.path;
  const args = [
    '--name',
    loaded.config.container.name,
    '--superpowers-root',
    loaded.config.superpowers.path,
    '--env-file',
    join(bundle, 'credentials.env'),
  ];
  for (const auth of discoveredAuthDirs(loaded)) {
    args.push('--auth', `${auth.name}=${auth.path}`);
  }
  return args;
}

export function buildContainerArgs(loaded: LoadedApplianceConfig): string[] {
  return [
    '--name',
    loaded.config.container.name,
    '--gauntlet-root',
    loaded.config.gauntlet.path,
    'build',
  ];
}

export function upContainerArgs(loaded: LoadedApplianceConfig): string[] {
  return [...baseContainerArgs(loaded), 'up'];
}

export function downContainerArgs(loaded: LoadedApplianceConfig): string[] {
  return ['--name', loaded.config.container.name, 'down'];
}

// Name-only wrapper invocation: no bundle env-file or auth mounts ride the
// status subcommand, so structural callers (doctor's probe) may use it.
export function statusContainerArgs(
  loaded: LoadedApplianceStateConfig,
): string[] {
  return ['--name', loaded.config.container.name, 'status'];
}

export function execContainerArgs(
  loaded: LoadedApplianceConfig,
  command: readonly string[],
): string[] {
  return [...baseContainerArgs(loaded), 'exec', ...command];
}

export function containerMountSignature(loaded: LoadedApplianceConfig): string {
  const payload = {
    evals: loaded.config.evals.path,
    superpowers: loaded.config.superpowers.path,
    results_root: loaded.config.container.results_root,
    bundle: loaded.config.credential_bundle.path,
    auth_dirs: discoveredAuthDirs(loaded),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function buildContainer(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
): void {
  const result = runner.run(
    evalsContainerPath(loaded),
    buildContainerArgs(loaded),
  );
  requireContainerCommand(result, 'image_build_failed', 'image build failed');
}

export function upContainer(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
): void {
  const result = runner.run(
    evalsContainerPath(loaded),
    upContainerArgs(loaded),
  );
  requireContainerCommand(result, 'container_unhealthy', 'container up failed');
}

export function downContainer(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
): void {
  const result = runner.run(
    evalsContainerPath(loaded),
    downContainerArgs(loaded),
  );
  requireContainerCommand(
    result,
    'container_recreate_required',
    'container down failed',
  );
}

export function inspectContainerState(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
): ContainerState {
  const result = runner.run(
    evalsContainerPath(loaded),
    statusContainerArgs(loaded),
  );
  requireContainerCommand(
    result,
    'container_unhealthy',
    'container status failed',
  );
  if (result.stdout.includes('exists, running')) {
    return 'running';
  }
  if (result.stdout.includes('exists, stopped')) {
    return 'stopped';
  }
  if (result.stdout.includes('missing')) {
    return 'missing';
  }
  throw new ApplianceError(
    'container_unhealthy',
    'container',
    `container status is unknown: ${commandSummary(result)}`,
  );
}

export function reconcileContainer(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
): void {
  const state = inspectContainerState(loaded, runner);
  if (state !== 'missing') {
    downContainer(loaded, runner);
  }
  upContainer(loaded, runner);
}

export function statusContainer(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
): void {
  const result = runner.run(
    evalsContainerPath(loaded),
    statusContainerArgs(loaded),
  );
  requireContainerCommand(
    result,
    'container_unhealthy',
    'container status failed',
  );
  if (!result.stdout.includes('exists, running')) {
    throw new ApplianceError(
      'container_unhealthy',
      'container',
      `container is not running: ${commandSummary(result)}`,
    );
  }
}

function stringField(record: unknown, key: string): string | null {
  if (typeof record === 'object' && record !== null) {
    const value = (record as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

export function inspectContainerIdentity(
  loaded: LoadedApplianceStateConfig,
  runner: CommandRunner,
): ContainerIdentity {
  const result = runner.run('docker', [
    'container',
    'inspect',
    loaded.config.container.name,
  ]);
  if (result.status !== 0) {
    return { id: null, image_id: null };
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    return {
      id: stringField(record, 'Id'),
      image_id: stringField(record, 'Image') ?? stringField(record, 'ImageID'),
    };
  } catch {
    return { id: null, image_id: null };
  }
}

export function runInContainer(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
  command: readonly string[],
  code: ApplianceErrorCode,
  action: string,
) {
  const result = runner.run(
    evalsContainerPath(loaded),
    execContainerArgs(loaded, command),
  );
  requireContainerCommand(result, code, action);
  return result;
}

export interface RecordedContainerIdentity {
  readonly name: string;
  readonly id: string;
}

export type RecordedLifecycleOperation =
  | 'probe-process-group'
  | 'interrupt-process-group';

function recordedLifecycleFault(message: string): ApplianceError {
  return new ApplianceError('config_invalid', 'container', message);
}

/**
 * The closed lifecycle seam for containers RECORDED on a job: probe or
 * interrupt one in-container process group, targeting the immutable recorded
 * container ID directly with exactly one fixed `docker exec`. It never rides
 * the wrapper's full-bundle argument path — no env-file, no auth mounts, no
 * arbitrary command, environment, mount, scope, or bundle path can reach it.
 *
 * Validation happens BEFORE any runner call: the recorded id must be
 * nonblank, the recorded name must equal the configured container name, the
 * process group id must be a safe integer > 1 (repeating JobProcessSchema's
 * check at this boundary), and the operation switch is runtime-exhaustive.
 * The configured name is then inspected and the current container ID must
 * equal the recorded ID — a replacement container is a typed refusal after
 * inspect, with no exec (liveness callers report lost; cancellation sends no
 * signal). Host-side process group handling lives elsewhere and is
 * unchanged.
 */
export function runRecordedContainerLifecycle(
  loaded: LoadedApplianceStateConfig,
  runner: CommandRunner,
  identity: RecordedContainerIdentity,
  operation: RecordedLifecycleOperation,
  processGroupId: number,
): CommandResult {
  if (identity.id.trim() === '') {
    throw recordedLifecycleFault(
      'recorded container id is blank; refusing to signal',
    );
  }
  if (identity.name !== loaded.config.container.name) {
    throw recordedLifecycleFault(
      `recorded container name '${identity.name}' does not match configured '${loaded.config.container.name}'`,
    );
  }
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 1 ||
    !ProcessGroupIdSchema.safeParse(processGroupId).success
  ) {
    throw recordedLifecycleFault(
      `process group id must be a safe integer greater than 1, got: ${processGroupId}`,
    );
  }
  let signal: string;
  switch (operation) {
    case 'probe-process-group':
      signal = '-0';
      break;
    case 'interrupt-process-group':
      signal = '-INT';
      break;
    default:
      throw recordedLifecycleFault(
        `unknown recorded lifecycle operation: ${String(operation)}`,
      );
  }

  const current = inspectContainerIdentity(loaded, runner);
  if (current.id === null) {
    throw recordedLifecycleFault(
      `configured container '${identity.name}' is not inspectable; recorded container ${identity.id} is gone`,
    );
  }
  if (current.id !== identity.id) {
    throw recordedLifecycleFault(
      `configured container '${identity.name}' is a replacement (current id does not match the recorded id); refusing to signal it`,
    );
  }
  return runner.run('docker', [
    'exec',
    identity.id,
    'bash',
    '-c',
    `kill ${signal} -- -${processGroupId}`,
  ]);
}

// ---------------------------------------------------------------------------
// Scoped container primitives (F13). These live BESIDE the full-bundle
// helpers above until Task 5's atomic caller cutover deletes that path; they
// offer no omission mode — every lease carries an asserted scope, and the
// discriminated staged/active material is the sole scope authority at this
// boundary.

/**
 * The immutable identity of one scoped container generation: the configured
 * name, the container ID captured from `docker run` stdout (never a later
 * name lookup), and the asserted credential scope it was upped with. Scoped
 * exec always targets `id`.
 */
export interface ContainerLease {
  readonly name: string;
  readonly id: string;
  readonly imageId: string | null;
  readonly mountSignature: string;
  readonly credentialScope: CredentialScope;
}

function scopedContainerFault(message: string): ApplianceError {
  return new ApplianceError('config_invalid', 'container', message);
}

function insideDir(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolved = resolve(path);
  return resolved !== resolvedRoot && resolved.startsWith(resolvedRoot + sep);
}

// Mirrors credential-scope's fixed slot layout. Activation re-validates the
// staging slot authoritatively, but reconciliation must refuse a displaced
// stage BEFORE the container is downed, so the fixed path is derived here
// too.
function fixedScopedSlot(
  loaded: LoadedApplianceConfig,
  slot: 'staging' | 'active',
): string {
  return join(loaded.config.root, 'state', 'credentials-scoped', slot);
}

// The one consistency rule for both staged and active material: the material
// discriminant must match its scope's, empty material can carry no
// supervisor file or mounts, live material must carry its supervisor file,
// the auth mounts must correspond exactly to the scope's own oauth
// projection, and every projected path must stay under the material's root.
function requireScopedMaterialShape(
  label: string,
  material: {
    readonly kind: 'empty' | 'live';
    readonly credentialScope: CredentialScope;
    readonly agentEnvFile: string;
    readonly supervisorExecEnvFile: string | null;
    readonly authMounts: readonly ProjectedAuthMount[];
  },
  rootDir: string,
): void {
  const scope = material.credentialScope;
  if (material.kind !== scope.kind) {
    throw scopedContainerFault(
      `${label} pairs ${material.kind} material with a ${scope.kind} credential scope; the material discriminant is the sole scope authority`,
    );
  }
  if (scope.kind === 'empty') {
    if (material.supervisorExecEnvFile !== null) {
      throw scopedContainerFault(
        `empty ${label} cannot carry a supervisor exec env file`,
      );
    }
    if (material.authMounts.length !== 0) {
      throw scopedContainerFault(`empty ${label} cannot carry auth mounts`);
    }
  } else {
    if (
      typeof material.supervisorExecEnvFile !== 'string' ||
      material.supervisorExecEnvFile === ''
    ) {
      throw scopedContainerFault(
        `live ${label} must carry its supervisor exec env file`,
      );
    }
    if (!insideDir(material.supervisorExecEnvFile, rootDir)) {
      throw scopedContainerFault(
        `${label} supervisor exec env file escapes its root: ${material.supervisorExecEnvFile}`,
      );
    }
    const expected = scope.oauth === null ? [] : [scope.oauth.mountName];
    const actual = material.authMounts.map((mount) => mount.name);
    if (
      actual.length !== expected.length ||
      expected.some((name, index) => actual[index] !== name)
    ) {
      throw scopedContainerFault(
        `${label} auth mounts [${actual.join(', ')}] do not correspond exactly to the scope's oauth projection [${expected.join(', ')}]`,
      );
    }
  }
  if (!insideDir(material.agentEnvFile, rootDir)) {
    throw scopedContainerFault(
      `${label} agent env file escapes its root: ${material.agentEnvFile}`,
    );
  }
  for (const mount of material.authMounts) {
    if (!insideDir(mount.path, rootDir)) {
      throw scopedContainerFault(
        `${label} auth mount '${mount.name}' escapes its root: ${mount.path}`,
      );
    }
  }
}

/**
 * Scoped wrapper `up` argv: the active agent env file, --no-default-auth
 * (which also disables every wrapper host-home fallback), and only the exact
 * projected auth directories. The supervisor exec env file never appears
 * here — it crosses only at exec time.
 */
export function scopedUpContainerArgs(
  loaded: LoadedApplianceConfig,
  active: ActiveCredentialMaterial,
): string[] {
  if (resolve(active.root) !== fixedScopedSlot(loaded, 'active')) {
    throw scopedContainerFault(
      `active material does not point at the fixed active slot: ${active.root}`,
    );
  }
  requireScopedMaterialShape('active material', active, active.root);
  const args = [
    '--name',
    loaded.config.container.name,
    '--superpowers-root',
    loaded.config.superpowers.path,
    '--env-file',
    active.agentEnvFile,
    '--no-default-auth',
  ];
  for (const mount of active.authMounts) {
    args.push('--auth', `${mount.name}=${mount.path}`);
  }
  args.push('up');
  return args;
}

/**
 * Scoped wrapper `exec` argv: only the configured name, the expected
 * immutable container ID, the optional exec env file, `exec`, and the
 * command. It never rides baseContainerArgs and never rediscovers bundle
 * paths.
 */
export function scopedExecContainerArgs(
  loaded: LoadedApplianceConfig,
  lease: ContainerLease,
  command: readonly string[],
  options: { readonly execEnvFile?: string } = {},
): string[] {
  if (lease.name !== loaded.config.container.name) {
    throw scopedContainerFault(
      `lease container name '${lease.name}' does not match configured '${loaded.config.container.name}'`,
    );
  }
  if (lease.id.trim() === '' || /\s/.test(lease.id)) {
    throw scopedContainerFault(
      'lease container id must be a single non-blank token',
    );
  }
  if (command.length === 0) {
    throw scopedContainerFault('scoped exec requires a command');
  }
  const args = [
    '--name',
    loaded.config.container.name,
    '--expected-container-id',
    lease.id,
  ];
  if (options.execEnvFile !== undefined) {
    if (!isAbsolute(options.execEnvFile)) {
      throw scopedContainerFault(
        `exec env file must be an absolute path: ${options.execEnvFile}`,
      );
    }
    args.push('--exec-env-file', options.execEnvFile);
  }
  args.push('exec', ...command);
  return args;
}

// The scoped mount signature describes the ASSERTED scope and the active
// destinations — configured paths and mount names only, never credential
// values, so a secret rotation does not change it.
function scopedMountSignature(
  loaded: LoadedApplianceConfig,
  active: ActiveCredentialMaterial,
): string {
  const scope = active.credentialScope;
  const payload = {
    evals: loaded.config.evals.path,
    superpowers: loaded.config.superpowers.path,
    results_root: loaded.config.container.results_root,
    scope: {
      kind: scope.kind,
      agent: scope.agent,
      runtime_family: scope.runtimeFamily,
      credential: scope.credential,
    },
    agent_env_file: active.agentEnvFile,
    supervisor_exec_env_file: active.supervisorExecEnvFile,
    auth_mounts: active.authMounts.map((mount) => ({
      name: mount.name,
      path: mount.path,
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// Inspect the captured container BY ID and require the record to identify
// exactly that ID; a name lookup is never blessed as the lease identity.
// Returns the image id for the lease.
function inspectCapturedContainer(
  runner: CommandRunner,
  capturedId: string,
): string | null {
  const result = runner.run('docker', ['container', 'inspect', capturedId]);
  if (result.status !== 0) {
    throw new ApplianceError(
      'container_unhealthy',
      'container',
      `captured container ${capturedId} is not inspectable: ${commandSummary(result)}`,
    );
  }
  let record: unknown;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    record = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    throw new ApplianceError(
      'container_unhealthy',
      'container',
      `captured container ${capturedId} inspection returned malformed JSON`,
    );
  }
  const id = stringField(record, 'Id');
  if (id === null) {
    throw new ApplianceError(
      'container_unhealthy',
      'container',
      `captured container ${capturedId} inspection returned no id`,
    );
  }
  if (id !== capturedId) {
    throw new ApplianceError(
      'container_unhealthy',
      'container',
      `inspection of captured container ${capturedId} identified a different container; refusing to bless it`,
    );
  }
  return stringField(record, 'Image') ?? stringField(record, 'ImageID');
}

/**
 * Reconcile the configured container onto one staged scoped generation and
 * return its immutable lease: validate the discriminated material and both
 * state boundaries first (mismatch/tamper fails with zero container calls),
 * inspect and down any existing container, recover an interrupted prior
 * activation, activate the stage, up with --no-default-auth and only the
 * exact projected material, then capture the container ID from the scoped
 * `docker run` stdout and verify it by direct inspection of that exact ID.
 *
 * A pre-activation inspect/down/recovery failure discards the owned staging
 * slot best-effort (the original typed error wins; active/recovery are never
 * touched). A post-up failure rolls back the captured ID directly — a
 * replacement under the configured name is never stopped — retaining the
 * original typed failure and appending any cleanup failure without values.
 */
export function reconcileScopedContainer(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
  staged: StagedCredentialMaterial,
): ContainerLease {
  if (resolve(staged.stageDir) !== fixedScopedSlot(loaded, 'staging')) {
    throw scopedContainerFault(
      `staged material does not point at the fixed staging slot: ${staged.stageDir}`,
    );
  }
  requireScopedMaterialShape('staged material', staged, staged.stageDir);
  assertScopedCredentialStateBoundary(loaded);
  if (staged.kind === 'live') {
    assertCredentialBundleBoundary(loaded.config);
  }

  try {
    if (inspectContainerState(loaded, runner) !== 'missing') {
      downContainer(loaded, runner);
    }
    recoverScopedCredentialActivation(loaded);
  } catch (error) {
    // A pre-activation failure would otherwise abandon staged secrets in the
    // fixed slot; discard is best-effort and the original error wins.
    try {
      discardStagedCredentialMaterial(loaded);
    } catch {
      // Cleanup is best-effort by contract.
    }
    throw error;
  }

  const active = activateScopedCredentialMaterial(loaded, staged);

  const upResult = runner.run(
    evalsContainerPath(loaded),
    scopedUpContainerArgs(loaded, active),
  );
  requireContainerCommand(
    upResult,
    'container_unhealthy',
    'scoped container up failed',
  );
  const capturedId = upResult.stdout.trim();
  if (capturedId === '' || /\s/.test(capturedId)) {
    throw new ApplianceError(
      'container_unhealthy',
      'container',
      'scoped up did not return a single non-blank container id on stdout',
    );
  }

  try {
    const imageId = inspectCapturedContainer(runner, capturedId);
    return {
      name: loaded.config.container.name,
      id: capturedId,
      imageId,
      mountSignature: scopedMountSignature(loaded, active),
      credentialScope: active.credentialScope,
    };
  } catch (error) {
    const cleanup = runner.run('docker', ['rm', '-f', capturedId]);
    if (cleanup.status !== 0 && error instanceof ApplianceError) {
      throw new ApplianceError(
        error.code,
        error.step,
        `${error.message}; rollback of captured container ${capturedId} also failed`,
      );
    }
    throw error;
  }
}

/**
 * Run one command in the leased container through the scoped wrapper exec
 * path: the wrapper verifies the configured name still resolves to the
 * lease's immutable ID and targets that ID.
 */
export function runInLeasedContainer(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
  lease: ContainerLease,
  command: readonly string[],
  code: ApplianceErrorCode,
  action: string,
): CommandResult {
  const result = runner.run(
    evalsContainerPath(loaded),
    scopedExecContainerArgs(loaded, lease, command),
  );
  requireContainerCommand(result, code, action);
  return result;
}

/**
 * Whether the host docker supports `docker exec --env-file`, probed from
 * `docker exec --help`. Doctor reports this; preflight will require it
 * before credential evaluation, build, or container mutation at cutover.
 */
export function dockerExecEnvFileSupport(runner: CommandRunner): boolean {
  const result = runner.run('docker', ['exec', '--help']);
  return result.status === 0 && result.stdout.includes('--env-file');
}

export function requireDockerExecEnvFile(runner: CommandRunner): void {
  if (!dockerExecEnvFileSupport(runner)) {
    throw new ApplianceError(
      'container_unhealthy',
      'container',
      'docker exec does not support --env-file (probed via docker exec --help); scoped credential delivery requires it',
    );
  }
}
