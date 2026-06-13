import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';

// Copilot provisioning adapter (PRI-2207 Spec 2 Wave B2a). Ports the Python
// oracle quorum/runner.py: _resolve_copilot_auth_env, _write_copilot_env_file,
// _stage_copilot_superpowers_plugin, _seed_copilot_config. provision() is
// SETUP ONLY: it stages the isolated COPILOT_HOME, writes a mode-0600 secret
// env file, and stages the superpowers plugin from SUPERPOWERS_ROOT. It runs no
// subprocess (the `runner` seam is unused for copilot).
//
// NOTE: the post-run secret-leak scan (_scan_copilot_secret_leaks in the
// oracle) is deferred to Wave B3 (runner/capture integration); it is a POST-RUN
// check, not part of provisioning.

const COPILOT_ENV_FILE_NAME = '.copilot-env';

// Plugin files required to exist under SUPERPOWERS_ROOT before staging and
// under the staged plugin after staging (oracle COPILOT_REQUIRED_SUPERPOWERS_FILES).
const COPILOT_REQUIRED_SUPERPOWERS_FILES: readonly string[] = [
  '.claude-plugin/plugin.json',
  'hooks/hooks.json',
  'hooks/run-hook.cmd',
  'hooks/session-start',
  'skills/using-superpowers/SKILL.md',
  'skills/brainstorming/SKILL.md',
  'skills/using-superpowers/references/copilot-tools.md',
];

// Provider env vars copied verbatim when COPILOT_PROVIDER_BASE_URL is set
// (oracle COPILOT_PROVIDER_ENV_NAMES).
const COPILOT_PROVIDER_ENV_NAMES: readonly string[] = [
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN',
  'COPILOT_PROVIDER_WIRE_API',
  'COPILOT_PROVIDER_AZURE_API_VERSION',
  'COPILOT_PROVIDER_MODEL_ID',
  'COPILOT_PROVIDER_WIRE_MODEL',
  'COPILOT_PROVIDER_MAX_PROMPT_TOKENS',
  'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
  'COPILOT_OFFLINE',
  'COPILOT_MODEL',
];

// Provider secret env names, in the oracle's order, used to pick which provider
// values are secrets for the env file (the B3 leak scan uses the same set).
const COPILOT_PROVIDER_SECRET_NAMES: readonly string[] = [
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN',
];

// Subdirs the oracle creates under COPILOT_HOME during _seed_copilot_config.
const COPILOT_HOME_SUBDIRS: readonly string[] = [
  '.quorum',
  '.cache',
  'logs',
  'plugins',
  'session-state',
];

// Single-quote a value for a POSIX shell, escaping embedded single quotes.
// Mirrors the oracle _shell_single_quote and the ClaudeAgent shellSingleQuote.
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Port of _copilot_offline_requested: truthy COPILOT_OFFLINE values.
function copilotOfflineRequested(): boolean {
  const value = (getEnv('COPILOT_OFFLINE') ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

// Recursively reject any symlink under `root` (oracle _reject_symlinks). A
// missing root is fine (the caller's required-files check reports absence).
function rejectSymlinks(root: string, label: string): void {
  if (isSymlink(root)) {
    throw new ProvisionError(`${label} contains unsupported symlink: ${root}`);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return;
  }
  for (const entry of readdirSync(root)) {
    rejectSymlinks(join(root, entry), label);
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Port of _reject_copilot_staging_source_symlinks: source trees and hook files
// must not contain symlinks before they are copied into the isolated home.
function rejectCopilotStagingSourceSymlinks(spRoot: string): void {
  rejectSymlinks(join(spRoot, 'skills'), 'SUPERPOWERS_ROOT skills');
  rejectSymlinks(
    join(spRoot, '.claude-plugin'),
    'SUPERPOWERS_ROOT .claude-plugin',
  );
  for (const rel of [
    'hooks/hooks.json',
    'hooks/run-hook.cmd',
    'hooks/session-start',
  ]) {
    const path = join(spRoot, rel);
    if (isSymlink(path)) {
      throw new ProvisionError(
        `SUPERPOWERS_ROOT Copilot hook contains unsupported symlink: ${path}`,
      );
    }
  }
}

// Port of _require_copilot_superpowers_root: SUPERPOWERS_ROOT must be set, free
// of staging-source symlinks, and contain every required plugin file.
function requireCopilotSuperpowersRoot(superpowersRootValue: string): string {
  if (!superpowersRootValue) {
    throw new ProvisionError(
      'SUPERPOWERS_ROOT not set; cannot install Copilot Superpowers plugin',
    );
  }
  const root = resolve(superpowersRootValue);
  rejectCopilotStagingSourceSymlinks(root);
  const missing = COPILOT_REQUIRED_SUPERPOWERS_FILES.filter(
    (rel) => !isFile(join(root, rel)),
  );
  if (missing.length > 0) {
    throw new ProvisionError(
      `SUPERPOWERS_ROOT is missing required Copilot Superpowers files: ${missing.join(', ')}`,
    );
  }
  return root;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Port of _require_copilot_path_under_home: staged paths must resolve under the
// isolated COPILOT_HOME (no escape via symlink or traversal).
function requireCopilotPathUnderHome(path: string, copilotHome: string): void {
  const homeReal = resolve(copilotHome);
  const pathReal = resolve(path);
  const rel = relative(homeReal, pathReal);
  const escapes = rel.startsWith('..') || rel.startsWith('/');
  if (escapes) {
    throw new ProvisionError(
      `staged Copilot Superpowers path escapes isolated home: ${path}`,
    );
  }
}

// Resolved auth env plus which entries are secret (for the env file and the
// B3 leak scan). Mirrors the (values, secret_names, secret_values) tuple.
interface CopilotAuthEnv {
  readonly values: Record<string, string>;
  readonly secretNames: readonly string[];
  readonly secretValues: readonly string[];
}

// Port of _resolve_copilot_auth_env. Offline requires a provider base url; a
// provider base url copies the provider env block; otherwise fall back to a
// GitHub token from the env chain.
//
// The oracle's final fallback shells out to `gh auth token`; this adapter runs
// no subprocess (per the B2a contract), so that branch is intentionally
// omitted. The integrator can add a gh-token resolver in B3 if needed.
function resolveCopilotAuthEnv(): CopilotAuthEnv {
  const providerBaseUrl = getEnv('COPILOT_PROVIDER_BASE_URL');
  if (copilotOfflineRequested() && !providerBaseUrl) {
    throw new ProvisionError(
      'COPILOT_OFFLINE=true requires COPILOT_PROVIDER_BASE_URL',
    );
  }

  if (providerBaseUrl) {
    const providerValues: Record<string, string> = {};
    for (const name of COPILOT_PROVIDER_ENV_NAMES) {
      const value = getEnv(name);
      if (value) {
        providerValues[name] = value;
      }
    }
    const secretNames = COPILOT_PROVIDER_SECRET_NAMES.filter(
      (name) => providerValues[name],
    );
    const secretValues = secretNames.map((name) => providerValues[name] ?? '');
    return { values: providerValues, secretNames, secretValues };
  }

  let tokenValue = '';
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = getEnv(name) ?? '';
    if (value) {
      tokenValue = value;
      break;
    }
  }
  if (!tokenValue) {
    throw new ProvisionError(
      'no Copilot auth found; set COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, ' +
        'or COPILOT_PROVIDER_BASE_URL',
    );
  }
  return {
    values: { COPILOT_GITHUB_TOKEN: tokenValue },
    secretNames: ['COPILOT_GITHUB_TOKEN'],
    secretValues: [tokenValue],
  };
}

// Port of _write_copilot_env_file: write COPILOT_HOME/.copilot-env at mode 0600
// with sorted KEY='value' lines (shell-quoted). Returns the file path.
function writeCopilotEnvFile(
  copilotHome: string,
  values: Readonly<Record<string, string>>,
): string {
  const envFile = join(copilotHome, COPILOT_ENV_FILE_NAME);
  mkdirSync(copilotHome, { recursive: true });
  const lines = Object.keys(values)
    .sort()
    .map((key) => `${key}=${shellSingleQuote(values[key] ?? '')}\n`)
    .join('');
  writeFileSync(envFile, lines, { mode: 0o600 });
  return envFile;
}

// Port of _stage_copilot_superpowers_plugin: copy the plugin tree from
// SUPERPOWERS_ROOT into COPILOT_HOME/plugins/superpowers, verify required files
// exist, and verify every staged path stays under the isolated home.
function stageCopilotSuperpowersPlugin(
  spRoot: string,
  copilotHome: string,
): string {
  rejectCopilotStagingSourceSymlinks(spRoot);
  const pluginRoot = join(copilotHome, 'plugins', 'superpowers');
  if (existsSync(pluginRoot) || isSymlink(pluginRoot)) {
    rmSync(pluginRoot, { recursive: true, force: true });
  }

  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
  cpSync(join(spRoot, '.claude-plugin'), join(pluginRoot, '.claude-plugin'), {
    recursive: true,
  });
  copyFileSync(
    join(spRoot, 'hooks', 'hooks.json'),
    join(pluginRoot, 'hooks', 'hooks.json'),
  );
  copyFileSync(
    join(spRoot, 'hooks', 'run-hook.cmd'),
    join(pluginRoot, 'hooks', 'run-hook.cmd'),
  );
  copyFileSync(
    join(spRoot, 'hooks', 'session-start'),
    join(pluginRoot, 'hooks', 'session-start'),
  );
  cpSync(join(spRoot, 'skills'), join(pluginRoot, 'skills'), {
    recursive: true,
  });

  const missing = COPILOT_REQUIRED_SUPERPOWERS_FILES.filter(
    (rel) => !isFile(join(pluginRoot, rel)),
  );
  if (missing.length > 0) {
    throw new ProvisionError(
      `staged Copilot Superpowers plugin is missing required files: ${missing.join(', ')}`,
    );
  }

  requireCopilotPathUnderHome(pluginRoot, copilotHome);
  for (const path of walk(pluginRoot)) {
    requireCopilotPathUnderHome(path, copilotHome);
  }
  return pluginRoot;
}

// Recursively yield every path under `root` (oracle Path.rglob('*')).
function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    out.push(full);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    }
  }
  return out;
}

export class CopilotAgent implements CodingAgent {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    // erasableSyntaxOnly forbids a parameter property; assign in the body.
    this.config = config;
  }

  // SETUP ONLY. Stages COPILOT_HOME, writes the mode-0600 secret env file, and
  // stages the superpowers plugin. Runs no subprocess (runner unused). Throws
  // ProvisionError on any failure. Returns the env gauntlet passes to the CLI;
  // auth secrets go to the env FILE, not the returned map.
  provision(home: RunHome, _runner: CommandRunner): Record<string, string> {
    const copilotHome = home.configDir;
    const spRoot = requireCopilotSuperpowersRoot(
      getEnv('SUPERPOWERS_ROOT') ?? '',
    );

    // Resolve auth first so a missing/invalid credential fails before any dir
    // is created (matches the oracle's ordering in _seed_copilot_config).
    const auth = resolveCopilotAuthEnv();
    writeCopilotEnvFile(copilotHome, auth.values);

    for (const subdir of COPILOT_HOME_SUBDIRS) {
      mkdirSync(join(copilotHome, subdir), { recursive: true });
    }

    // The oracle also rejects a pre-existing
    // session-state/<session_id>/events.jsonl here, but provision() has no
    // session_id (the integrator supplies it in B3); that pre-snapshot guard is
    // deferred with the capture wiring.

    stageCopilotSuperpowersPlugin(spRoot, copilotHome);

    return { [this.config.agent_config_env]: copilotHome };
  }
}
