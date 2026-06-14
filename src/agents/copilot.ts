import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';

// Copilot provisioning adapter (PRI-2207 Spec 2). Ports the Python oracle
// quorum/runner.py: _resolve_copilot_auth_env, _gh_auth_token,
// _write_copilot_env_file, _stage_copilot_superpowers_plugin,
// _seed_copilot_config. provision() is SETUP: it verifies the copilot binary is
// on PATH, stages the isolated COPILOT_HOME, writes a mode-0600 secret env file,
// and stages the superpowers plugin from SUPERPOWERS_ROOT. The only subprocesses
// are the PATH/auth probes (`command -v copilot`, the `gh auth token` fallback),
// routed through the injectable `runner` seam.
//
// provisionCopilot() takes a per-run session id (minted by the runner) so it can
// run the pre-snapshot session-state guard and return the CopilotProvisioning
// record (env file + secret values + the session-state events.jsonl path) that
// the runner threads into the $QUORUM_COPILOT_SESSION_ID substitution, the
// gauntlet env allowlist, and the post-run secret-leak scan.
//
// RUNNER-side (not provisioning): _copilot_gauntlet_env env allowlist +
// credentialed-proxy rejection (the spawnGauntlet env) and the post-run
// _scan_copilot_secret_leaks over run_dir. The building blocks for both are
// exported here (copilotGauntletEnv, scanCopilotSecretLeaks) so the runner just
// calls them.

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

// Proxy env vars whose values must not carry credentialed userinfo when copilot
// runs (oracle COPILOT_PROXY_ENV_NAMES). Exported for the runner's gauntlet env.
export const COPILOT_PROXY_ENV_NAMES: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

// The env vars the runner forwards into the gauntlet/copilot process. Auth
// secrets do NOT appear here — they go to the mode-0600 env file. Exported for
// the runner's spawnGauntlet (oracle COPILOT_GAUNTLET_ENV_ALLOWLIST).
export const COPILOT_GAUNTLET_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'TERM',
  'LANG',
  'GH_HOST',
  'COPILOT_GH_HOST',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_LOG',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'COPILOT_MODEL',
  'COPILOT_OFFLINE',
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

// Port of _gh_auth_token: shell `gh auth token` as the final auth fallback,
// tolerant of gh-not-on-PATH and a non-zero exit (both yield no token). Routed
// through the injectable runner so the hermetic gate stubs the lookup; `command
// -v gh` stands in for the oracle's shutil.which("gh") guard.
function ghAuthToken(runner: CommandRunner): string | undefined {
  const present = runner.run('command', ['-v', 'gh'], { env: envSnapshot() });
  if (present.status !== 0 || present.stdout.trim() === '') {
    return undefined;
  }
  const result = runner.run('gh', ['auth', 'token'], { env: envSnapshot() });
  if (result.status !== 0) {
    return undefined;
  }
  const token = result.stdout.trim();
  return token || undefined;
}

// Port of _resolve_copilot_auth_env. Offline requires a provider base url; a
// provider base url copies the provider env block; otherwise fall back to a
// GitHub token from the env chain, and finally to `gh auth token`.
function resolveCopilotAuthEnv(runner: CommandRunner): CopilotAuthEnv {
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
    tokenValue = ghAuthToken(runner) ?? '';
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
// writeFileSync's `mode` is ignored when the file already exists, so chmod after
// to enforce 0600 even when a pre-existing .copilot-env had looser perms (the
// oracle fchmods 0600 both before and after writing).
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
  chmodSync(envFile, 0o600);
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

// Port of _proxy_url_has_userinfo: true when the URL carries user[:pass]@ in its
// authority. A scheme-less value is treated as authority. Exported only via the
// gauntlet-env helper.
function proxyUrlHasUserinfo(value: string): boolean {
  const candidate = value.trim();
  if (!candidate) {
    return false;
  }
  const parseValue = candidate.includes('://') ? candidate : `//${candidate}`;
  try {
    const parsed = new URL(parseValue);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    const afterScheme = candidate.split('://', 2).at(-1) ?? candidate;
    const authority = afterScheme.split('/', 1)[0] ?? '';
    const userinfo = authority.split('@', 1)[0] ?? '';
    return userinfo !== '' && authority.includes('@');
  }
}

// RUNNER-side building block (oracle _copilot_gauntlet_env). Project `host_env`
// down to the allowlist; reject a proxy var that carries credentialed userinfo
// (so the proxy password is never forwarded into the agent process). Exported
// for the runner's spawnGauntlet env; provisioning does not call it.
export function copilotGauntletEnv(
  hostEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of COPILOT_GAUNTLET_ENV_ALLOWLIST) {
    const value = hostEnv[name];
    if (value === undefined) {
      continue;
    }
    if (COPILOT_PROXY_ENV_NAMES.includes(name) && proxyUrlHasUserinfo(value)) {
      throw new ProvisionError(
        `${name} contains credentialed proxy URL; remove proxy userinfo`,
      );
    }
    env[name] = value;
  }
  return env;
}

// RUNNER-side building block (oracle _scan_copilot_secret_leaks). Recursively
// scan `runDir` for any of the raw secret byte sequences, skipping symlinks,
// non-files, and the resolved `excludedPaths` (the env file legitimately holds
// the secret). Returns the leaking file paths. Empty/blank secrets short-circuit
// to no scan. Exported for the runner's post-run check; provisioning supplies the
// secretValues via CopilotProvisioning.
export function scanCopilotSecretLeaks(
  runDir: string,
  secretValues: readonly string[],
  excludedPaths: readonly string[],
): string[] {
  const secrets = secretValues
    .filter((value) => value !== '')
    .map((value) => Buffer.from(value));
  if (secrets.length === 0) {
    return [];
  }
  const excludedResolved = new Set(excludedPaths.map((path) => resolve(path)));
  const leaks: string[] = [];
  for (const path of walk(runDir)) {
    if (isSymlink(path) || !isFile(path)) {
      continue;
    }
    let content: Buffer;
    try {
      if (excludedResolved.has(resolve(path))) {
        continue;
      }
      content = readFileSync(path);
    } catch {
      continue;
    }
    if (secrets.some((secret) => content.includes(secret))) {
      leaks.push(path);
    }
  }
  return leaks;
}

// The rich provisioning record the runner needs (oracle CopilotProvisioning):
// the minted session id, the env file, the secret names/values for the leak
// scan, the env map gauntlet passes to the CLI, and the session-state
// events.jsonl path the capture diff validates.
export interface CopilotProvisioning {
  readonly sessionId: string;
  readonly envFile: string;
  readonly secretNames: readonly string[];
  readonly secretValues: readonly string[];
  readonly env: Record<string, string>;
  readonly expectedEventsLog: string;
}

// Port of the shutil.which("copilot") guard in _seed_copilot_config. node has no
// shutil.which; probe via the injectable runner (`command -v copilot`) so the
// hermetic gate can stub the lookup, and raise ProvisionError when it is missing.
function requireCopilotBinaryOnPath(
  binary: string,
  runner: CommandRunner,
): void {
  const probe = runner.run('command', ['-v', binary], { env: envSnapshot() });
  if (probe.status !== 0 || probe.stdout.trim() === '') {
    throw new ProvisionError(
      `${binary} not found on PATH; cannot run Copilot evals`,
    );
  }
}

export class CopilotAgent implements CodingAgent {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    // erasableSyntaxOnly forbids a parameter property; assign in the body.
    this.config = config;
  }

  // SETUP. Verifies copilot is on PATH, stages COPILOT_HOME, writes the
  // mode-0600 secret env file, runs the pre-snapshot session-state guard, and
  // stages the superpowers plugin. The only subprocesses are the binary/auth
  // probes (via `runner`). Throws ProvisionError on any failure. Returns the
  // full CopilotProvisioning record the runner needs to wire the session-id
  // substitution, gauntlet env, capture validation, and post-run leak scan.
  provisionCopilot(
    home: RunHome,
    runner: CommandRunner,
    sessionId: string,
  ): CopilotProvisioning {
    const copilotHome = home.configDir;
    const spRoot = requireCopilotSuperpowersRoot(
      getEnv('SUPERPOWERS_ROOT') ?? '',
    );
    requireCopilotBinaryOnPath(this.config.binary, runner);

    // Resolve auth first so a missing/invalid credential fails before any dir
    // is created (matches the oracle's ordering in _seed_copilot_config).
    const auth = resolveCopilotAuthEnv(runner);
    const envFile = writeCopilotEnvFile(copilotHome, auth.values);

    for (const subdir of COPILOT_HOME_SUBDIRS) {
      mkdirSync(join(copilotHome, subdir), { recursive: true });
    }

    // Reject a pre-existing session-state/<session_id>/events.jsonl: stale state
    // from a prior run would corrupt the capture snapshot diff.
    const expectedEventsLog = join(
      copilotHome,
      'session-state',
      sessionId,
      'events.jsonl',
    );
    if (existsSync(expectedEventsLog)) {
      throw new ProvisionError(
        `pre-existing Copilot session-state before capture snapshot: ${expectedEventsLog}`,
      );
    }

    stageCopilotSuperpowersPlugin(spRoot, copilotHome);

    return {
      sessionId,
      envFile,
      secretNames: auth.secretNames,
      secretValues: auth.secretValues,
      env: { [this.config.agent_config_env]: copilotHome },
      expectedEventsLog,
    };
  }

  // CodingAgent contract. The runner wiring that mints and threads a per-run
  // session id is Wave 2b; until then, provision() mints its own so the binary
  // check, auth resolution, and plugin staging still run. Wave 2b should call
  // provisionCopilot() directly to capture the CopilotProvisioning record.
  provision(
    home: RunHome,
    runner: CommandRunner,
    sessionId?: string,
  ): Record<string, string> {
    const id = sessionId ?? crypto.randomUUID();
    return this.provisionCopilot(home, runner, id).env;
  }
}
