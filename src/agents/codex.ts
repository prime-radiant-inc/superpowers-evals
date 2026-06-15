import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import {
  APP_SERVER_TIMEOUT_MS,
  type AppServerClient,
  SpawnAppServerClient,
} from './codex-app-server.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';
import { writePrivateFileNoFollow } from './private-file.ts';

// Codex-family provisioning. Ports quorum/runner.py:_seed_codex_auth +
// _seed_codex_plugin_hooks (which delegates to
// setup_helpers.worktree.install_codex_superpowers_plugin_hooks for the
// quorum-owned, already-logged-in CODEX_HOME path). provision() is SETUP ONLY:
// it seeds the per-run CODEX_HOME so the agent boots past the sign-in picker
// with Superpowers staged as a trusted SessionStart plugin hook.
//
// Auth is a validated file write, not a login subprocess (oracle d9ccf4e):
// _seed_codex_auth copies the host's ChatGPT subscription auth.json from
// ~/.codex/auth.json into the per-run CODEX_HOME (mode 0600, O_NOFOLLOW so a
// pre-placed symlink can't redirect the secret), after asserting it is
// subscription auth (not API-key auth) and carries a refresh token. The
// OPENAI_API_KEY env path is gone; the launch-agent scrubs OpenAI env so Codex
// uses the copied subscription auth.
//
// That leaves exactly ONE subprocess interaction:
//   - `codex app-server --listen stdio://` JSON-RPC (initialize + hooks/list)
//     to read the staged Superpowers hook's key + currentHash, which we then
//     record as a trusted_hash in config.toml.
// It is driven through the injected AppServerClient — a BOUNDED spawn seam
// (per-handshake deadline, mirroring worktree.py's 15s selector deadline) so a
// hung/non-flushing app-server can't block provisioning forever, and so the
// hermetic gate stubs it. Everything else (skeleton copy, auth copy, plugin
// copytree, config.toml) is deterministic file generation the gate asserts
// directly.

// Narrowing schema for the host ~/.codex/auth.json (standard §4.1). Permissive:
// auth.json carries many other fields, and a non-object `tokens` (Python's
// `not isinstance(tokens, dict)`) must surface as a missing-refresh-token error,
// not a schema crash. So `tokens` is coerced to undefined when absent or
// non-object, and unknown top-level keys pass through.
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

// Dirs under SUPERPOWERS_ROOT that the Python copytree ignores when staging the
// plugin (mirrors _ignore_codex_plugin_copy). These are excluded by basename
// anywhere in the tree.
const PLUGIN_COPY_IGNORE = new Set<string>([
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.ty',
  '.venv',
  '__pycache__',
  'node_modules',
]);

// Decide whether a source path is excluded from the staged Codex plugin copy.
//
// Two rules, applied in order:
//   1. Always drop the PLUGIN_COPY_IGNORE basenames (.git, node_modules, …)
//      anywhere in the tree.
//   2. Drop the ENTIRE `evals/` submodule at the superpowers root — `src`
//      resolving to `<superpowersRoot>/evals` (basename `evals` AND parent is
//      the root). Excluding the directory prunes its whole subtree (results/,
//      worktrees/, node_modules/, …), none of which belongs in the staged
//      plugin. The parent-is-root guard means a legitimate nested `evals` dir
//      deeper in the tree (e.g. inside a skill fixture) is still copied.
//
// Python parity note: the frozen Python (_ignore_codex_plugin_copy in
// setup_helpers/worktree.py) excluded only `evals/results`, keyed on the parent
// dir being named `evals`. This DIVERGES on purpose: live evals run from a
// superpowers checkout whose `evals/` submodule carries results/, per-run
// worktrees, and node_modules — all wasteful and fragile to stage. We exclude
// the whole `<root>/evals` subtree instead of just `evals/results`.
export function isCodexPluginCopyExcluded(
  src: string,
  superpowersRoot: string,
): boolean {
  if (PLUGIN_COPY_IGNORE.has(basename(src))) {
    return true;
  }
  if (
    basename(src) === 'evals' &&
    resolve(src) === resolve(superpowersRoot, 'evals')
  ) {
    return true;
  }
  return false;
}

// Realpath-safe directory containment: true when `child` is `parent` itself or
// strictly under it. Resolves both to absolute paths and compares with a
// trailing separator so `/a/bc` does not count as under `/a/b` (no false-prefix
// match). Used by the self-copy fail-fast guard.
export function isUnderDir(child: string, parent: string): boolean {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  if (resolvedChild === resolvedParent) {
    return true;
  }
  return resolvedChild.startsWith(resolvedParent + sep);
}

export class CodexAgent implements CodingAgent {
  readonly config: AgentConfig;
  private readonly appServer: AppServerClient;

  // `appServer` is the bounded app-server read seam; live runs use the
  // spawnSync-backed default, tests inject a fake. The shared CommandRunner is
  // unused by codex (auth is a file copy; the only subprocess is the app-server,
  // which has its own timed seam), but provision() keeps it for the CodingAgent
  // contract that other agents fulfill.
  constructor(config: AgentConfig, appServer?: AppServerClient) {
    this.config = config;
    this.appServer = appServer ?? new SpawnAppServerClient();
  }

  provision(home: RunHome, _runner: CommandRunner): Record<string, string> {
    const { configDir, workdir, skeletonRoot } = home;
    const family = this.config.runtime_family ?? 'codex';

    const superpowersRoot = getEnv('SUPERPOWERS_ROOT');
    if (superpowersRoot === undefined || superpowersRoot === '') {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot install codex plugin hooks',
      );
    }

    // Seed the config dir from the skeleton when one is staged, else an empty
    // dir (mirrors _seed_agent_config_dir's copytree-or-mkdir).
    const skel =
      skeletonRoot !== undefined
        ? join(skeletonRoot, `${family}-home-skeleton`)
        : undefined;
    if (skel !== undefined && existsSync(skel)) {
      cpSync(skel, configDir, { recursive: true });
    } else {
      mkdirSync(configDir, { recursive: true });
    }

    // 1. Copy the host's ChatGPT subscription auth into the fresh CODEX_HOME so
    //    the agent boots past the sign-in picker (_seed_codex_auth, oracle
    //    d9ccf4e). Validates and writes a file (O_NOFOLLOW) — no login subprocess.
    this.seedCodexAuth(configDir);

    // 2. Stage Superpowers as a trusted Codex plugin hook
    //    (install_codex_superpowers_plugin_hooks, quorum/codex_home path).
    this.installPluginHooks(configDir, workdir, superpowersRoot);

    return { [this.config.agent_config_env]: configDir };
  }

  // Seed ChatGPT subscription auth into the isolated per-run CODEX_HOME
  // (_seed_codex_auth, oracle d9ccf4e). Reads the host's ~/.codex/auth.json,
  // asserts it is subscription auth (auth_mode === 'chatgpt' and no API key)
  // carrying a refresh token, then writes it to configDir/auth.json at 0600
  // through an O_NOFOLLOW-protected open. The parsed JSON is unknown until
  // narrowed by CodexAuthSchema (standard §4.1).
  private seedCodexAuth(configDir: string): void {
    // Host subscription auth lives at ~/.codex/auth.json (Python: Path.home() /
    // ".codex"). CODEX_AUTH_HOME overrides the parent dir so the hermetic gate
    // can point it at a temp dir — the same seam the gemini adapter uses for
    // GEMINI_OAUTH_HOME, since homedir() ignores a mid-process $HOME change.
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

    // Subscription auth only: auth_mode 'chatgpt' AND no embedded API key
    // (mirrors `auth.get("auth_mode") != "chatgpt" or auth.get("OPENAI_API_KEY")
    // is not None`).
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
    // auth to an attacker-controlled path (mirrors the O_NOFOLLOW posture on
    // every Python secret write). Re-read the source bytes (the earlier read was
    // text for JSON validation) and write them verbatim at mode 0600.
    mkdirSync(configDir, { recursive: true });
    const dest = join(configDir, 'auth.json');
    writePrivateFileNoFollow(dest, readFileSync(source));
  }

  // Port of install_codex_superpowers_plugin_hooks for the quorum-owned
  // CODEX_HOME (already created + logged in): copy Superpowers into the plugin
  // cache, write the plugin-hooks config, read the staged hook via app-server,
  // and append its trusted_hash. No isolated-home build / login / DRILL export
  // (that is the drill-owned path, which quorum never takes).
  private installPluginHooks(
    configDir: string,
    workdir: string,
    superpowersRoot: string,
  ): void {
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

    // Fail-fast self-copy guard: when the eval out-root is INSIDE
    // SUPERPOWERS_ROOT, pluginRoot (dest) is a subdirectory of the copy source,
    // and cpSync dies with a cryptic "cannot copy X to a subdirectory of self".
    // Surface a clear, actionable error before the copy instead.
    if (isUnderDir(pluginRoot, superpowersRoot)) {
      throw new ProvisionError(
        `Codex plugin copy would recurse into itself: the eval out-root resolves under SUPERPOWERS_ROOT (${superpowersRoot}). Pass --out-root pointing OUTSIDE SUPERPOWERS_ROOT.`,
      );
    }

    mkdirSync(dirname(pluginRoot), { recursive: true });
    cpSync(superpowersRoot, pluginRoot, {
      recursive: true,
      filter: (src: string) => !isCodexPluginCopyExcluded(src, superpowersRoot),
    });

    const configPath = join(configDir, 'config.toml');
    writePluginHooksConfig(configPath);

    // Read the staged Superpowers SessionStart hook through the BOUNDED
    // app-server seam (per-handshake deadline), so a hung app-server cannot
    // block provisioning forever (mirrors worktree.py's 15s selector deadline).
    const hook = this.appServer.readHook({
      configDir,
      workdir,
      timeoutMs: APP_SERVER_TIMEOUT_MS,
    });
    appendTrustedHook(configPath, hook.key, hook.currentHash);
  }
}

// node:path basename without a default-export import (verbatimModuleSyntax).
function basename(p: string): string {
  const parts = p.split('/');
  const last = parts[parts.length - 1];
  return last ?? p;
}

// Mirrors _write_codex_plugin_hooks_config: enable plugins/hooks and the
// superpowers@debug plugin. Trailing block is appended later by
// appendTrustedHook (mirrors _append_codex_trusted_hook).
function writePluginHooksConfig(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    [
      '[features]',
      'plugins = true',
      'hooks = true',
      'plugin_hooks = true',
      '',
      '[plugins."superpowers@debug"]',
      'enabled = true',
      '',
    ].join('\n'),
  );
}

// Append `[hooks.state."<key>"]\ntrusted_hash = "<hash>"` to config.toml,
// TOML-escaping both values (mirrors _append_codex_trusted_hook +
// _toml_basic_string).
function appendTrustedHook(
  configPath: string,
  key: string,
  currentHash: string,
): void {
  const existing = readFileSync(configPath, 'utf8');
  const block = [
    '',
    `[hooks.state."${tomlBasicString(key)}"]`,
    `trusted_hash = "${tomlBasicString(currentHash)}"`,
    '',
  ].join('\n');
  writeFileSync(configPath, existing + block);
}

function tomlBasicString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

// The O_NOFOLLOW private-file writer now lives in ./private-file.ts so every
// per-run env/credential writer (gemini, claude, copilot) shares one
// implementation. Re-exported here to preserve codex.ts's public surface (its
// importers, incl. the codex agent tests, still resolve it through this module).
export { writePrivateFileNoFollow };
