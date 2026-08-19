import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { getEnv } from '../env.ts';
import { assertCredentialBundleBoundary } from './credential-scope.ts';
import { ApplianceError } from './errors.ts';
import { readJsonFile } from './fs.ts';
import { ensurePrivateDirNoFollow } from './safe-fs.ts';
import {
  ApplianceConfigSchema,
  CredentialBundleMetadataSchema,
  type LoadedApplianceConfig,
  type LoadedApplianceStateConfig,
} from './types.ts';

const DEFAULT_CONFIG_PATH = '/srv/quorum/config/appliance.json';

export interface LoadConfigOptions {
  readonly ensureState?: boolean;
}

function requirePath(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }
}

function configError(error: unknown): ApplianceError {
  if (error instanceof ApplianceError) {
    return new ApplianceError('config_invalid', 'config', error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApplianceError('config_invalid', 'config', message);
}

/**
 * Load the STRUCTURAL appliance config: parse and validate the config file,
 * require the appliance root, and derive the state namespace paths. Never
 * stats or reads the credential bundle, so status/show/costs, jobs, locks,
 * import, prune, and identity-verified cancellation cannot be stranded by a
 * missing, unreadable, or unsafe bundle.
 */
export function loadStateConfig(
  configPath?: string,
  options: LoadConfigOptions = {},
): LoadedApplianceStateConfig {
  const resolvedConfigPath =
    configPath ?? getEnv('EVALS_APPLIANCE_CONFIG') ?? DEFAULT_CONFIG_PATH;

  try {
    const config = readJsonFile(
      resolvedConfigPath,
      ApplianceConfigSchema,
      `appliance config ${resolvedConfigPath}`,
    );

    requirePath(config.root, 'configured root');

    const stateRoot = join(config.root, 'state');
    const paths = {
      jobs: join(stateRoot, 'jobs'),
      locks: join(stateRoot, 'locks'),
      provenance: join(stateRoot, 'provenance'),
    };
    if (options.ensureState === true) {
      // The state namespace is a no-follow boundary: ensuring it must never
      // create or chmod through a symlinked component.
      ensurePrivateDirNoFollow(config.root, stateRoot, 'state');
      ensurePrivateDirNoFollow(config.root, paths.jobs, 'state/jobs');
      ensurePrivateDirNoFollow(config.root, paths.locks, 'state/locks');
      ensurePrivateDirNoFollow(
        config.root,
        paths.provenance,
        'state/provenance',
      );
    }

    return {
      config,
      configPath: resolvedConfigPath,
      paths,
    };
  } catch (error) {
    throw configError(error);
  }
}

/**
 * Load the CREDENTIAL-AWARE appliance config: the structural value plus
 * validated bundle metadata. The code repos must exist, the bundle boundary
 * must hold (real no-follow directory, no code/results overlap), and
 * metadata.json must be a no-follow regular file before it is read.
 * metadata.json is the ONLY bundle access — neither credentials.env nor any
 * OAuth payload is touched by config loading.
 */
export function loadCredentialConfig(
  configPath?: string,
  options: LoadConfigOptions = {},
): LoadedApplianceConfig {
  const state = loadStateConfig(configPath, options);
  try {
    requirePath(state.config.evals.path, 'evals repo');
    requirePath(state.config.superpowers.path, 'superpowers repo');
    requirePath(state.config.gauntlet.path, 'gauntlet repo');

    assertCredentialBundleBoundary(state.config);
    const metadataPath = join(
      state.config.credential_bundle.path,
      'metadata.json',
    );
    const metadataStats = lstatSync(metadataPath, { throwIfNoEntry: false });
    if (metadataStats === undefined) {
      throw new Error(
        `credential bundle metadata does not exist: ${metadataPath}`,
      );
    }
    if (metadataStats.isSymbolicLink() || !metadataStats.isFile()) {
      throw new Error(
        `credential bundle metadata must be a no-follow regular file: ${metadataPath}`,
      );
    }
    const bundle = readJsonFile(
      metadataPath,
      CredentialBundleMetadataSchema,
      'credential bundle metadata',
    );
    return { ...state, bundle };
  } catch (error) {
    throw configError(error);
  }
}
