import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';

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

// Write pi.env (mode 0600). Mirrors _write_pi_env_file: shlex-quoted export
// lines for PI_PROVIDER / PI_MODEL / PI_API_KEY, then extra env sorted by name,
// then a trailing empty line (the joined-with-newline list ends with "", so the
// file ends in a single newline).
function writePiEnvFile(
  configDir: string,
  provider: string,
  model: string,
  apiKey: string,
  extraEnv: Record<string, string>,
): void {
  const lines = [
    `export PI_PROVIDER=${shlexQuote(provider)}`,
    `export PI_MODEL=${shlexQuote(model)}`,
    `export PI_API_KEY=${shlexQuote(apiKey)}`,
  ];
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

// Pi-family provisioning (mirrors _seed_pi_config in quorum/runner.py). Setup
// only — it shells out to nothing, so `runner` is unused. It creates the
// isolated config dir and a sessions/ subdir, then writes auth.json (the API
// key is the literal placeholder "$PI_API_KEY", expanded later by the launcher
// from pi.env), settings.json, and pi.env. The returned env map carries only
// the agent_config_env -> configDir mapping; every secret lives in the written
// files, never in the returned env.
export class PiAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }

  provision(_home: RunHome, _runner: CommandRunner): Record<string, string> {
    const { configDir } = _home;

    // _require_env order in the oracle: SUPERPOWERS_ROOT, PI_PROVIDER,
    // PI_MODEL, PI_API_KEY. Reproduce it so the first-missing error matches.
    requirePiEnv('SUPERPOWERS_ROOT', 'load Pi Superpowers extension');
    const provider = requirePiEnv('PI_PROVIDER', 'configure Pi provider');
    const model = requirePiEnv('PI_MODEL', 'configure Pi model');
    const apiKey = requirePiEnv('PI_API_KEY', 'configure Pi API-key auth');
    const extraEnv = piProviderExtraEnv(provider);

    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(configDir, 'sessions'), { recursive: true });

    // auth.json (mode 0600). The key field is the literal "$PI_API_KEY"
    // placeholder, matching the oracle — the real key is supplied via pi.env.
    const authPath = join(configDir, 'auth.json');
    const authBody: Record<string, { type: string; key: string }> = {
      [provider]: { type: 'api_key', key: '$PI_API_KEY' },
    };
    writeFileSync(authPath, `${JSON.stringify(authBody, null, 2)}\n`, {
      mode: 0o600,
    });

    // settings.json (no special mode; matches the oracle, which omits chmod).
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
