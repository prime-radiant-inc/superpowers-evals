import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '../agents/command-runner.ts';
import { ApplianceError, type ApplianceErrorCode } from './errors.ts';
import type { LoadedApplianceConfig } from './types.ts';

type AuthMountName = 'codex' | 'gemini' | 'kimi' | 'pi';
type ContainerState = 'missing' | 'stopped' | 'running';

export interface AuthMount {
  readonly name: AuthMountName;
  readonly path: string;
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

export function evalsContainerPath(loaded: LoadedApplianceConfig): string {
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
    ...baseContainerArgs(loaded),
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

export function statusContainerArgs(loaded: LoadedApplianceConfig): string[] {
  return [...baseContainerArgs(loaded), 'status'];
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
