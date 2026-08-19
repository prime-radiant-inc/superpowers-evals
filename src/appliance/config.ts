import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getEnv } from '../env.ts';
import { assertCredentialBundleBoundary } from './credential-scope.ts';
import { ApplianceError } from './errors.ts';
import { readJsonFile } from './fs.ts';
import {
  assertNoFollowDirChain,
  assertRealDirNoFollow,
  ensurePrivateDirNoFollow,
} from './safe-fs.ts';
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

    // The configured root and the state namespace are no-follow boundaries
    // for READS too: status/show/costs/cancel resolve records through these
    // paths, so even the read-only loader must refuse a symlinked component
    // that would let them consume redirected records.
    assertRealDirNoFollow(config.root, 'configured root');

    const stateRoot = join(config.root, 'state');
    const paths = {
      jobs: join(stateRoot, 'jobs'),
      locks: join(stateRoot, 'locks'),
      provenance: join(stateRoot, 'provenance'),
    };
    if (options.ensureState === true) {
      // Mutating ensure: validated no-follow creation, never create or
      // chmod through a symlinked component.
      ensurePrivateDirNoFollow(config.root, stateRoot, 'state');
      ensurePrivateDirNoFollow(config.root, paths.jobs, 'state/jobs');
      ensurePrivateDirNoFollow(config.root, paths.locks, 'state/locks');
      ensurePrivateDirNoFollow(
        config.root,
        paths.provenance,
        'state/provenance',
      );
    } else {
      // Read-only: every EXISTING namespace component must be a real
      // directory reached without following a symlink; missing tails are
      // fine (mutation paths create them).
      assertNoFollowDirChain(config.root, stateRoot, 'state');
      assertNoFollowDirChain(config.root, paths.jobs, 'state/jobs');
      assertNoFollowDirChain(config.root, paths.locks, 'state/locks');
      assertNoFollowDirChain(config.root, paths.provenance, 'state/provenance');
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
    // fd-based no-follow read: the kernel (O_NOFOLLOW), not a racy
    // lstat-then-open sequence, rejects a symlinked metadata.json; fstat on
    // the open descriptor refuses any non-regular node.
    let fd: number;
    try {
      fd = openSync(
        metadataPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    } catch (openError) {
      const code = (openError as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new Error(
          `credential bundle metadata does not exist: ${metadataPath}`,
        );
      }
      if (code === 'ELOOP' || code === 'EMLINK') {
        throw new Error(
          `credential bundle metadata must be a no-follow regular file: ${metadataPath}`,
        );
      }
      throw new Error(
        `credential bundle metadata is unreadable (${code ?? 'unknown error'}): ${metadataPath}`,
      );
    }
    let raw: string;
    try {
      if (!fstatSync(fd).isFile()) {
        throw new Error(
          `credential bundle metadata must be a no-follow regular file: ${metadataPath}`,
        );
      }
      raw = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (parseError) {
      throw new Error(
        `credential bundle metadata: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      );
    }
    const result = CredentialBundleMetadataSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`credential bundle metadata: ${result.error.message}`);
    }
    return { ...state, bundle: result.data };
  } catch (error) {
    throw configError(error);
  }
}
