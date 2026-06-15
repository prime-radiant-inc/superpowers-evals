import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { envSnapshot, getEnv } from '../env.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';
import { writePrivateFileNoFollow } from './private-file.ts';

// Pi azure-openai-responses provider passes through these env vars into pi.env
// (mirrors PI_AZURE_ENV_NAMES in quorum/runner.py). Order is preserved for the
// membership scan; the pi.env writer re-sorts before emitting.
const PI_AZURE_ENV_NAMES = [
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
] as const;

// Characters Python's shlex.quote treats as safe (its _find_unsafe regex is
// [^\w@%+=:,./-]). A value built only from these is emitted bare; anything else
// (including the empty string) is single-quoted with embedded quotes escaped as
// '\''. Reproduced here so pi.env matches the Python oracle byte-for-byte; the
// repo's shellSingleQuote always-quotes, which would diverge for bare values
// like gpt-4o.
const SHLEX_SAFE = /^[A-Za-z0-9@%+=:,./_-]+$/;

function shlexQuote(value: string): string {
  if (value.length > 0 && SHLEX_SAFE.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Require an env value via the sanctioned env module. Mirrors _require_env: an
// unset OR empty value is a setup failure.
function requirePiEnv(name: string, purpose: string): string {
  const value = getEnv(name);
  if (value === undefined || value === '') {
    throw new ProvisionError(`${name} not set; cannot ${purpose}`);
  }
  return value;
}

// Provider-specific pass-through env. Mirrors _pi_provider_extra_env: only the
// azure-openai-responses provider contributes extras, and it requires at least
// one of base-url / resource-name. Other providers contribute nothing.
function piProviderExtraEnv(provider: string): Record<string, string> {
  if (provider !== 'azure-openai-responses') {
    return {};
  }
  const baseUrl = getEnv('AZURE_OPENAI_BASE_URL');
  const resourceName = getEnv('AZURE_OPENAI_RESOURCE_NAME');
  if (
    (baseUrl === undefined || baseUrl === '') &&
    (resourceName === undefined || resourceName === '')
  ) {
    throw new ProvisionError(
      'PI_PROVIDER=azure-openai-responses requires AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME',
    );
  }
  const extra: Record<string, string> = {};
  for (const name of PI_AZURE_ENV_NAMES) {
    const value = getEnv(name);
    if (value !== undefined && value !== '') {
      extra[name] = value;
    }
  }
  return extra;
}

// Write pi.env (mode 0600). Shlex-quoted export lines for PI_PROVIDER / PI_MODEL
// (the launcher passes both to `pi --provider/--model` under `set -u`), an
// optional PI_API_KEY (api-key auth; OAuth omits it — the credential lives in
// auth.json), then extra env sorted by name, then a trailing empty line (the
// joined-with-newline list ends with "", so the file ends in a single newline).
function writePiEnvFile(
  configDir: string,
  provider: string,
  model: string,
  apiKey: string | undefined,
  extraEnv: Record<string, string>,
): void {
  const lines = [
    `export PI_PROVIDER=${shlexQuote(provider)}`,
    `export PI_MODEL=${shlexQuote(model)}`,
  ];
  if (apiKey !== undefined) {
    lines.push(`export PI_API_KEY=${shlexQuote(apiKey)}`);
  }
  const extraNames = Object.keys(extraEnv).sort();
  for (const name of extraNames) {
    const value = extraEnv[name];
    if (value !== undefined) {
      lines.push(`export ${name}=${shlexQuote(value)}`);
    }
  }
  lines.push('');
  writeFileSync(join(configDir, 'pi.env'), lines.join('\n'), { mode: 0o600 });
}

// Expand a leading ~ to HOME (mirrors Path.expanduser for the common case the
// oracle hits at runner.py:1342). Reads HOME only through env.ts.
function expanduser(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    const home = getEnv('HOME');
    if (home !== undefined && home !== '') {
      return p === '~' ? home : join(home, p.slice(2));
    }
  }
  return p;
}

// Pi support files a usable SUPERPOWERS_ROOT must contain (mirrors the `required`
// list in _require_pi_superpowers_source). The .pi extension and the
// using-superpowers skill + its pi-tools reference are what make a Pi run
// actually load Superpowers; a checkout missing any of them would provision
// silently and produce a meaningless eval.
const PI_SUPPORT_FILES = [
  'package.json',
  join('.pi', 'extensions', 'superpowers.ts'),
  join('skills', 'using-superpowers', 'SKILL.md'),
  join('skills', 'using-superpowers', 'references', 'pi-tools.md'),
] as const;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Verify SUPERPOWERS_ROOT actually carries the Pi support files before
// provisioning (mirrors _require_pi_superpowers_source, runner.py:1277-1289).
// Raises naming every absent path so a broken checkout fails loudly at setup
// rather than running without Superpowers.
function requirePiSuperpowersSource(superpowersRoot: string): void {
  const missing = PI_SUPPORT_FILES.map((rel) =>
    join(superpowersRoot, rel),
  ).filter((path) => !isFile(path));
  if (missing.length > 0) {
    throw new ProvisionError(
      `SUPERPOWERS_ROOT is missing Pi support files: ${missing.join(', ')}`,
    );
  }
}

// Require the `pi` binary on PATH (mirrors `shutil.which("pi") is None`,
// runner.py:1345-1346). Use Bun.which against the sanctioned PATH snapshot — a
// `command -v` probe would have to run through a shell, and a shell-less
// spawnSync ENOENTs on Linux and falsely reports the binary missing. A missing
// binary is a setup failure with a precise message instead of an opaque
// downstream launch error.
function requirePiOnPath(): void {
  if (Bun.which('pi', { PATH: envSnapshot()['PATH'] ?? '' }) === null) {
    throw new ProvisionError('pi not found on PATH; cannot run Pi evals');
  }
}

// The host `pi` config dir holding the OAuth login (default <PI_OAUTH_HOME>/agent,
// where PI_OAUTH_HOME defaults to ~/.pi). The same dir `pi` itself uses as its
// PI_CODING_AGENT_DIR, carrying auth.json (the OAuth token, keyed by provider)
// and settings.json (defaultProvider/defaultModel). PI_OAUTH_HOME mirrors codex's
// CODEX_AUTH_HOME / gemini's GEMINI_OAUTH_HOME override seam so the hermetic gate
// can point it at a temp dir.
function piOauthAgentDir(): string {
  const oauthHome = getEnv('PI_OAUTH_HOME') ?? join(homedir(), '.pi');
  return join(oauthHome, 'agent');
}

// The host pi settings.json fields the OAuth path reads to default the
// provider/model when PI_PROVIDER/PI_MODEL are not set as overrides. Permissive:
// any other field passes through; missing defaults surface as a clear error.
const PiSettingsSchema = z
  .object({
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultThinkingLevel: z.string().optional(),
  })
  .passthrough();

// Seed the host OAuth login into the isolated PI_CODING_AGENT_DIR so the run
// authenticates via OAuth instead of an env-var key. Mirrors codex's
// _seed_codex_auth: copy the host auth.json verbatim (mode 0600, O_NOFOLLOW so a
// pre-placed symlink can't redirect the credential), then write settings.json +
// pi.env carrying the resolved provider/model (env override else host settings)
// and NO PI_API_KEY. Throws a clear setup error when no host login exists or the
// provider/model can't be determined.
function seedPiOauth(configDir: string): void {
  const agentDir = piOauthAgentDir();
  const source = join(agentDir, 'auth.json');
  if (!existsSync(source)) {
    throw new ProvisionError(
      `no PI_API_KEY and no pi oauth login found at ${source}; run \`pi\` to log in or set PI_PROVIDER/PI_MODEL/PI_API_KEY`,
    );
  }

  // Resolve provider/model: an explicit env override wins; otherwise read the
  // host settings.json defaults. Without either, we cannot launch (the pi
  // launcher needs --provider/--model), so fail loudly rather than guess.
  let provider = getEnv('PI_PROVIDER');
  let model = getEnv('PI_MODEL');
  if (
    provider === undefined ||
    provider === '' ||
    model === undefined ||
    model === ''
  ) {
    const settings = readPiOauthSettings(join(agentDir, 'settings.json'));
    provider =
      provider !== undefined && provider !== '' ? provider : settings.provider;
    model = model !== undefined && model !== '' ? model : settings.model;
  }
  if (provider === undefined || provider === '') {
    throw new ProvisionError(
      'pi oauth login: cannot determine provider; set PI_PROVIDER or add defaultProvider to the host pi settings.json',
    );
  }
  if (model === undefined || model === '') {
    throw new ProvisionError(
      'pi oauth login: cannot determine model; set PI_MODEL or add defaultModel to the host pi settings.json',
    );
  }

  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(configDir, 'sessions'), { recursive: true });

  // Copy the OAuth credential verbatim through the O_NOFOLLOW-protected writer.
  writePrivateFileNoFollow(join(configDir, 'auth.json'), readFileSync(source));

  // settings.json mirrors the api-key path's shape (provider/model + fixed
  // thinking level), so pi's defaults match the launcher's flags.
  const settingsBody = {
    defaultProvider: provider,
    defaultModel: model,
    defaultThinkingLevel: 'medium',
  };
  writeFileSync(
    join(configDir, 'settings.json'),
    `${JSON.stringify(settingsBody, null, 2)}\n`,
  );

  // pi.env carries provider/model for the launcher; no PI_API_KEY in OAuth mode.
  writePiEnvFile(configDir, provider, model, undefined, {});
}

// Read provider/model defaults from the host pi settings.json. A missing file is
// tolerated (the caller may still have env overrides); an unreadable/invalid file
// is a clear setup error rather than a silent fall-through.
function readPiOauthSettings(settingsPath: string): {
  provider: string | undefined;
  model: string | undefined;
} {
  if (!existsSync(settingsPath)) {
    return { provider: undefined, model: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    throw new ProvisionError(
      `pi oauth login: host settings.json is not valid JSON: ${settingsPath}`,
    );
  }
  const settings = PiSettingsSchema.parse(parsed);
  return { provider: settings.defaultProvider, model: settings.defaultModel };
}

// Pi-family provisioning. Setup only — it shells out to nothing (the PATH probe
// is a Bun.which lookup, not a subprocess), so no CommandRunner is needed. It
// creates the isolated config dir and a sessions/ subdir, then writes auth.json,
// settings.json, and pi.env. Auth is OAuth-or-env: when PI_API_KEY is set it
// uses the api-key path (auth.json's key field is the literal "$PI_API_KEY"
// placeholder, expanded later by the launcher from pi.env); otherwise it seeds
// the host OAuth login into the isolated config dir. The returned env map carries
// only the agent_config_env -> configDir mapping; every secret lives in the
// written files, never in the returned env.
//
// PI_CODING_AGENT_DIR collapse: home.configDir is now rooted under the throwaway
// $HOME at <runHome>/.pi/agent (pi.yaml: home_config_subdir ".pi/agent"), which
// is exactly where pi defaults its config + session dir when neither
// PI_CODING_AGENT_DIR nor --session-dir is set. provision seeds the same files
// under configDir as before; the launcher omits the config-dir var and
// --session-dir, so pi discovers it all via the isolated $HOME. The returned
// agent_config_env -> configDir mapping still resolves session_log_dir's
// ${PI_CODING_AGENT_DIR} for capture and bakes the path into the HOWTO/launcher.
export class PiAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }

  provision(home: RunHome): Record<string, string> {
    const { configDir } = home;

    // SUPERPOWERS_ROOT is required in both auth paths; verify it first.
    const superpowersRaw = requirePiEnv(
      'SUPERPOWERS_ROOT',
      'load Pi Superpowers extension',
    );

    // Verify SUPERPOWERS_ROOT carries the Pi support files, then that the pi
    // binary is on PATH — both before any filesystem mutation.
    requirePiSuperpowersSource(expanduser(superpowersRaw));
    requirePiOnPath();

    // Auth is OAuth-or-env. When PI_API_KEY is set, use the api-key path
    // (PI_PROVIDER/PI_MODEL required, auth.json keyed to the "$PI_API_KEY"
    // placeholder). Otherwise seed the host OAuth login into the isolated config
    // dir so the run authenticates via OAuth.
    const apiKey = getEnv('PI_API_KEY');
    if (apiKey === undefined || apiKey === '') {
      seedPiOauth(configDir);
      return { [this.config.agent_config_env]: configDir };
    }

    const provider = requirePiEnv('PI_PROVIDER', 'configure Pi provider');
    const model = requirePiEnv('PI_MODEL', 'configure Pi model');
    const extraEnv = piProviderExtraEnv(provider);

    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(configDir, 'sessions'), { recursive: true });

    // auth.json (mode 0600). The key field is the literal "$PI_API_KEY"
    // placeholder — the real key is supplied via pi.env.
    const authPath = join(configDir, 'auth.json');
    const authBody: Record<string, { type: string; key: string }> = {
      [provider]: { type: 'api_key', key: '$PI_API_KEY' },
    };
    writeFileSync(authPath, `${JSON.stringify(authBody, null, 2)}\n`, {
      mode: 0o600,
    });

    // settings.json (no special mode).
    const settingsPath = join(configDir, 'settings.json');
    const settingsBody = {
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: 'medium',
    };
    writeFileSync(settingsPath, `${JSON.stringify(settingsBody, null, 2)}\n`);

    writePiEnvFile(configDir, provider, model, apiKey, extraEnv);

    return { [this.config.agent_config_env]: configDir };
  }
}
