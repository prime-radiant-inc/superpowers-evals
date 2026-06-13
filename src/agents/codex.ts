import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';

// Codex-family provisioning. Ports quorum/runner.py:_seed_codex_auth +
// _seed_codex_plugin_hooks (which delegates to
// setup_helpers.worktree.install_codex_superpowers_plugin_hooks for the
// quorum-owned, already-logged-in CODEX_HOME path). provision() is SETUP ONLY:
// it seeds the per-run CODEX_HOME so the agent boots past the sign-in picker
// with Superpowers staged as a trusted SessionStart plugin hook.
//
// The Python ceremony has two subprocess interactions, both driven through the
// injected CommandRunner so the hermetic gate stubs them:
//   1. `codex login --with-api-key` (OPENAI_API_KEY piped to stdin) -> auth.json
//   2. `codex app-server --listen stdio://` JSON-RPC (initialize + hooks/list)
//      to read the staged Superpowers hook's key + currentHash, which we then
//      record as a trusted_hash in config.toml.
// Everything else (skeleton copy, plugin copytree, config.toml) is deterministic
// file generation, which the gate asserts directly.

// The compact JSON-RPC requests piped to `codex app-server` stdin: initialize
// (id 1) then hooks/list (id 2) for the run's workdir. Mirrors
// _read_codex_superpowers_hook in setup_helpers/worktree.py.
interface AppServerHook {
  readonly key: string;
  readonly currentHash: string;
}

const PLUGIN_ID = 'superpowers@debug';

// Dirs under SUPERPOWERS_ROOT that the Python copytree ignores when staging the
// plugin (mirrors _ignore_codex_plugin_copy). `results` is dropped only inside
// the `evals` submodule; cpSync has no per-dir filter hook, so we filter the
// always-ignored set globally and additionally always drop `results` — the
// staged plugin never needs run artifacts. This matches intent (never stage
// transcripts) without porting the path-sensitive special case.
const PLUGIN_COPY_IGNORE = new Set<string>([
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.ty',
  '.venv',
  '__pycache__',
  'node_modules',
  'results',
]);

export class CodexAgent implements CodingAgent {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  provision(home: RunHome, runner: CommandRunner): Record<string, string> {
    const { configDir, workdir, skeletonRoot } = home;
    const family = this.config.runtime_family ?? 'codex';

    const apiKey = getEnv('OPENAI_API_KEY');
    if (apiKey === undefined || apiKey === '') {
      throw new ProvisionError(
        'OPENAI_API_KEY not set; cannot seed codex auth',
      );
    }
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

    // 1. Auth ceremony: pipe the key to `codex login --with-api-key` against the
    //    fresh CODEX_HOME so it writes a logged-in auth.json (_seed_codex_auth).
    const loginResult = runner.run('codex', ['login', '--with-api-key'], {
      input: apiKey,
      env: { ...envSnapshot(), CODEX_HOME: configDir },
    });
    if (loginResult.status !== 0) {
      throw new ProvisionError(
        `codex login --with-api-key failed (exit ${loginResult.status}): ${loginResult.stderr.trim()}`,
      );
    }

    // 2. Stage Superpowers as a trusted Codex plugin hook
    //    (install_codex_superpowers_plugin_hooks, quorum/codex_home path).
    this.installPluginHooks(configDir, workdir, superpowersRoot, runner);

    return { [this.config.agent_config_env]: configDir };
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
    runner: CommandRunner,
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
    mkdirSync(dirname(pluginRoot), { recursive: true });
    cpSync(superpowersRoot, pluginRoot, {
      recursive: true,
      filter: (src: string) => !PLUGIN_COPY_IGNORE.has(basename(src)),
    });

    const configPath = join(configDir, 'config.toml');
    writePluginHooksConfig(configPath);

    const hook = this.readSuperpowersHook(configDir, workdir, runner);
    appendTrustedHook(configPath, hook.key, hook.currentHash);
  }

  // Drive `codex app-server --listen stdio://` through the runner seam to read
  // the staged Superpowers SessionStart hook's key + currentHash. The Python
  // streams two JSON-RPC requests over a persistent stdio process; the
  // synchronous CommandRunner models this as a single run whose `input` carries
  // both newline-delimited requests and whose stdout we scan for the hooks/list
  // (id 2) response. Live runs use the real spawn; the gate stubs stdout.
  private readSuperpowersHook(
    configDir: string,
    workdir: string,
    runner: CommandRunner,
  ): AppServerHook {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'quorum', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      },
    };
    const hooksList = {
      jsonrpc: '2.0',
      id: 2,
      method: 'hooks/list',
      params: { cwds: [workdir] },
    };
    const input = `${JSON.stringify(initialize)}\n${JSON.stringify(hooksList)}\n`;

    const result = runner.run('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: workdir,
      env: { ...envSnapshot(), CODEX_HOME: configDir },
      input,
    });
    if (result.status !== 0) {
      throw new ProvisionError(
        `codex app-server failed (exit ${result.status}): ${result.stderr.trim()}`,
      );
    }

    const response = parseAppServerResponse(result.stdout, 2);
    return selectSuperpowersHook(response);
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

interface HookEntry {
  readonly pluginId?: string;
  readonly source?: string;
  readonly eventName?: string;
  readonly matcher?: string;
  readonly command?: string;
  readonly trustStatus?: string;
  readonly key?: string;
  readonly currentHash?: string;
}

interface HooksListData {
  readonly hooks?: readonly HookEntry[];
}

interface HooksListResponse {
  readonly result?: { readonly data?: readonly HooksListData[] };
}

// Scan newline-delimited JSON-RPC lines for the response with the given id,
// surfacing an `error` member as a ProvisionError (mirrors
// _read_codex_app_server_response, minus the live timeout/selector loop).
function parseAppServerResponse(
  stdout: string,
  requestId: number,
): HooksListResponse {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(message)) continue;
    if (message['id'] !== requestId) continue;
    if ('error' in message) {
      throw new ProvisionError(
        `codex app-server request failed: ${JSON.stringify(message['error'])}`,
      );
    }
    return message as HooksListResponse;
  }
  throw new ProvisionError(
    `codex app-server returned no response for request ${requestId}`,
  );
}

// Mirrors _select_codex_superpowers_hook: exactly one superpowers@debug plugin
// SessionStart hook, firing on `startup`, dispatched through run-hook.cmd, with
// a known trust status and a key + currentHash.
function selectSuperpowersHook(response: HooksListResponse): AppServerHook {
  const data = response.result?.data ?? [];
  const hooks: HookEntry[] = [];
  for (const entry of data) {
    for (const hook of entry.hooks ?? []) {
      if (
        hook.pluginId === PLUGIN_ID &&
        hook.source === 'plugin' &&
        hook.eventName === 'sessionStart'
      ) {
        hooks.push(hook);
      }
    }
  }
  if (hooks.length !== 1) {
    throw new ProvisionError(
      `Expected one Superpowers Codex SessionStart hook, found ${hooks.length}`,
    );
  }
  const hook = hooks[0];
  if (hook === undefined) {
    throw new ProvisionError('Superpowers Codex hook unexpectedly absent');
  }

  const matcher = hook.matcher ?? '';
  if (!matcher.split('|').includes('startup')) {
    throw new ProvisionError(
      `Superpowers Codex hook does not fire on session startup (matcher: ${JSON.stringify(matcher)})`,
    );
  }
  const command = hook.command ?? '';
  if (!command.includes('run-hook.cmd')) {
    throw new ProvisionError(
      `Unexpected Superpowers Codex hook command (expected a run-hook.cmd invocation): ${command}`,
    );
  }
  if (hook.trustStatus !== 'untrusted' && hook.trustStatus !== 'trusted') {
    throw new ProvisionError(
      `Unexpected Superpowers Codex hook trust status: ${hook.trustStatus}`,
    );
  }
  const key = hook.key;
  const currentHash = hook.currentHash;
  if (
    key === undefined ||
    key === '' ||
    currentHash === undefined ||
    currentHash === ''
  ) {
    throw new ProvisionError(
      'Superpowers Codex hook is missing key or currentHash',
    );
  }
  return { key, currentHash };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
