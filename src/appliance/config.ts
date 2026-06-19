import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApplianceError } from './errors.ts';
import { mkdirPrivate, readJsonFile } from './fs.ts';
import {
  ApplianceConfigSchema,
  CredentialBundleMetadataSchema,
  type LoadedApplianceConfig,
} from './types.ts';

const DEFAULT_CONFIG_PATH = '/srv/quorum/config/appliance.json';

function requirePath(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }
}

export function loadConfig(configPath?: string): LoadedApplianceConfig {
  const resolvedConfigPath =
    configPath ??
    process.env['EVALS_APPLIANCE_CONFIG'] ??
    DEFAULT_CONFIG_PATH;

  try {
    const config = readJsonFile(
      resolvedConfigPath,
      ApplianceConfigSchema,
      `appliance config ${resolvedConfigPath}`,
    );

    requirePath(config.root, 'configured root');
    requirePath(config.evals.path, 'evals repo');
    requirePath(config.superpowers.path, 'superpowers repo');
    requirePath(config.gauntlet.path, 'gauntlet repo');
    requirePath(config.credential_bundle.path, 'credential bundle');

    const bundle = readJsonFile(
      join(config.credential_bundle.path, 'metadata.json'),
      CredentialBundleMetadataSchema,
      'credential bundle metadata',
    );

    const stateRoot = join(config.root, 'state');
    const paths = {
      jobs: join(stateRoot, 'jobs'),
      locks: join(stateRoot, 'locks'),
      provenance: join(stateRoot, 'provenance'),
    };
    mkdirPrivate(paths.jobs);
    mkdirPrivate(paths.locks);
    mkdirPrivate(paths.provenance);

    return {
      config,
      bundle,
      configPath: resolvedConfigPath,
      paths,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApplianceError('config_invalid', 'config', message);
  }
}
