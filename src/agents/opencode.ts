import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import type { Credential } from '../contracts/credential.ts';
import type { ApiKeyResolution } from '../credentials/resolve.ts';
import { resolveApiKey } from '../credentials/resolve.ts';
import { envSnapshot, getEnv } from '../env.ts';
import { stageSuperpowersPlugin } from '../setup-helpers/plugin-stage.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';
import {
  defaultSpawn,
  OpenCodeTimeoutError,
  opencodeEnv,
  runOpencodeCommand,
  type SpawnFn,
} from './opencode-capture.ts';

// OpenCode-family provisioning. provision() is SETUP ONLY: it stages Superpowers
// into an XDG-isolated OpenCode home, builds the provider config from the
// credential, and runs a throwaway-home provider preflight so the eval fails
// fast if the configured provider cannot answer.
//
// The opencode_home root IS home.configDir: every XDG root and the plugin
// staging live under it. With opencode.yaml's `home_config_subdir: "."`,
// home.configDir IS the per-run throwaway $HOME (runHomeDir = $QUORUM_AGENT_HOME),
// so the agent finds its config via its $HOME default. opencode keys its session
// DB off XDG_DATA_HOME (= <home>/.local/share), so this home is also the session
// store the capture subprocess (opencodeEnv, same home) reads.

// Map credential.api to the opencode npm package name. Only openai-* and
// anthropic are supported — do NOT invent package names for other APIs.
const CREDENTIAL_API_TO_OPENCODE_NPM: Readonly<Record<string, string>> = {
  'openai-chat': '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai-compatible',
  anthropic: '@ai-sdk/anthropic',
};

// opencode ships built-in providers (from models.dev) that know each model's
// real rates and request quirks — e.g. the built-in `openai` provider uses
// @ai-sdk/openai, which sends `max_completion_tokens` for reasoning models
// (gpt-5.x) and self-reports cost. When a credential's endpoint IS one of those
// first-party hosts, we use the built-in provider BY NAME (no `npm`: opencode
// supplies it) so we inherit correct request shaping and the real model catalog.
// Any other endpoint (GLM, ollama, openrouter, …) has no built-in provider and
// uses the custom 'quorum' provider with an explicit npm package. Add the next
// first-party host here (e.g. Azure OpenAI, api.anthropic.com) when configured.
const FIRST_PARTY_HOST_TO_BUILTIN_PROVIDER: Readonly<Record<string, string>> = {
  'api.openai.com': 'openai',
};

function builtinProviderForEndpoint(
  baseUrl: string | undefined,
): string | undefined {
  if (baseUrl === undefined || baseUrl === '') {
    return undefined;
  }
  try {
    return FIRST_PARTY_HOST_TO_BUILTIN_PROVIDER[new URL(baseUrl).hostname];
  } catch {
    return undefined;
  }
}

const OPENCODE_EXPORT_SUBDIR = '.quorum/session-exports';

// The stale-export glob (coding-agents/opencode.yaml session_log_glob): files
// named `<16-digit created>-ses_<id>.json`.
const STALE_EXPORT_RE = /^[0-9].*-ses_.*\.json$/;

// Normalize trailing punctuation, whitespace, and case; accept only a bare "OK",
// reject empty / verbose replies.
function preflightResponseOk(stdout: string): boolean {
  return (
    stdout
      .trim()
      .replace(/[.!]+$/, '')
      .trim()
      .toUpperCase() === 'OK'
  );
}

// lstat-based symlink probe that never throws on a missing path.
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Refuse any symlink under `root` (recursively). A missing root is fine — the
// required-files check reports it.
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

// A staged path must resolve under the isolated opencode_home (no escape via
// symlink or traversal).
function requireUnderHome(path: string, opencodeHome: string): void {
  const homeReal = resolve(opencodeHome);
  const pathReal = resolve(path);
  const rel = relative(homeReal, pathReal);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new ProvisionError(
      `staged OpenCode Superpowers path escapes isolated home: ${path}`,
    );
  }
}

// Recursively yield every path under `root` (depth-first), for the under-home
// containment audit.
function* walk(root: string): Generator<string> {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return;
  }
  for (const entry of readdirSync(root)) {
    const child = join(root, entry);
    yield child;
    if (!isSymlink(child) && statSync(child).isDirectory()) {
      yield* walk(child);
    }
  }
}

// PATH lookups. Bun.which resolves a real PATH entry; a `command -v` shell
// builtin ENOENTs on Linux (no `command` executable) and would falsely report
// not-found.
function binaryOnPath(binary: string): boolean {
  return Bun.which(binary, { PATH: envSnapshot()['PATH'] ?? '' }) !== null;
}

// Build the opencode.json config object from a credential and resolved api key.
// A first-party endpoint (see builtinProviderForEndpoint, e.g. api.openai.com →
// 'openai') uses opencode's BUILT-IN provider by name with no `npm` field, so
// opencode supplies the right SDK (@ai-sdk/openai, which sends
// max_completion_tokens for reasoning models) and the real model catalog. Every
// other endpoint uses the FIXED custom provider 'quorum' with an explicit npm,
// mapping credential.api:
//   openai-chat / openai-responses → @ai-sdk/openai-compatible
//   anthropic → @ai-sdk/anthropic
// For @ai-sdk/openai-compatible, options.baseURL is required (custom endpoint);
// otherwise baseURL is included only when credential.base_url is set. reasoning:
// true is set only when credential.compat.thinking_format is set; tool_call is
// always true. The top-level `model` is the provider-qualified ref the launcher
// and preflight pass to opencode. Throws ProvisionError for an unmappable api.
function buildOpencodeConfig(
  credential: Credential,
  apiKey: string,
): Record<string, unknown> {
  const modelEntry: Record<string, unknown> = { tool_call: true };
  if (credential.compat.thinking_format !== undefined) {
    modelEntry['reasoning'] = true;
  }

  // First-party endpoint → opencode's built-in provider, by name, no npm.
  const builtin = builtinProviderForEndpoint(credential.base_url);
  if (builtin !== undefined) {
    const options: Record<string, string> = { apiKey };
    // base_url is the recognized first-party host; pin it explicitly.
    if (credential.base_url !== undefined && credential.base_url !== '') {
      options['baseURL'] = credential.base_url;
    }
    return {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [builtin]: {
          options,
          models: { [credential.model]: modelEntry },
        },
      },
      model: `${builtin}/${credential.model}`,
    };
  }

  // Custom endpoint → the fixed 'quorum' provider with an explicit npm package.
  const npm = CREDENTIAL_API_TO_OPENCODE_NPM[credential.api];
  if (npm === undefined) {
    throw new ProvisionError(
      `opencode: api '${credential.api}' is not supported; supported: openai-chat, openai-responses, anthropic`,
    );
  }

  const options: Record<string, string> = { apiKey };
  if (npm === '@ai-sdk/openai-compatible') {
    // openai-compatible always needs baseURL for a custom endpoint.
    if (credential.base_url === undefined || credential.base_url === '') {
      throw new ProvisionError(
        'opencode: openai-compatible api requires base_url for the custom endpoint',
      );
    }
    options['baseURL'] = credential.base_url;
  } else if (credential.base_url !== undefined && credential.base_url !== '') {
    // anthropic: include baseURL only when set.
    options['baseURL'] = credential.base_url;
  }

  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      quorum: {
        npm,
        options,
        models: {
          [credential.model]: modelEntry,
        },
      },
    },
    model: `quorum/${credential.model}`,
  };
}

// Write the opencode.json to `configDir/.config/opencode/opencode.json` with
// mode 0600 (it carries the API key).
function writeOpencodeJson(
  opencodeConfigDir: string,
  config: Record<string, unknown>,
): void {
  writeFileSync(
    join(opencodeConfigDir, 'opencode.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export class OpenCodeAgent implements CodingAgent {
  readonly config: AgentConfig;
  // Injectable opencode subprocess seam (the file-stdout / allowlist-env path).
  // resolveAgent constructs with one arg, so live runs get defaultSpawn; tests
  // pass a fake that records the preflight invocations.
  private readonly spawn: SpawnFn;

  // erasableSyntaxOnly forbids `constructor(readonly config)`; assign in body.
  constructor(config: AgentConfig, spawn: SpawnFn = defaultSpawn) {
    this.config = config;
    this.spawn = spawn;
  }

  provision(
    home: RunHome,
    runner: CommandRunner,
    credential: Credential | undefined,
  ): Record<string, string> {
    if (credential === undefined) {
      throw new ProvisionError('opencode requires a credential');
    }

    if (credential.auth !== 'api-key') {
      throw new ProvisionError(
        `opencode: auth '${credential.auth}' is not supported; use 'api-key'`,
      );
    }

    const opencodeHome = home.configDir;

    // SUPERPOWERS_ROOT is required. Read env ONLY via the sanctioned env module.
    const superpowersRoot = getEnv('SUPERPOWERS_ROOT');
    if (superpowersRoot === undefined || superpowersRoot === '') {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot install opencode Superpowers plugin',
      );
    }

    // Fail fast when the opencode binary is absent, before any staging, so a
    // missing binary yields a precise diagnostic instead of an opaque downstream
    // preflight spawn failure.
    if (!binaryOnPath('opencode')) {
      throw new ProvisionError(
        'opencode not found on PATH; cannot run opencode evals',
      );
    }

    // Verify the required Superpowers OpenCode plugin source files exist.
    const pluginSrc = join(
      superpowersRoot,
      '.opencode',
      'plugins',
      'superpowers.js',
    );
    const required = [
      pluginSrc,
      join(superpowersRoot, 'skills', 'using-superpowers', 'SKILL.md'),
      join(superpowersRoot, 'skills', 'brainstorming', 'SKILL.md'),
    ];
    const missing = required.filter((path) => !existsSync(path));
    if (missing.length > 0) {
      throw new ProvisionError(
        `SUPERPOWERS_ROOT is missing OpenCode plugin files: ${missing.join(', ')}`,
      );
    }

    // Refuse to proceed if pre-existing session exports already sit under the
    // export dir before the capture snapshot, so a prior run's exports cannot be
    // mis-attributed to this run.
    const exportDir = join(opencodeHome, OPENCODE_EXPORT_SUBDIR);
    const staleExports = existsSync(exportDir)
      ? readdirSync(exportDir)
          .filter((name) => STALE_EXPORT_RE.test(name))
          .sort()
          .map((name) => join(exportDir, name))
      : [];
    if (staleExports.length > 0) {
      throw new ProvisionError(
        `pre-existing OpenCode session exports before capture snapshot: ${staleExports
          .slice(0, 3)
          .join(', ')}`,
      );
    }

    // Reject any symlink under SUPERPOWERS_ROOT/skills before copying it into the
    // isolated home.
    rejectSymlinks(join(superpowersRoot, 'skills'), 'SUPERPOWERS_ROOT skills');

    // Resolve the API key before writing any files so a missing key is caught early.
    let resolution: ApiKeyResolution;
    try {
      resolution = resolveApiKey(credential, 'OPENAI_API_KEY');
    } catch (e) {
      throw new ProvisionError(e instanceof Error ? e.message : String(e));
    }
    if (resolution.kind !== 'env') {
      throw new ProvisionError(
        'opencode: could not resolve api key from credential',
      );
    }
    const apiKey = resolution.value;

    // Build the opencode.json config once; write it into both the run home and
    // the preflight throwaway home.
    const opencodeJsonConfig = buildOpencodeConfig(credential, apiKey);
    // The provider-qualified model ref (e.g. quorum/<m> or openai/<m>) the
    // preflight + launcher pass to opencode — buildOpencodeConfig set it.
    const modelRef = opencodeJsonConfig['model'] as string;

    // Create the XDG-isolated dirs and the session-export dir.
    const opencodeConfigDir = join(opencodeHome, '.config', 'opencode');
    for (const dir of [
      opencodeConfigDir,
      join(opencodeHome, '.local', 'share', 'opencode'),
      join(opencodeHome, '.local', 'state', 'opencode'),
      join(opencodeHome, '.cache'),
      join(opencodeHome, '.tmp'),
      exportDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // opencode.json: credential-derived provider config. Secret file (carries the
    // API key) — written with mode 0600.
    writeOpencodeJson(opencodeConfigDir, opencodeJsonConfig);

    // Stage the whole plugin into package_root via the shared helper, then
    // symlink config/plugins/superpowers.js -> the staged plugin entry. The helper
    // drops eval output + VCS/build cruft; .opencode/plugins/superpowers.js and
    // skills/ come along as part of the plugin payload.
    const packageRoot = join(opencodeConfigDir, 'superpowers');
    stageSuperpowersPlugin(superpowersRoot, packageRoot);
    const stagedPlugin = join(
      packageRoot,
      '.opencode',
      'plugins',
      'superpowers.js',
    );
    const stagedSkills = join(packageRoot, 'skills');

    const pluginLinkDir = join(opencodeConfigDir, 'plugins');
    const pluginLink = join(pluginLinkDir, 'superpowers.js');
    mkdirSync(pluginLinkDir, { recursive: true });
    if (existsSync(pluginLink) || isSymlink(pluginLink)) {
      rmSync(pluginLink, { force: true });
    }
    symlinkSync(stagedPlugin, pluginLink);

    // node --check the staged plugin ONLY when node is on PATH: a host without
    // node skips the check and proceeds, rather than failing on an unspawnable
    // binary. A non-zero check when node IS present is a hard ProvisionError.
    if (binaryOnPath('node')) {
      const node = getEnv('OPENCODE_NODE_BIN') ?? 'node';
      const nodeCheck = runner.run(node, ['--check', stagedPlugin], {
        env: envSnapshot(),
      });
      if (nodeCheck.status !== 0) {
        throw new ProvisionError(
          `staged OpenCode Superpowers plugin failed node --check: ${nodeCheck.stderr.trim().slice(0, 300)}`,
        );
      }
    }

    // Prove the staged plugin, the plugin symlink, the staged skills dir, and
    // every file beneath it resolve under the isolated home (no escape via
    // symlink or traversal).
    requireUnderHome(stagedPlugin, opencodeHome);
    requireUnderHome(pluginLink, opencodeHome);
    requireUnderHome(stagedSkills, opencodeHome);
    for (const path of walk(stagedSkills)) {
      requireUnderHome(path, opencodeHome);
    }

    // Provider preflight: throwaway isolated home with the same provider config,
    // retry up to 3x, expect "OK".
    this.runProviderPreflight(opencodeJsonConfig, modelRef);

    // Return the extra-env the runner threads into the run: the XDG isolation
    // vars (opencode_env). opencodeHome IS the per-run throwaway $HOME
    // (= $QUORUM_AGENT_HOME), so the runner resolves session_log_dir against
    // $QUORUM_AGENT_HOME (${QUORUM_AGENT_HOME}/.quorum/session-exports) and the
    // launcher pins HOME to that same home via $QUORUM_HOME_ENV.
    return {
      ...opencodeEnv(opencodeHome),
    };
  }

  // Build a throwaway isolated home with the same provider config, probe
  // `opencode --version`, then up to 3x run `opencode run -m <model>
  // --dangerously-skip-permissions "Reply with EXACTLY OK."` and accept the
  // first exit-0 "OK" reply. Drives opencode through runOpencodeCommand
  // (regular-file stdout + allowlisted env) so the bare process.exit() cannot
  // truncate the reply and no host vars leak in.
  private runProviderPreflight(
    opencodeJsonConfig: Record<string, unknown>,
    modelRef: string,
  ): void {
    const tmp = mkdtempSync(join(tmpdir(), 'quorum-opencode-preflight-'));
    try {
      const cwd = join(tmp, 'cwd');
      const home = join(tmp, 'home');
      const preflightConfigDir = join(home, '.config', 'opencode');
      mkdirSync(cwd, { recursive: true });
      for (const dir of [
        preflightConfigDir,
        join(home, '.local', 'share', 'opencode'),
        join(home, '.local', 'state', 'opencode'),
        join(home, '.cache'),
        join(home, '.tmp'),
      ]) {
        mkdirSync(dir, { recursive: true });
      }

      // Write the same provider config into the preflight throwaway home so the
      // custom provider/model resolves during the preflight run.
      writeOpencodeJson(preflightConfigDir, opencodeJsonConfig);

      // Version probe (best-effort). A failed probe only weakens the diagnostic
      // hint, never aborts.
      let versionHint = 'unknown';
      try {
        const version = runOpencodeCommand(['--version'], {
          opencodeHome: home,
          launchCwd: cwd,
          timeoutMs: 15_000,
          spawn: this.spawn,
        });
        versionHint = (version.stdout || version.stderr).trim() || 'unknown';
      } catch {
        // best-effort
      }

      let lastExit: number | null = null;
      let lastStdout = '';
      let lastStderr = '';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let result: ReturnType<typeof runOpencodeCommand>;
        try {
          result = runOpencodeCommand(
            [
              'run',
              '-m',
              modelRef,
              '--dangerously-skip-permissions',
              'Reply with EXACTLY OK.',
            ],
            {
              opencodeHome: home,
              launchCwd: cwd,
              timeoutMs: 90_000,
              spawn: this.spawn,
            },
          );
        } catch (e) {
          // A timeout raises on the FIRST occurrence; it is NOT swallowed and
          // retried. Surface it as a setup-stage ProvisionError.
          if (e instanceof OpenCodeTimeoutError) {
            throw new ProvisionError(
              'opencode provider preflight timed out after 90s',
            );
          }
          throw e;
        }
        lastExit = result.exitCode;
        lastStdout = result.stdout;
        lastStderr = result.stderr;
        if (result.exitCode === 0 && preflightResponseOk(result.stdout)) {
          return;
        }
      }

      if (lastExit !== 0) {
        throw new ProvisionError(
          `opencode provider preflight failed (version ${versionHint.slice(0, 120)}, exit ${lastExit}); stderr: ${lastStderr.trim().slice(0, 300)}`,
        );
      }
      throw new ProvisionError(
        `opencode provider preflight did not return OK after 3 attempts; version ${versionHint.slice(0, 120)}, stdout: ${lastStdout.trim().slice(0, 300)}, stderr: ${lastStderr.trim().slice(0, 300)}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
