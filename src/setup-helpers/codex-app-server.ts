// Async JSON-RPC client over `codex app-server --listen stdio://`.
//
// The handshake is STRICTLY interleaved: send initialize (id 1), await its
// response, THEN send hooks/list (id 2) and await that. We do not pipeline both
// writes — the app-server may require the initialize ack before accepting
// hooks/list. Reads drain stdout (and collect stderr for error detail)
// line-by-line under a 15s deadline, matching by id.
import { envSnapshot } from '../env.ts';

const PLUGIN_ID = 'superpowers@debug';
const RESPONSE_TIMEOUT_MS = 15_000;
const TERMINATE_GRACE_MS = 3_000;

export interface CodexSessionStartHook {
  readonly key: string;
  readonly currentHash: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The pipe-stream type Bun.spawn hands us for a 'pipe' stdout/stderr, and the
// reader it yields. Deriving from Bun.spawn (rather than naming the global
// ReadableStream) avoids the node:stream/web vs Bun reader clash — Bun's reader
// carries an extra readMany method and a non-overloaded read().
type SpawnedProcess = ReturnType<typeof Bun.spawn>;
// proc.stdout/stderr are a union (ReadableStream when 'pipe', else a fd number /
// undefined). Pick the ReadableStream member structurally — by its getReader
// method — rather than naming the global ReadableStream (which would re-import
// the node:stream/web overloads and the reader-type clash).
type PipeStream = Extract<SpawnedProcess['stdout'], { getReader: unknown }>;

// A small line buffer over the spawned process's stdout/stderr pipe: pulls
// chunks, splits on '\n', and yields complete lines. Holds a trailing partial
// line until the next chunk completes it.
//
// The reader field is intentionally NOT given an explicit type: getReader is
// overloaded (default vs BYOB), and a type-level ReturnType<...['getReader']>
// picks the BYOB overload, whose read() demands a view argument. Letting the
// field type be inferred from the value-level no-arg getReader() call resolves
// the DEFAULT reader (no-arg read()).
class LineReader {
  private readonly reader;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private done = false;
  private readonly pending: string[] = [];

  constructor(stream: PipeStream) {
    this.reader = stream.getReader();
  }

  // Read the next complete line, or undefined when the stream ends with no more
  // buffered lines. Pulls from the underlying stream as needed.
  async nextLine(): Promise<string | undefined> {
    while (true) {
      const queued = this.pending.shift();
      if (queued !== undefined) {
        return queued;
      }
      if (this.done) {
        if (this.buffer.length > 0) {
          const last = this.buffer;
          this.buffer = '';
          return last;
        }
        return undefined;
      }
      const chunk = await this.reader.read();
      if (chunk.done) {
        this.done = true;
        continue;
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      let newlineIndex = this.buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        this.pending.push(this.buffer.slice(0, newlineIndex + 1));
        this.buffer = this.buffer.slice(newlineIndex + 1);
        newlineIndex = this.buffer.indexOf('\n');
      }
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

function compactRequest(request: Record<string, unknown>): string {
  return `${JSON.stringify(request)}\n`;
}

// Drain stdout lines until one with the requested id arrives (raising on a
// JSON-RPC `error` member), collecting stderr lines for the timeout detail.
// Rejects on the 15s deadline.
async function readResponse(
  stdout: LineReader,
  stderrLines: string[],
  requestId: number,
): Promise<HooksListResponse> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const line = await withTimeout(stdout.nextLine(), remaining);
    if (line === TIMED_OUT) {
      break;
    }
    if (line === undefined) {
      break;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(message)) {
      continue;
    }
    if (message['id'] !== requestId) {
      continue;
    }
    if ('error' in message) {
      throw new Error(
        `Codex app-server request failed: ${JSON.stringify(message['error'])}`,
      );
    }
    return message as HooksListResponse;
  }
  const stderr = stderrLines.join('').trim();
  const detail = stderr === '' ? '' : `: ${stderr}`;
  throw new Error(
    `Timed out waiting for Codex app-server response ${requestId}${detail}`,
  );
}

const TIMED_OUT = Symbol('timed-out');

// Race a promise against a deadline; resolves to TIMED_OUT when the timer wins.
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) {
    return Promise.resolve(TIMED_OUT);
  }
  return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// Drain all stderr lines into the shared buffer in the background; ignore
// errors (the process may be killed).
async function drainStderr(reader: LineReader, sink: string[]): Promise<void> {
  try {
    while (true) {
      const line = await reader.nextLine();
      if (line === undefined) {
        return;
      }
      sink.push(line);
    }
  } catch {
    // Stream closed/cancelled on terminate; nothing to do.
  }
}

// SIGTERM, wait up to 3s, then SIGKILL.
async function terminate(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  proc.kill('SIGTERM');
  const exited = await withTimeout(proc.exited, TERMINATE_GRACE_MS);
  if (exited === TIMED_OUT) {
    proc.kill('SIGKILL');
    await proc.exited;
  }
}

// Selects exactly one superpowers@debug plugin SessionStart hook, firing on
// `startup`, dispatched through run-hook.cmd, with a known trust status and a
// non-empty key + currentHash.
function selectSuperpowersHook(
  response: HooksListResponse,
): CodexSessionStartHook {
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
    throw new Error(
      `Expected one Superpowers Codex SessionStart hook, found ${hooks.length}`,
    );
  }
  const hook = hooks[0];
  if (hook === undefined) {
    throw new Error('Superpowers Codex hook unexpectedly absent');
  }

  const matcher = hook.matcher ?? '';
  if (!matcher.split('|').includes('startup')) {
    throw new Error(
      `Superpowers Codex hook does not fire on session startup (matcher: ${JSON.stringify(matcher)})`,
    );
  }
  const command = hook.command ?? '';
  if (!command.includes('run-hook.cmd')) {
    throw new Error(
      `Unexpected Superpowers Codex hook command (expected a run-hook.cmd invocation): ${command}`,
    );
  }
  if (hook.trustStatus !== 'untrusted' && hook.trustStatus !== 'trusted') {
    throw new Error(
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
    throw new Error('Superpowers Codex hook is missing key or currentHash');
  }
  return { key, currentHash };
}

export interface QueryCodexHookArgs {
  readonly codexHome: string;
  readonly workdir: string;
}

// Spawn `codex app-server --listen stdio://` (CODEX_HOME=codexHome, cwd=workdir)
// and read the staged Superpowers SessionStart hook's key + currentHash. The
// handshake is interleaved (initialize ack before hooks/list). Always
// terminates the child in a finally.
export async function queryCodexSessionStartHook(
  args: QueryCodexHookArgs,
): Promise<CodexSessionStartHook> {
  const proc = Bun.spawn(['codex', 'app-server', '--listen', 'stdio://'], {
    cwd: args.workdir,
    env: { ...envSnapshot(), CODEX_HOME: args.codexHome },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = new LineReader(proc.stdout);
  const stderr = new LineReader(proc.stderr);
  const stderrLines: string[] = [];
  const stderrPump = drainStderr(stderr, stderrLines);

  try {
    const stdin = proc.stdin;
    const initialize = compactRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'drill', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      },
    });
    stdin.write(initialize);
    await stdin.flush();
    await readResponse(stdout, stderrLines, 1);

    const hooksList = compactRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'hooks/list',
      params: { cwds: [args.workdir] },
    });
    stdin.write(hooksList);
    await stdin.flush();
    const response = await readResponse(stdout, stderrLines, 2);
    return selectSuperpowersHook(response);
  } finally {
    await terminate(proc);
    await stdout.cancel();
    await stderr.cancel();
    await stderrPump.catch(() => {});
  }
}
