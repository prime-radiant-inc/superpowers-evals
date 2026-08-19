import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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

const SCOPED_AGENT_ENV_FILE = 'agent.env';
const SCOPED_SUPERVISOR_ENV_FILE = 'supervisor.exec.env';
const SCOPED_AUTH_DIR = 'auth';
const CREDENTIAL_ENV_DESTINATION = '/run/evals/credentials.env';

// The container-side destination each projected auth mount name is mounted
// at (the wrapper deliberately maps kimi -> /auth/kimi-code).
const AUTH_MOUNT_DESTINATION: Readonly<
  Record<ProjectedAuthMount['name'], string>
> = {
  codex: '/auth/codex',
  gemini: '/auth/gemini',
  kimi: '/auth/kimi-code',
  pi: '/auth/pi',
};

const OAUTH_KIND_TO_MOUNT: Readonly<Record<string, string>> = {
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'gemini',
  kimi: 'kimi',
  pi: 'pi',
};

// The exact file set each OAuth projection kind stages under
// auth/<mount>/. Non-secret structure only: this is what binds a staged
// generation to its scope's own projector, so a same-mount cross-scope
// swap (gemini and antigravity share the 'gemini' mount name) cannot pass
// this boundary even though the mount names correspond.
const OAUTH_PROJECTED_FILES: Readonly<
  Record<string, { required: readonly string[]; optional: readonly string[] }>
> = {
  codex: { required: ['auth.json'], optional: [] },
  gemini: {
    required: ['google_accounts.json', 'oauth_creds.json'],
    optional: [],
  },
  antigravity: {
    required: ['antigravity-cli/antigravity-oauth-token'],
    optional: [],
  },
  kimi: {
    required: ['config.toml', 'credentials/kimi-code.json'],
    optional: ['oauth/kimi-code'],
  },
  pi: { required: ['agent/auth.json'], optional: [] },
};

// The complete non-secret shape of one asserted scope: schema version,
// discriminant, identity fields, agent env projections, gemini mode, and the
// oauth projector's own kind/mount/provider consistency. A scope that fails
// this check can never reach a runner call.
function requireScopeShape(label: string, scope: CredentialScope): void {
  if (scope.schemaVersion !== 1) {
    throw scopedContainerFault(
      `${label} has an unsupported schemaVersion: ${String(scope.schemaVersion)}`,
    );
  }
  // Runtime guard first: a cast scope may carry a kind outside the union.
  const kind = (scope as { kind: unknown }).kind;
  if (kind !== 'empty' && kind !== 'live') {
    throw scopedContainerFault(`${label} has an unknown kind: ${String(kind)}`);
  }
  if (scope.kind === 'empty') {
    if (
      scope.agent !== null ||
      scope.runtimeFamily !== null ||
      scope.credential !== null ||
      scope.geminiAuthType !== null ||
      scope.oauth !== null ||
      scope.agentEnv.length !== 0
    ) {
      throw scopedContainerFault(
        `${label} is an empty scope carrying live material fields`,
      );
    }
    return;
  }
  if (
    scope.agent === '' ||
    scope.runtimeFamily === '' ||
    scope.credential === ''
  ) {
    throw scopedContainerFault(
      `${label} is missing its agent, runtimeFamily, or credential identity`,
    );
  }
  for (const projection of scope.agentEnv) {
    if (projection.destinationName === '') {
      throw scopedContainerFault(
        `${label} has an agent env projection with no destination name`,
      );
    }
    if (projection.sourceNames.length === 0) {
      throw scopedContainerFault(
        `${label} agent env projection '${projection.destinationName}' has no source names`,
      );
    }
    for (const source of projection.sourceNames) {
      if (source === '') {
        throw scopedContainerFault(
          `${label} agent env projection '${projection.destinationName}' has a blank source name`,
        );
      }
    }
  }
  if (
    scope.geminiAuthType !== null &&
    scope.geminiAuthType !== 'gemini-api-key' &&
    scope.geminiAuthType !== 'oauth-personal'
  ) {
    throw scopedContainerFault(
      `${label} has an unknown geminiAuthType: ${String(scope.geminiAuthType)}`,
    );
  }
  if (scope.oauth !== null) {
    const mount = Object.hasOwn(OAUTH_KIND_TO_MOUNT, scope.oauth.kind)
      ? OAUTH_KIND_TO_MOUNT[scope.oauth.kind]
      : undefined;
    if (mount === undefined) {
      throw scopedContainerFault(
        `${label} has an unknown oauth projection kind: ${String(scope.oauth.kind)}`,
      );
    }
    if (scope.oauth.mountName !== mount) {
      throw scopedContainerFault(
        `${label} oauth kind '${scope.oauth.kind}' must use mount '${mount}', got '${String(scope.oauth.mountName)}'`,
      );
    }
    if (
      scope.oauth.kind === 'pi' &&
      (typeof scope.oauth.provider !== 'string' || scope.oauth.provider === '')
    ) {
      throw scopedContainerFault(
        `${label} pi oauth projection requires a nonempty provider`,
      );
    }
  }
}

// Every regular file under dir, as slash-separated relative paths, or null
// when dir is absent. Symlinks and non-regular entries are refusals: the
// projected tree must be exactly the real files the projector wrote.
function listProjectedTree(dir: string, label: string): string[] | null {
  const stats = lstatSync(dir, { throwIfNoEntry: false });
  if (stats === undefined) {
    return null;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw scopedContainerFault(`${label} must be a real directory: ${dir}`);
  }
  const files: string[] = [];
  const walk = (path: string, rel: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childPath = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        throw scopedContainerFault(`${label} contains a symlink: ${childPath}`);
      }
      if (entry.isDirectory()) {
        walk(childPath, childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      } else {
        throw scopedContainerFault(
          `${label} contains a non-regular entry: ${childPath}`,
        );
      }
    }
  };
  walk(dir, '');
  return files.sort();
}

// Bind the staged/active generation's non-secret file structure to the
// asserted scope's own oauth projector: the projected auth tree must exist
// exactly when the scope projects oauth material, must contain every
// required file for the scope's kind, and must contain nothing else (beyond
// the kind's optional files).
function requireProjectedAuthTree(
  label: string,
  rootDir: string,
  scope: CredentialScope,
): void {
  const authDir = join(rootDir, SCOPED_AUTH_DIR);
  const oauth = scope.kind === 'live' ? scope.oauth : null;
  if (oauth === null) {
    if (listProjectedTree(authDir, `${label} projected auth tree`) !== null) {
      throw scopedContainerFault(
        `${label} carries a projected auth tree but its scope projects no oauth material`,
      );
    }
    return;
  }
  const actual = listProjectedTree(authDir, `${label} projected auth tree`);
  if (actual === null) {
    throw scopedContainerFault(`${label} is missing its projected auth tree`);
  }
  const spec = Object.hasOwn(OAUTH_PROJECTED_FILES, oauth.kind)
    ? OAUTH_PROJECTED_FILES[oauth.kind]
    : undefined;
  if (spec === undefined) {
    throw scopedContainerFault(
      `${label} has an unknown oauth projection kind: ${String(oauth.kind)}`,
    );
  }
  const expectedRel = (file: string): string => `${oauth.mountName}/${file}`;
  const allowed = new Set(
    [...spec.required, ...spec.optional].map((file) => expectedRel(file)),
  );
  for (const rel of actual) {
    if (!allowed.has(rel)) {
      throw scopedContainerFault(
        `${label} projected auth tree contains a file its scope does not project: ${rel}`,
      );
    }
  }
  for (const required of spec.required) {
    if (!actual.includes(expectedRel(required))) {
      throw scopedContainerFault(
        `${label} projected auth tree is missing its scope-required file: ${expectedRel(required)}`,
      );
    }
  }
}

// The one consistency rule for both staged and active material: the scope's
// complete shape, the material discriminant matching the scope's, empty
// material carrying no supervisor file or mounts, live material carrying its
// supervisor file, every projected path being EXACTLY its fixed slot path
// (never a descendant), the auth mounts corresponding exactly to the scope's
// own oauth projection, and the projected auth tree binding to that
// projection's file set.
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
  const root = resolve(rootDir);
  const scope = material.credentialScope;
  requireScopeShape(`${label} credential scope`, scope);
  if (material.kind !== scope.kind) {
    throw scopedContainerFault(
      `${label} pairs ${material.kind} material with a ${scope.kind} credential scope; the material discriminant is the sole scope authority`,
    );
  }
  if (resolve(material.agentEnvFile) !== join(root, SCOPED_AGENT_ENV_FILE)) {
    throw scopedContainerFault(
      `${label} agent env file is not the fixed slot path: ${material.agentEnvFile}`,
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
    if (
      resolve(material.supervisorExecEnvFile) !==
      join(root, SCOPED_SUPERVISOR_ENV_FILE)
    ) {
      throw scopedContainerFault(
        `${label} supervisor exec env file is not the fixed slot path: ${material.supervisorExecEnvFile}`,
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
  for (const mount of material.authMounts) {
    if (
      resolve(mount.path) !== resolve(join(root, SCOPED_AUTH_DIR, mount.name))
    ) {
      throw scopedContainerFault(
        `${label} auth mount '${mount.name}' is not the fixed slot path: ${mount.path}`,
      );
    }
  }
  requireProjectedAuthTree(label, root, scope);
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

// The scoped mount signature describes the COMPLETE asserted non-secret
// scope — schema version, identity, agent env projections, gemini mode, and
// the oauth projector's kind/mount/provider — plus the fixed active
// destinations. Never secret values, so a secret rotation does not change
// it while any change to the asserted delivery contract does.
function scopedMountSignature(
  loaded: LoadedApplianceConfig,
  active: ActiveCredentialMaterial,
): string {
  const scope = active.credentialScope;
  const oauth =
    scope.kind === 'live' && scope.oauth !== null
      ? scope.oauth.kind === 'pi'
        ? {
            kind: scope.oauth.kind,
            mountName: scope.oauth.mountName,
            provider: scope.oauth.provider,
          }
        : { kind: scope.oauth.kind, mountName: scope.oauth.mountName }
      : null;
  const payload = {
    evals: loaded.config.evals.path,
    superpowers: loaded.config.superpowers.path,
    results_root: loaded.config.container.results_root,
    scope: {
      schema_version: scope.schemaVersion,
      kind: scope.kind,
      agent: scope.agent,
      runtime_family: scope.runtimeFamily,
      credential: scope.credential,
      agent_env:
        scope.kind === 'live'
          ? scope.agentEnv.map((projection) => ({
              destination: projection.destinationName,
              sources: [...projection.sourceNames],
            }))
          : [],
      gemini_auth_type: scope.geminiAuthType,
      oauth,
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

function canonicalHostPath(path: string, what: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new ApplianceError(
      'container_unhealthy',
      'container',
      `the asserted ${what} could not be canonicalized for mount validation: ${path}`,
    );
  }
}

interface CapturedMount {
  readonly Type: string;
  readonly Source: string;
  readonly Destination: string;
  readonly RW: boolean;
}

function capturedFault(capturedId: string, message: string): ApplianceError {
  return new ApplianceError(
    'container_unhealthy',
    'container',
    `captured container ${capturedId} ${message}`,
  );
}

function parseCapturedMounts(
  capturedId: string,
  record: unknown,
): CapturedMount[] {
  if (typeof record !== 'object' || record === null) {
    throw capturedFault(capturedId, 'inspection returned no mount array');
  }
  const raw = (record as Record<string, unknown>)['Mounts'];
  if (!Array.isArray(raw)) {
    throw capturedFault(capturedId, 'inspection returned no mount array');
  }
  return raw.map((entry): CapturedMount => {
    if (typeof entry !== 'object' || entry === null) {
      throw capturedFault(capturedId, 'has a malformed mount entry');
    }
    const mount = entry as Record<string, unknown>;
    if (
      typeof mount['Type'] !== 'string' ||
      typeof mount['Source'] !== 'string' ||
      typeof mount['Destination'] !== 'string' ||
      typeof mount['RW'] !== 'boolean'
    ) {
      throw capturedFault(capturedId, 'has a malformed mount entry');
    }
    return {
      Type: mount['Type'],
      Source: mount['Source'],
      Destination: mount['Destination'],
      RW: mount['RW'],
    };
  });
}

// Validate the captured container's ACTUAL mount topology against the
// asserted active material: exactly one read-only bind of the active agent
// env file at /run/evals/credentials.env, exactly one read-only bind of each
// asserted projected auth directory at its fixed destination, no unasserted
// /auth/* mount anywhere, and the supervisor exec env file never mounted on
// any mount's source. Any drift is a typed refusal; the caller rolls back
// exactly the captured id.
function requireCapturedMountTopology(
  capturedId: string,
  record: unknown,
  active: ActiveCredentialMaterial,
): void {
  const mounts = parseCapturedMounts(capturedId, record);
  const envMounts = mounts.filter(
    (mount) => mount.Destination === CREDENTIAL_ENV_DESTINATION,
  );
  if (envMounts.length !== 1) {
    throw capturedFault(
      capturedId,
      `must expose exactly one ${CREDENTIAL_ENV_DESTINATION} mount, found ${envMounts.length}`,
    );
  }
  const envMount = envMounts[0];
  if (envMount === undefined) {
    throw capturedFault(
      capturedId,
      `must expose exactly one ${CREDENTIAL_ENV_DESTINATION} mount`,
    );
  }
  if (envMount.Type !== 'bind') {
    throw capturedFault(
      capturedId,
      `${CREDENTIAL_ENV_DESTINATION} mount is not a bind mount`,
    );
  }
  if (envMount.RW) {
    throw capturedFault(
      capturedId,
      `${CREDENTIAL_ENV_DESTINATION} mount must be read-only`,
    );
  }
  if (
    envMount.Source !== canonicalHostPath(active.agentEnvFile, 'agent env file')
  ) {
    throw capturedFault(
      capturedId,
      `${CREDENTIAL_ENV_DESTINATION} mount source does not match the asserted agent env file`,
    );
  }

  const assertedDestinations = new Set<string>();
  for (const mount of active.authMounts) {
    const destination = Object.hasOwn(AUTH_MOUNT_DESTINATION, mount.name)
      ? AUTH_MOUNT_DESTINATION[mount.name]
      : undefined;
    if (destination === undefined) {
      throw capturedFault(
        capturedId,
        `has an unknown projected auth mount name '${String(mount.name)}'`,
      );
    }
    assertedDestinations.add(destination);
    const matches = mounts.filter((entry) => entry.Destination === destination);
    if (matches.length !== 1) {
      throw capturedFault(
        capturedId,
        `must expose exactly one ${destination} mount, found ${matches.length}`,
      );
    }
    const match = matches[0];
    if (match === undefined) {
      throw capturedFault(
        capturedId,
        `must expose exactly one ${destination} mount`,
      );
    }
    if (match.Type !== 'bind') {
      throw capturedFault(
        capturedId,
        `${destination} mount is not a bind mount`,
      );
    }
    if (match.RW) {
      throw capturedFault(capturedId, `${destination} mount must be read-only`);
    }
    if (
      match.Source !==
      canonicalHostPath(mount.path, `projected auth directory ${mount.name}`)
    ) {
      throw capturedFault(
        capturedId,
        `${destination} mount source does not match the asserted projected auth directory`,
      );
    }
  }

  for (const mount of mounts) {
    if (
      mount.Destination.startsWith('/auth/') &&
      !assertedDestinations.has(mount.Destination)
    ) {
      throw capturedFault(
        capturedId,
        `exposes an unasserted auth mount at ${mount.Destination}`,
      );
    }
  }

  if (active.supervisorExecEnvFile !== null) {
    const supervisorSource = canonicalHostPath(
      active.supervisorExecEnvFile,
      'supervisor exec env file',
    );
    for (const mount of mounts) {
      if (mount.Source === supervisorSource) {
        throw capturedFault(
          capturedId,
          'mounts the supervisor exec env file, which must never enter the container',
        );
      }
    }
  }
}

// Inspect the captured container BY ID and require the record to identify
// exactly that ID (a name lookup is never blessed as the lease identity)
// and to expose exactly the asserted credential mount topology. Returns the
// image id for the lease.
function inspectCapturedContainer(
  runner: CommandRunner,
  capturedId: string,
  active: ActiveCredentialMaterial,
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
  requireCapturedMountTopology(capturedId, record, active);
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
  if (!/^[0-9a-f]{64}$/.test(capturedId)) {
    // The lease id is used verbatim as the rollback target and the exec
    // identity, so a name-like or truncated token must never be blessed as
    // a container id: docker full ids are exactly 64 lowercase hex chars.
    throw new ApplianceError(
      'container_unhealthy',
      'container',
      `scoped up did not return a full 64-hex docker container id on stdout (expected 64 lowercase hex characters): ${capturedId}`,
    );
  }

  try {
    const imageId = inspectCapturedContainer(runner, capturedId, active);
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
