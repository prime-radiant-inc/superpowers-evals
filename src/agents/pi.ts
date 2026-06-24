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
import type { Credential } from '../contracts/credential.ts';
import type { ApiKeyResolution } from '../credentials/resolve.ts';
import { resolveApiKey } from '../credentials/resolve.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';
import { writePrivateFileNoFollow } from './private-file.ts';

// Map credential.api values to pi's internal api name. Only openai-chat is
// supported on the api-key custom-endpoint path. All other CREDENTIAL_APIS are
// unsupported by pi's custom-endpoint provisioner.
const CREDENTIAL_API_TO_PI_API: Readonly<Record<string, string>> = {
  'openai-chat': 'openai-completions',
};

// Characters shlex.quote treats as safe (its unsafe-char regex is
// [^\w@%+=:,./-]). A value built only from these is emitted bare; anything else
// (including the empty string) is single-quoted with embedded quotes escaped as
// '\''. pi.env needs these shlex.quote semantics: the repo's shellSingleQuote
// always-quotes, which would needlessly quote bare values like gpt-4o.
const SHLEX_SAFE = /^[A-Za-z0-9@%+=:,./_-]+$/;

function shlexQuote(value: string): string {
  if (value.length > 0 && SHLEX_SAFE.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Require an env value via the sanctioned env module. An unset OR empty value is
// a setup failure.
function requirePiEnv(name: string, purpose: string): string {
  const value = getEnv(name);
  if (value === undefined || value === '') {
    throw new ProvisionError(`${name} not set; cannot ${purpose}`);
  }
  return value;
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

// Expand a leading ~ to HOME. Reads HOME only through env.ts.
function expanduser(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    const home = getEnv('HOME');
    if (home !== undefined && home !== '') {
      return p === '~' ? home : join(home, p.slice(2));
    }
  }
  return p;
}

// Pi support files a usable SUPERPOWERS_ROOT must contain. The .pi extension and
// the using-superpowers skill + its pi-tools reference are what make a Pi run
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
// provisioning. Raises naming every absent path so a broken checkout fails
// loudly at setup rather than running without Superpowers.
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

// Require the `pi` binary on PATH. Use Bun.which against the sanctioned PATH
// snapshot — a `command -v` probe would have to run through a shell, and a
// shell-less spawnSync ENOENTs on Linux and falsely reports the binary missing. A
// missing binary is a setup failure with a precise message instead of an opaque
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
// provider/model when they are not set as overrides. Permissive:
// any other field passes through; missing defaults surface as a clear error.
const PiSettingsSchema = z
  .object({
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultThinkingLevel: z.string().optional(),
  })
  .passthrough();

// Seed the host OAuth login into the isolated PI_CODING_AGENT_DIR so the run
// authenticates via OAuth instead of an env-var key. Like codex's auth seeding,
// copy the host auth.json verbatim (mode 0600, O_NOFOLLOW so a pre-placed
// symlink can't redirect the credential), then write settings.json + pi.env
// carrying the resolved provider/model and NO PI_API_KEY. Throws a clear setup
// error when no host login exists or the provider can't be determined.
// The model is sourced from credential.model; the provider comes from
// credential.provider when set (an explicit, reproducible provider that overrides
// the host settings.json defaultProvider), else the host default.
function seedPiOauth(
  configDir: string,
  credentialModel: string,
  credentialProvider: string | undefined,
): void {
  const agentDir = piOauthAgentDir();
  const source = join(agentDir, 'auth.json');
  if (!existsSync(source)) {
    throw new ProvisionError(
      `no PI_API_KEY and no pi oauth login found at ${source}; run \`pi\` to log in`,
    );
  }

  // Provider precedence: credential.provider (explicit, reproducible) over the
  // host settings.json defaultProvider. Without either we cannot launch (the pi
  // launcher needs --provider), so fail loudly rather than guess.
  const settings = readPiOauthSettings(join(agentDir, 'settings.json'));
  const provider = credentialProvider ?? settings.provider;
  if (provider === undefined || provider === '') {
    throw new ProvisionError(
      'pi oauth login: cannot determine provider; set the credential provider or add defaultProvider to the host pi settings.json',
    );
  }

  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(configDir, 'sessions'), { recursive: true });

  // Copy the OAuth credential verbatim through the O_NOFOLLOW-protected writer.
  writePrivateFileNoFollow(join(configDir, 'auth.json'), readFileSync(source));

  // settings.json: provider from host settings, model from the credential.
  const settingsBody = {
    defaultProvider: provider,
    defaultModel: credentialModel,
    defaultThinkingLevel: 'medium',
  };
  writeFileSync(
    join(configDir, 'settings.json'),
    `${JSON.stringify(settingsBody, null, 2)}\n`,
  );

  // pi.env carries provider/model for the launcher; no PI_API_KEY in OAuth mode.
  writePiEnvFile(configDir, provider, credentialModel, undefined, {});
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

// Write the pi models.json that registers the custom provider + model. Uses the
// fixed provider name 'quorum' (not the credential name) so pi's internal routing
// always points at the same slot regardless of which credential is active.
// Mode 0600 because it carries the API key.
function writePiModelsJson(
  configDir: string,
  baseUrl: string,
  piApi: string,
  apiKey: string,
  model: string,
  compat: { thinkingFormat?: string; maxTokensField?: string },
  reasoning: boolean,
): void {
  const modelEntry: Record<string, unknown> = {
    id: model,
    name: model,
  };
  const compatObj: Record<string, string> = {};
  if (compat.thinkingFormat !== undefined) {
    compatObj['thinkingFormat'] = compat.thinkingFormat;
  }
  if (compat.maxTokensField !== undefined) {
    compatObj['maxTokensField'] = compat.maxTokensField;
  }
  if (Object.keys(compatObj).length > 0) {
    modelEntry['compat'] = compatObj;
  }
  if (reasoning) {
    modelEntry['reasoning'] = true;
  }

  const body = {
    providers: {
      quorum: {
        baseUrl,
        api: piApi,
        apiKey,
        models: [modelEntry],
      },
    },
  };
  writeFileSync(
    join(configDir, 'models.json'),
    `${JSON.stringify(body, null, 2)}\n`,
    { mode: 0o600 },
  );
}

// Pi-family provisioning. Requires a Credential — throws ProvisionError when
// none is supplied. Branches on credential.auth:
//
//   api-key: custom-endpoint (e.g. GLM/ollama). Requires credential.base_url.
//     Resolves the API key via resolveApiKey. Maps credential.api to pi's api
//     name (only openai-chat → openai-completions is supported). Writes
//     models.json, settings.json, auth.json (with the RESOLVED key), and pi.env
//     under a fixed provider name 'quorum'.
//
//   oauth: native pi host login. Seeds the host auth.json + writes settings.json
//     (provider from host settings, model from credential.model) and pi.env.
//
//   other (subscription): throws — pi has no subscription path.
//
// PI_CODING_AGENT_DIR collapse: home.configDir is rooted under the throwaway
// $HOME at <runHome>/.pi/agent (pi.yaml: home_config_subdir ".pi/agent"), which
// is exactly where pi defaults its config + session dir when neither
// PI_CODING_AGENT_DIR nor --session-dir is set. provision seeds the files under
// configDir; the launcher omits the config-dir var and --session-dir, so pi
// discovers it all via the isolated $HOME. The runner resolves session_log_dir
// against $QUORUM_AGENT_HOME (${QUORUM_AGENT_HOME}/.pi/agent/sessions) for
// capture and bakes the path into the HOWTO/launcher.
export class PiAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }

  provision(
    home: RunHome,
    _runner: CommandRunner,
    credential: Credential | undefined,
  ): Record<string, string> {
    const { configDir } = home;

    if (credential === undefined) {
      throw new ProvisionError('pi requires a credential');
    }

    // SUPERPOWERS_ROOT is required in both auth paths; verify it first.
    const superpowersRaw = requirePiEnv(
      'SUPERPOWERS_ROOT',
      'load Pi Superpowers extension',
    );

    // Verify SUPERPOWERS_ROOT carries the Pi support files, then that the pi
    // binary is on PATH — both before any filesystem mutation.
    requirePiSuperpowersSource(expanduser(superpowersRaw));
    requirePiOnPath();

    if (credential.auth === 'oauth') {
      seedPiOauth(configDir, credential.model, credential.provider);
      return {};
    }

    if (credential.auth !== 'api-key') {
      throw new ProvisionError(
        `pi: auth '${credential.auth}' is not supported; use 'api-key' or 'oauth'`,
      );
    }

    // api-key path: custom endpoint (e.g. GLM, ollama).
    const { base_url: baseUrl } = credential;
    if (baseUrl === undefined || baseUrl === '') {
      throw new ProvisionError(
        'pi: api-key credential requires base_url for the custom endpoint',
      );
    }

    const piApi = CREDENTIAL_API_TO_PI_API[credential.api];
    if (piApi === undefined) {
      throw new ProvisionError(
        `pi: api '${credential.api}' is not supported; pi custom-endpoint supports openai-chat (maps to openai-completions)`,
      );
    }

    let resolution: ApiKeyResolution;
    try {
      resolution = resolveApiKey(credential, 'PI_API_KEY');
    } catch (e) {
      throw new ProvisionError(e instanceof Error ? e.message : String(e));
    }
    if (resolution.kind !== 'env') {
      // resolveApiKey returns 'native' only when auth !== 'api-key', which cannot
      // happen here, but guard explicitly.
      throw new ProvisionError('pi: could not resolve api key from credential');
    }
    const resolvedKey = resolution.value;

    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(configDir, 'sessions'), { recursive: true });

    const credCompat = credential.compat;
    const piCompat: { thinkingFormat?: string; maxTokensField?: string } = {};
    if (credCompat.thinking_format !== undefined) {
      piCompat.thinkingFormat = credCompat.thinking_format;
    }
    if (credCompat.max_tokens_field !== undefined) {
      piCompat.maxTokensField = credCompat.max_tokens_field;
    }

    // reasoning: true only when thinking_format is set.
    const reasoning = credCompat.thinking_format !== undefined;

    // models.json (mode 0600): registers the quorum provider with the custom
    // endpoint, api, key, and model entry with compat/reasoning.
    writePiModelsJson(
      configDir,
      baseUrl,
      piApi,
      resolvedKey,
      credential.model,
      piCompat,
      reasoning,
    );

    // settings.json: fixed provider name 'quorum', model from credential.
    const settingsBody = {
      defaultProvider: 'quorum',
      defaultModel: credential.model,
      defaultThinkingLevel: 'medium',
    };
    writeFileSync(
      join(configDir, 'settings.json'),
      `${JSON.stringify(settingsBody, null, 2)}\n`,
    );

    // auth.json (mode 0600): keyed to the RESOLVED key, not the "$PI_API_KEY"
    // placeholder. This is the spec §9.2 fix — the real key goes here.
    const authBody: Record<string, { type: string; key: string }> = {
      quorum: { type: 'api_key', key: resolvedKey },
    };
    writePrivateFileNoFollow(
      join(configDir, 'auth.json'),
      `${JSON.stringify(authBody, null, 2)}\n`,
    );

    // pi.env (mode 0600): PI_PROVIDER=quorum, PI_MODEL, PI_API_KEY (resolved).
    writePiEnvFile(configDir, 'quorum', credential.model, resolvedKey, {});

    return {};
  }
}
