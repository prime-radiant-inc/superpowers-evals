import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '../agents/command-runner.ts';
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
