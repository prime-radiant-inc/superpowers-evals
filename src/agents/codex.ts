import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from '../contracts/agent-config.ts';
import type { Credential } from '../contracts/credential.ts';
import { resolveApiKey } from '../credentials/resolve.ts';
import { getEnv } from '../env.ts';
import { stageSuperpowersPlugin } from '../setup-helpers/plugin-stage.ts';
import type { AppServerClient } from './codex-app-server.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';
import { writePrivateFileNoFollow } from './private-file.ts';

// Codex-family provisioning. provision() is SETUP ONLY: it seeds the per-run
// CODEX_HOME so the agent boots past the sign-in picker with Superpowers staged
// as a trusted SessionStart plugin hook.
//
// B4: provision() now requires a Credential and branches on credential.auth:
//
//   subscription (codex_sub, the default): copies the host ChatGPT subscription
//     auth.json from ~/.codex/auth.json into the per-run CODEX_HOME (mode 0600,
//     O_NOFOLLOW) and writes a bare features/plugins config.toml (no
//     model/model_provider/[model_providers] — subscription is model-driven by
//     the account). No codex-api.env is written.
//
//   api-key (glm_5_2_responses and similar): writes a config.toml with
//     top-level model/model_provider and a [model_providers."quorum"] block
//     (base_url, wire_api, env_key = CODEX_PROVIDER_API_KEY), then the same
//     features/plugins + trusted_hash blocks. Writes a mode-0600 codex-api.env
//     the launcher sources so CODEX_PROVIDER_API_KEY reaches codex for the
//     custom provider. No auth.json is written.
//
// The per-run CODEX_HOME is `home.configDir`, rooted at <runHome>/.codex by
// codex.yaml: home_config_subdir ".codex". Codex defaults CODEX_HOME to
// $HOME/.codex so the launcher sets only the isolated $HOME — no CODEX_HOME var.
//
// That leaves exactly ONE subprocess interaction on both paths:
//   - `codex app-server --listen stdio://` JSON-RPC (initialize + hooks/list)
//     to read the staged Superpowers hook's key + currentHash, written as
//     trusted_hash in config.toml. Driven through the injected AppServerClient —
//     a BOUNDED spawn seam so tests stub it and live runs have a per-handshake
//     deadline.

// Basename of the per-run env file the api-key path writes under configDir. The
// runner derives the launcher's $CODEX_ENV_FILE substitution from this
// deterministic path, so the constant is the single source of truth for both
// sides.
export const CODEX_API_ENV_FILE_NAME = 'codex-api.env';

// The provider env_key: the env var name codex reads the API key from for the
// custom provider. Deliberately NOT an OPENAI_* name so the launcher's
// `env -u OPENAI_API_KEY …` scrub does not strip it.
export const CODEX_API_PROVIDER_ENV_KEY = 'CODEX_PROVIDER_API_KEY';

// Narrowing schema for the host ~/.codex/auth.json (standard §4.1). Permissive:
// auth.json carries many other fields, and a non-object `tokens` must surface as
// a missing-refresh-token error, not a schema crash. So `tokens` is coerced to
// undefined when absent or non-object, and unknown top-level keys pass through.
const CodexTokensSchema = z
  .object({ refresh_token: z.string().nullish() })
  .nullish()
  .catch(undefined);

const CodexAuthSchema = z
  .object({
    auth_mode: z.string().nullish(),
    OPENAI_API_KEY: z.string().nullish(),
    tokens: CodexTokensSchema,
  })
  .passthrough();

export class CodexAgent implements CodingAgent {
  readonly config: AgentConfig;

  // PRI-2506: The app-server seam is no longer used (hook-less provisioning).
  // The constructor signature still accepts appServer for test compatibility, but
  // it's unused. The shared CommandRunner is unused by codex (auth is a file copy),
  // but provision() keeps it for the CodingAgent contract that other agents fulfill.
  constructor(config: AgentConfig, _appServer?: AppServerClient) {
    this.config = config;
  }

  provision(
    home: RunHome,
    _runner: CommandRunner,
    credential?: Credential,
  ): Record<string, string> {
    if (credential === undefined) {
      throw new ProvisionError('codex requires a credential');
    }

    const { configDir, workdir, skeletonRoot } = home;
    const family = this.config.runtime_family ?? 'codex';

    const superpowersRoot = getEnv('SUPERPOWERS_ROOT');
    if (superpowersRoot === undefined || superpowersRoot === '') {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot install codex plugin hooks',
      );
    }

    // Seed the config dir from the skeleton when one is staged, else an empty dir.
    const skel =
      skeletonRoot !== undefined
        ? join(skeletonRoot, `${family}-home-skeleton`)
        : undefined;
    if (skel !== undefined && existsSync(skel)) {
      cpSync(skel, configDir, { recursive: true });
    } else {
      mkdirSync(configDir, { recursive: true });
    }

    if (credential.auth === 'subscription') {
      // 1. Copy the host's ChatGPT subscription auth into the fresh CODEX_HOME.
      this.seedCodexAuth(configDir);
      // 2. Stage Superpowers with bare features/plugins config (no model block).
      this.installPluginHooksSubscription(configDir, workdir, superpowersRoot);
    } else if (credential.auth === 'api-key') {
      // Resolve the API key from the credential's api_key_env. There is no
      // codex-conventional key env, so pass undefined as the harness env arg.
      let apiKey: string;
      try {
        const resolution = resolveApiKey(credential, undefined);
        if (resolution.kind !== 'env') {
          throw new ProvisionError(
            'codex api-key credential did not resolve to an env var',
          );
        }
        apiKey = resolution.value;
      } catch (e) {
        if (e instanceof ProvisionError) throw e;
        throw new ProvisionError(
          `codex api-key credential: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const baseUrl = credential.base_url;
      if (baseUrl === undefined || baseUrl === '') {
        throw new ProvisionError('codex api-key credential requires base_url');
      }

      const wireApi = mapWireApi(credential.api);

      // Stage Superpowers with a full model_providers config.toml.
      this.installPluginHooksApiKey(
        configDir,
        workdir,
        superpowersRoot,
        credential.model,
        baseUrl,
        wireApi,
      );

      // Write the mode-0600 env file the launcher sources so the provider's
      // env_key carries the API key to codex. Secrets live in files, never env.
      writeProviderEnvFile(configDir, apiKey);
    } else {
      throw new ProvisionError(
        `codex has no ${credential.auth} provisioner (only subscription and api-key are supported)`,
      );
    }

    // No extra env: Codex finds CODEX_HOME via its $HOME/.codex default.
    return {};
  }

  // Seed ChatGPT subscription auth into the isolated per-run CODEX_HOME. Reads
  // the host's ~/.codex/auth.json, asserts it is subscription auth (auth_mode
  // === 'chatgpt' and no API key) carrying a refresh token, then writes it to
  // configDir/auth.json at 0600 through an O_NOFOLLOW-protected open. The parsed
  // JSON is unknown until narrowed by CodexAuthSchema (standard §4.1).
  private seedCodexAuth(configDir: string): void {
    // Host subscription auth lives at ~/.codex/auth.json. CODEX_AUTH_HOME
    // overrides the parent dir so the hermetic gate can point it at a temp dir —
    // the same seam the gemini adapter uses for GEMINI_OAUTH_HOME, since
    // homedir() ignores a mid-process $HOME change.
    const authHome = getEnv('CODEX_AUTH_HOME') ?? join(homedir(), '.codex');
    const source = join(authHome, 'auth.json');
    if (!existsSync(source)) {
      throw new ProvisionError(
        'Codex ChatGPT subscription auth not found at ~/.codex/auth.json; run `codex login` before Codex evals',
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(source, 'utf8'));
    } catch {
      throw new ProvisionError(
        'Codex ChatGPT subscription auth at ~/.codex/auth.json is not valid JSON',
      );
    }
    const auth = CodexAuthSchema.parse(raw);

    // Subscription auth only: auth_mode 'chatgpt' AND no embedded API key.
    if (
      auth.auth_mode !== 'chatgpt' ||
      (auth.OPENAI_API_KEY !== null && auth.OPENAI_API_KEY !== undefined)
    ) {
      throw new ProvisionError(
        'Codex evals require ChatGPT subscription auth in ~/.codex/auth.json, not API-key auth',
      );
    }
    const tokens = auth.tokens;
    if (
      tokens === undefined ||
      tokens === null ||
      tokens.refresh_token === undefined ||
      tokens.refresh_token === null ||
      tokens.refresh_token === ''
    ) {
      throw new ProvisionError(
        'Codex ChatGPT subscription auth is missing a refresh token; run `codex login` again',
      );
    }

    // Write the credential through an O_NOFOLLOW-protected open so a pre-placed
    // symlink at <CODEX_HOME>/auth.json cannot redirect the host's subscription
    // auth to an attacker-controlled path. Re-read the source bytes (the earlier
    // read was text for JSON validation) and write them verbatim at mode 0600.
    mkdirSync(configDir, { recursive: true });
    const dest = join(configDir, 'auth.json');
    writePrivateFileNoFollow(dest, readFileSync(source));
  }

  // Subscription path: stage Superpowers with bare features/plugins config.toml
  // (no model/model_provider/[model_providers] — subscription is account-driven).
  // PRI-2506: uniform hook-less provisioning — inject hooks:{}, no trust dance.
  private installPluginHooksSubscription(
    configDir: string,
    _workdir: string,
    superpowersRoot: string,
  ): void {
    this.stagePlugin(configDir, superpowersRoot);
    this.injectEmptyHooks(configDir);
    const configPath = join(configDir, 'config.toml');
    writePluginsOnlyConfig(configPath);
  }

  // Api-key path: stage Superpowers with a full config.toml (model + provider
  // block + features/plugins).
  // PRI-2506: uniform hook-less provisioning — inject hooks:{}, no trust dance.
  private installPluginHooksApiKey(
    configDir: string,
    _workdir: string,
    superpowersRoot: string,
    model: string,
    baseUrl: string,
    wireApi: string,
  ): void {
    this.stagePlugin(configDir, superpowersRoot);
    this.injectEmptyHooks(configDir);
    const configPath = join(configDir, 'config.toml');
    writeApiKeyConfig(configPath, model, baseUrl, wireApi);
  }

  // Copy the Superpowers plugin tree into the quorum-owned CODEX_HOME plugin
  // cache. Common to both subscription and api-key paths.
  private stagePlugin(configDir: string, superpowersRoot: string): void {
    if (!existsSync(superpowersRoot)) {
      throw new ProvisionError(
        `SUPERPOWERS_ROOT does not exist: ${superpowersRoot}`,
      );
    }
    const pluginRoot = join(
      configDir,
      'plugins',
      'cache',
      'debug',
      'superpowers',
      'local',
    );
    stageSuperpowersPlugin(superpowersRoot, pluginRoot);
  }

  // PRI-2506: inject `hooks: {}` into the STAGED plugin manifest so codex's
  // hooks.json auto-discovery is suppressed on every superpowers ref. Validates
  // that the manifest has a `skills` field (codex needs it for native discovery).
  private injectEmptyHooks(configDir: string): void {
    const pluginRoot = join(
      configDir,
      'plugins',
      'cache',
      'debug',
      'superpowers',
      'local',
    );
    const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');

    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new ProvisionError(
        `Could not read staged plugin manifest at ${manifestPath}`,
      );
    }

    if (manifest === null || typeof manifest !== 'object') {
      throw new ProvisionError('Staged plugin manifest is not a valid object');
    }

    const obj = manifest as Record<string, unknown>;

    // Require `skills` field: codex needs it to discover skills natively.
    if (typeof obj['skills'] !== 'string' || obj['skills'] === '') {
      throw new ProvisionError(
        'Staged plugin manifest missing skills field; codex requires it for native skill discovery',
      );
    }

    // Force hooks to empty object, preserving all other fields.
    obj['hooks'] = {};

    writeFileSync(manifestPath, `${JSON.stringify(obj, null, 2)}\n`);
  }
}

// Map Credential.api → codex wire_api string. Codex 0.141 only accepts
// "responses" at config load; "chat" is mapped honestly and will fail at
// runtime on current codex. Any other api value is a ProvisionError.
function mapWireApi(api: string): string {
  if (api === 'openai-responses') return 'responses';
  if (api === 'openai-chat') return 'chat';
  throw new ProvisionError(
    `codex does not support api "${api}"; only openai-responses and openai-chat are mappable`,
  );
}

// Subscription path: enable plugins and the superpowers@debug plugin.
// PRI-2506: plugins-only, no hooks/plugin_hooks/trusted_hash.
function writePluginsOnlyConfig(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    [
      '[features]',
      'plugins = true',
      '',
      '[plugins."superpowers@debug"]',
      'enabled = true',
      '',
    ].join('\n'),
  );
}

// Api-key path: write config.toml with top-level model/model_provider BEFORE
// any table (TOML requires root keys to lead), then the [model_providers."quorum"]
// block, then features/plugins.
// PRI-2506: plugins-only, no hooks/plugin_hooks/trusted_hash.
function writeApiKeyConfig(
  configPath: string,
  model: string,
  baseUrl: string,
  wireApi: string,
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    [
      `model = "${tomlBasicString(model)}"`,
      `model_provider = "quorum"`,
      '',
      `[model_providers."quorum"]`,
      `name = "quorum"`,
      `base_url = "${tomlBasicString(baseUrl)}"`,
      `env_key = "${CODEX_API_PROVIDER_ENV_KEY}"`,
      `wire_api = "${tomlBasicString(wireApi)}"`,
      '',
      '[features]',
      'plugins = true',
      '',
      '[plugins."superpowers@debug"]',
      'enabled = true',
      '',
    ].join('\n'),
  );
}

function tomlBasicString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

// Single-quote a value for a POSIX shell, escaping embedded single quotes, so
// the launcher's `. "$CODEX_ENV_FILE"` sources the key verbatim.
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Write codex-api.env (mode 0600, O_NOFOLLOW) carrying the provider API key as
// the env_key the launcher sources, so codex reads it for the custom provider.
function writeProviderEnvFile(configDir: string, apiKey: string): void {
  const path = join(configDir, CODEX_API_ENV_FILE_NAME);
  writePrivateFileNoFollow(
    path,
    `export ${CODEX_API_PROVIDER_ENV_KEY}=${shellSingleQuote(apiKey)}\n`,
  );
}

// The O_NOFOLLOW private-file writer lives in ./private-file.ts so every per-run
// env/credential writer (gemini, claude, copilot) shares one implementation.
// Re-exported here to preserve codex.ts's public surface: its importers,
// including the codex agent tests, resolve it through this module.
export { writePrivateFileNoFollow };
