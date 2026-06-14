// Synchronous, timed JSON-RPC client for `codex app-server --listen stdio://`,
// used by CodexAgent provisioning to read the staged Superpowers SessionStart
// hook's key + currentHash. Mirrors setup_helpers/worktree.py's
// _read_codex_superpowers_hook + _read_codex_app_server_response (15s deadline)
// + _select_codex_superpowers_hook + _terminate_codex_app_server.
//
// provision() is synchronous (it returns an env map), so this client is too:
// it pipes the initialize (id 1) + hooks/list (id 2) requests as one stdin
// payload and scans the collected stdout for the id-2 response. The Python
// drives a persistent process with a per-read selector deadline; the synchronous
// model can't interleave reads, but it MUST still be bounded — without a
// deadline a non-flushing app-server blocks provisioning forever. So the spawn
// seam carries a `timeout`, and a timed-out spawn surfaces the same diagnostic
// the Python deadline path raises (with the captured stderr for triage).
//
// The spawn is injected (AppServerSpawn) so the hermetic gate stubs it; live
// runs use SpawnAppServerClient's default spawnSync-backed spawn.
import { spawnSync } from 'node:child_process';
import { envSnapshot } from '../env.ts';
import { ProvisionError } from './index.ts';

const PLUGIN_ID = 'superpowers@debug';

// Default per-handshake deadline, matching worktree.py's 15s selector deadline.
export const APP_SERVER_TIMEOUT_MS = 15_000;

export interface AppServerHook {
  readonly key: string;
  readonly currentHash: string;
}

export interface ReadHookArgs {
  readonly configDir: string;
  readonly workdir: string;
  readonly timeoutMs: number;
}

// The reads-the-hook contract CodexAgent depends on. Injected so provisioning
// tests supply a fake instead of spawning the real codex CLI.
export interface AppServerClient {
  readHook(args: ReadHookArgs): AppServerHook;
}

// Result shape of a single bounded app-server spawn. `timedOut` is true when the
// deadline tripped (spawnSync killed the child); status is then null.
export interface AppServerSpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface AppServerSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly input: string;
  readonly timeout: number;
}

// Injectable bounded-spawn seam. The real impl is spawnSync with a `timeout`;
// the gate injects a fake that returns canned stdout (or a timeout).
export type AppServerSpawn = (
  command: string,
  args: readonly string[],
  options: AppServerSpawnOptions,
) => AppServerSpawnResult;

// Real bounded spawn: spawnSync with the deadline forwarded as `timeout`, so a
// non-flushing/hung app-server is killed instead of blocking provisioning.
// spawnSync reports a deadline kill via `error.code === 'ETIMEDOUT'` (or, on
// some platforms, a null status with a signal); both map to timedOut.
const defaultSpawn: AppServerSpawn = (command, args, options) => {
  const proc = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    input: options.input,
    timeout: options.timeout,
    encoding: 'utf8',
  });
  const timedOut =
    (proc.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
    (proc.status === null && proc.signal !== null);
  return {
    status: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    timedOut,
  };
};

export class SpawnAppServerClient implements AppServerClient {
  private readonly spawn: AppServerSpawn;

  constructor(spawn: AppServerSpawn = defaultSpawn) {
    this.spawn = spawn;
  }

  readHook(args: ReadHookArgs): AppServerHook {
    const { configDir, workdir, timeoutMs } = args;
    const input = buildHandshakeInput(workdir);
    const result = this.spawn('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: workdir,
      env: { ...envSnapshot(), CODEX_HOME: configDir },
      input,
      timeout: timeoutMs,
    });

    if (result.timedOut) {
      const detail = result.stderr.trim();
      throw new ProvisionError(
        `Timed out waiting for Codex app-server response${detail === '' ? '' : `: ${detail}`}`,
      );
    }
    if (result.status !== 0) {
      throw new ProvisionError(
        `codex app-server failed (exit ${result.status}): ${result.stderr.trim()}`,
      );
    }

    const response = parseAppServerResponse(result.stdout, 2);
    return selectSuperpowersHook(response);
  }
}

// The compact JSON-RPC requests piped to `codex app-server` stdin: initialize
// (id 1) then hooks/list (id 2) for the run's workdir. Mirrors
// _read_codex_superpowers_hook's two requests.
function buildHandshakeInput(workdir: string): string {
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
  return `${JSON.stringify(initialize)}\n${JSON.stringify(hooksList)}\n`;
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
// _read_codex_app_server_response's id-match + error branch).
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
