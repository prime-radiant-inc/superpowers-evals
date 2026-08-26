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
import { resolveSuperpowersRoot } from './superpowers.ts';

// Codex-family provisioning. provision() is SETUP ONLY: it seeds the per-run
// CODEX_HOME so the agent boots past the sign-in picker with Superpowers staged
// as an enabled plugin (skills + whatever codex hooks its manifest declares).
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
// Provisioning spawns NO codex subprocess. The staged plugin's hooks are not
// trust-hashed into config.toml (the PRI-2506-era app-server handshake is
// gone); instead the launcher passes --dangerously-bypass-hook-trust, the
// mechanism the superpowers README prescribes for headless rigs, so the
// staged manifest's own hooks run without a trust prompt.

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

    // The superpowers root comes from the home spec: 'root' stages
    // Superpowers from that root; 'none' is the explicit stock arm and skips
    // every superpowers staging step below (the provider configuration still
    // applies); an undefined spec falls back to the ambient SUPERPOWERS_ROOT,
    // whose absence is a setup failure.
    const sp = resolveSuperpowersRoot(home);
    if (sp.kind === 'missing') {
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
      if (sp.kind === 'root') {
        this.installPluginHooksSubscription(configDir, workdir, sp.root);
      }
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

      // The provider configuration is not superpowers staging — a stock run
      // still needs the selected credential's endpoint — so it is written on
      // every arm; only the plugin staging and its config sections are
      // superpowers-only.
      if (sp.kind === 'root') {
        this.installPluginHooksApiKey(
          configDir,
          workdir,
          sp.root,
          credential.model,
          baseUrl,
          wireApi,
        );
      } else {
        writeProviderOnlyConfig(
          join(configDir, 'config.toml'),
          credential.model,
          baseUrl,
          wireApi,
        );
      }

      // Write the mode-0600 env file the launcher sources so the provider's
      // env_key carries the API key to codex. Secrets live in files, never env.
      writeProviderEnvFile(configDir, apiKey);
    } else {
      throw new ProvisionError(
        `codex has no ${credential.auth} provisioner (only subscription and api-key are supported)`,
      );
    }

    // Per-scenario config fragment: a scenario dir carrying codex.config.toml
    // gets its contents prepended verbatim to the generated config.toml (both
    // auth paths), so a scenario can tune codex runtime knobs (e.g.
    // model_context_window to force mid-run compaction). Prepend, not append:
    // the generated config ends in [table] headers, so appended root-level
    // keys would silently land inside the last table (a real 2026-08-04 run
    // shipped model_context_window into [plugins."superpowers@debug"], where
    // codex ignored it). No templating, no validation beyond "file exists".
    prependScenarioConfigFragment(
      join(configDir, 'config.toml'),
      home.scenarioDir,
    );

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
  // No trust dance: the launcher's --dangerously-bypass-hook-trust runs the
  // staged plugin's own hooks (when its manifest declares any) headlessly.
  private installPluginHooksSubscription(
    configDir: string,
    _workdir: string,
    superpowersRoot: string,
  ): void {
    this.stagePlugin(configDir, superpowersRoot);
    this.normalizeManifestHooks(configDir);
    const configPath = join(configDir, 'config.toml');
    writePluginsOnlyConfig(configPath);
  }

  // Api-key path: stage Superpowers with a full config.toml (model + provider
  // block + features/plugins).
  // No trust dance: the launcher's --dangerously-bypass-hook-trust runs the
  // staged plugin's own hooks (when its manifest declares any) headlessly.
  private installPluginHooksApiKey(
    configDir: string,
    _workdir: string,
    superpowersRoot: string,
    model: string,
    baseUrl: string,
    wireApi: string,
  ): void {
    this.stagePlugin(configDir, superpowersRoot);
    this.normalizeManifestHooks(configDir);
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

  // Normalize the STAGED plugin manifest's `hooks` field. Absent or null is
  // forced to `{}` so codex's hooks.json auto-discovery fallback
  // (DEFAULT_HOOKS_CONFIG_FILE — the Claude-shaped hook) cannot kick in and
  // stall the run on a trust prompt. An EXPLICIT hooks value is the branch
  // under test's own codex hook config (e.g. "./hooks/hooks-codex.json") and
  // is preserved verbatim — clobbering it silently disables the very hooks the
  // eval measures. Also validates that the manifest has a `skills` field
  // (codex needs it for native discovery).
  private normalizeManifestHooks(configDir: string): void {
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

    // Absent/null becomes {} (auto-discovery defense); an explicit value —
    // including dev's literal {} — passes through untouched.
    if (obj['hooks'] === undefined || obj['hooks'] === null) {
      obj['hooks'] = {};
    }

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

// Subscription path with Superpowers staged: enable plugins and the
// superpowers@debug plugin. Plugins-only, no hooks/plugin_hooks/trusted_hash.
function writePluginsOnlyConfig(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, pluginConfigSections().join('\n'));
}

// The plugin-specific config sections, shared by both auth arms when
// Superpowers is staged. The curated-marketplace disables exist because an
// authenticated codex fetches the curated remote marketplace at session
// start and its stale superpowers (6.2.0) out-competed the staged v7 plugin
// in a live run's skill list (2026-08-11, superpowers-bootstrap-codex). No
// config key suppresses the fetch itself (probed live: [plugins] recommended
// variants either crash the TUI or don't gate it), so the curated superpowers
// is disabled by plugin id — probed live: the curated skills leave the
// agent's skill list while the staged superpowers@debug still loads.
function pluginConfigSections(): string[] {
  return [
    '[features]',
    'plugins = true',
    '',
    '[plugins."superpowers@openai-curated-remote"]',
    'enabled = false',
    '',
    '[plugins."superpowers@openai-curated"]',
    'enabled = false',
    '',
    '[plugins."superpowers@debug"]',
    'enabled = true',
    '',
  ];
}

// The provider block the selected api-key credential requires: top-level
// model/model_provider BEFORE any table (TOML requires root keys to lead),
// then the [model_providers."quorum"] endpoint. Not superpowers staging — a
// stock run needs it to use the credential.
function providerConfigSections(
  model: string,
  baseUrl: string,
  wireApi: string,
): string[] {
  return [
    `model = "${tomlBasicString(model)}"`,
    `model_provider = "quorum"`,
    '',
    `[model_providers."quorum"]`,
    `name = "quorum"`,
    `base_url = "${tomlBasicString(baseUrl)}"`,
    `env_key = "${CODEX_API_PROVIDER_ENV_KEY}"`,
    `wire_api = "${tomlBasicString(wireApi)}"`,
  ];
}

// Api-key path with Superpowers staged: provider block + plugin sections.
// Plugins-only, no hooks/plugin_hooks/trusted_hash.
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
      ...providerConfigSections(model, baseUrl, wireApi),
      '',
      ...pluginConfigSections(),
    ].join('\n'),
  );
}

// Api-key path on the stock arm (no Superpowers): the provider block only —
// the stock run still uses the selected credential's endpoint, with no
// plugin sections and no staged plugin tree.
function writeProviderOnlyConfig(
  configPath: string,
  model: string,
  baseUrl: string,
  wireApi: string,
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    providerConfigSections(model, baseUrl, wireApi).join('\n'),
  );
}

// Prepend a scenario's codex.config.toml fragment to the generated config.toml:
// a provenance comment, the fragment byte-exact, then a separating blank line
// before the generated content. Prepending keeps the fragment's bare keys at
// TOML root scope — appending would place them inside the config's last
// [table]. A run without a scenario dir, or a scenario without the fragment,
// leaves the generated config untouched. A stock arm may generate no config
// of its own (subscription is account-driven); the fragment then stands as
// the whole file rather than failing on the absent generated config.
function prependScenarioConfigFragment(
  configPath: string,
  scenarioDir: string | undefined,
): void {
  if (scenarioDir === undefined) return;
  const fragmentPath = join(scenarioDir, 'codex.config.toml');
  if (!existsSync(fragmentPath)) return;
  const generated = existsSync(configPath)
    ? readFileSync(configPath, 'utf8')
    : '';
  writeFileSync(
    configPath,
    `# prepended from scenario codex.config.toml\n${readFileSync(fragmentPath, 'utf8')}\n${generated}`,
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
