import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CommandRunner,
  defaultCommandRunner,
} from '../agents/command-runner.ts';
import {
  dockerExecEnvFileSupport,
  evalsContainerPath,
  statusContainerArgs,
} from './container.ts';
import { ApplianceError } from './errors.ts';
import { inspectLock } from './locks.ts';
import type {
  LoadedApplianceConfig,
  LoadedApplianceStateConfig,
} from './types.ts';

export interface DoctorPayload {
  readonly ok: true;
  readonly config_path: string;
  readonly root: string;
  readonly evals_ref: string;
  readonly credential_bundle: {
    readonly name: 'blessed';
    readonly bundle_id: string;
    readonly providers: readonly string[];
    readonly rotated_at: string;
  };
  readonly locks: {
    readonly run: ReturnType<typeof inspectLock>;
    readonly sync: ReturnType<typeof inspectLock>;
  };
  readonly container: {
    readonly state: 'running' | 'stopped' | 'missing' | 'not_checked';
    readonly detail: string;
  };
  // Host docker capabilities the scoped credential path depends on. Doctor
  // only REPORTS them; preflight enforces them at cutover.
  readonly docker: {
    readonly exec_env_file: boolean;
  };
}

function containerState(stdout: string): DoctorPayload['container']['state'] {
  if (stdout.includes('exists, running')) {
    return 'running';
  }
  if (stdout.includes('exists, stopped')) {
    return 'stopped';
  }
  if (stdout.includes('missing')) {
    return 'missing';
  }
  return 'not_checked';
}

// Container status is a structural probe: only the wrapper's name-scoped
// status subcommand runs here, never a bundle-bearing invocation. doctorPayload
// itself stays credential-aware — it reports validated bundle METADATA (and
// only metadata; payload files are never opened).
function inspectContainer(
  loaded: LoadedApplianceStateConfig,
  runner: CommandRunner,
): DoctorPayload['container'] {
  const command = evalsContainerPath(loaded);
  if (!existsSync(command)) {
    return {
      state: 'not_checked',
      detail: `${command} not found`,
    };
  }

  const result = runner.run(command, statusContainerArgs(loaded));
  if (result.status !== 0) {
    throw new ApplianceError(
      'container_unhealthy',
      'doctor',
      `container status failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return {
    state: containerState(result.stdout),
    detail: result.stdout.trim(),
  };
}

export function doctorPayload(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner = defaultCommandRunner,
): DoctorPayload {
  return {
    ok: true,
    config_path: loaded.configPath,
    root: loaded.config.root,
    evals_ref: loaded.config.evals.ref,
    credential_bundle: {
      name: loaded.config.credential_bundle.name,
      bundle_id: loaded.bundle.bundle_id,
      providers: loaded.bundle.providers,
      rotated_at: loaded.bundle.rotated_at,
    },
    locks: {
      run: inspectLock(join(loaded.paths.locks, 'run.lock')),
      sync: inspectLock(join(loaded.paths.locks, 'sync.lock')),
    },
    container: inspectContainer(loaded, runner),
    docker: {
      exec_env_file: dockerExecEnvFileSupport(runner),
    },
  };
}
