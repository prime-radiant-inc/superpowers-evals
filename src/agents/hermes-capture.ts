// Hermes session capture/export from isolated per-run state.
//
// Verified live (container probe of the real hermes CLI, Task 5):
//   - Hermes sessions are NOT files. They live in a SQLite store at
//     ~/.hermes/state.db; ~/.hermes/sessions/ is never created.
//   - `hermes sessions list` is a plain table (no --format json). The last
//     whitespace-separated token on a data row is the session id, shaped
//     \d{8}_\d{6}_[0-9a-f]+ (e.g. 20260723_212658_b572cd). Header/separator
//     rows never match that shape, so parsing is defensive by construction.
//   - `hermes sessions export --format jsonl --session-id <id> -` writes one
//     JSON object for that session to stdout (the trailing `-` selects
//     stdout; omitting an output path is a CLI error).
//
// snapshotHermesSessions records the existing session ids before a run;
// exportHermesSessions runs `hermes sessions list` again after the run, diffs
// against the snapshot, and exports each new session id to
// `<exportDir>/<id>.json` plus an export manifest. The runner wires these
// around the gauntlet drive; this module is the building block — mirrors the
// architecture of ../agents/opencode-capture.ts, adapted to the real (table +
// SQLite-backed) hermes CLI surface rather than opencode's JSON session store.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envSnapshot } from '../env.ts';
import { xdgHomeEnv } from './home-env.ts';

export class HermesCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesCaptureError';
  }
}

// Thrown when a hermes subprocess is killed by its timeout. Bun.spawnSync does
// NOT throw on timeout — it kills the child and returns { exitCode: null,
// signalCode: 'SIGTERM' }. defaultSpawn detects that and raises this so the
// isTimeoutError branch surfaces a timed-out diagnostic instead of silently
// parsing empty stdout as a success (same M1-opencode-timeout-swallowed-as-
// success failure mode opencode-capture.ts guards against).
export class HermesTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesTimeoutError';
  }
}

// The XDG-isolation env the hermes subprocess receives. HOME and every XDG
// root live under hermesHome — the SAME run home the launcher pins via
// `$QUORUM_HOME_ENV`, so the agent run and its capture subprocess agree on the
// isolated home. No extra config-dir override is needed (unlike opencode):
// Hermes defaults HERMES_HOME to $HOME/.hermes, and the launcher deliberately
// omits HERMES_HOME so both the launched agent and this capture subprocess
// resolve the same store purely from HOME.
export function hermesEnv(hermesHome: string): Record<string, string> {
  return { ...xdgHomeEnv(hermesHome) };
}

// The fixed set of host env vars a hermes subprocess may inherit. Everything
// else (proxy vars, other harness vars) is scrubbed so the subprocess exercises
// the pinned provider, not ambient host state.
export const HERMES_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'TERM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

// 90s: `hermes sessions list` / `sessions export` share the same headroom
// rationale opencode-capture.ts established for its capture calls under high
// run-all concurrency (docs/experiments/2026-06-23-glm-5.2-full-suite-benchmark.md).
// No hermes-specific incident has surfaced yet; kept consistent pending one.
export const HERMES_CAPTURE_TIMEOUT_MS = 90_000;

// Filter the host env to the allowlist, default PATH/TERM/LANG (PATH falls back
// to the POSIX default "/bin:/usr/bin"), then overlay the XDG isolation vars.
export function hermesRunEnv(hermesHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envSnapshot())) {
    if (HERMES_ENV_ALLOWLIST.has(key) && value !== undefined) {
      env[key] = value;
    }
  }
  if (!('PATH' in env)) env['PATH'] = '/bin:/usr/bin';
  if (!('TERM' in env)) env['TERM'] = 'xterm-256color';
  if (!('LANG' in env)) env['LANG'] = 'C.UTF-8';
  Object.assign(env, hermesEnv(hermesHome));
  return env;
}

export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

// Injectable subprocess seam. Tests pass a fake; live runs use defaultSpawn.
export type SpawnFn = (opts: {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}) => SpawnResult;

// Pure decision: map a raw spawn result to an outcome. Bun.spawnSync returns
// exitCode === null with a SIGTERM signalCode when the child was killed (the
// timeout fired); a clean exit reports a numeric exitCode and a null/undefined
// signalCode. A killed child (null exit, or any signal present) MUST be treated
// as a timeout, never coerced to exit 0. A clean exit 0 is success; any other
// exit is a failure. (Same pure mapping as opencode-capture.ts's spawnOutcome —
// duplicated rather than imported so hermes-capture has no dependency on the
// opencode module.)
export function spawnOutcome(result: {
  exitCode: number | null;
  signalCode?: string | null;
}): 'success' | 'failure' | 'timeout' {
  if (result.exitCode === null || (result.signalCode ?? null) !== null) {
    return 'timeout';
  }
  return result.exitCode === 0 ? 'success' : 'failure';
}

// A regular-file stdout drains synchronously even when a binary ends with a
// bare process.exit() that would truncate a piped payload at the pipe-buffer
// boundary. Applied defensively here too (not yet confirmed necessary for the
// hermes CLI, but harmless and matches opencode-capture.ts's defense).
export function defaultSpawn(opts: {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}): SpawnResult {
  const { args, cwd, env, timeoutMs } = opts;
  const tmpFile = join(
    tmpdir(),
    `hermes-stdout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tmpFile, '');
  try {
    const stdoutFd = openSync(tmpFile, 'r+');
    try {
      const proc = Bun.spawnSync(args, {
        cwd,
        env,
        stdin: 'ignore',
        stdout: stdoutFd,
        stderr: 'pipe',
        timeout: timeoutMs,
      });
      if (spawnOutcome(proc) === 'timeout') {
        throw new HermesTimeoutError(
          `hermes ${args.slice(1).join(' ')} timed out after ${timeoutMs / 1000}s`,
        );
      }
      const stdout = readFileSync(tmpFile, 'utf8');
      const stderr =
        proc.stderr instanceof Uint8Array
          ? new TextDecoder().decode(proc.stderr)
          : '';
      return { stdout, stderr, exitCode: proc.exitCode ?? 0 };
    } finally {
      closeSync(stdoutFd);
    }
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }
}

export function runHermesCommand(
  args: string[],
  opts: {
    hermesHome: string;
    launchCwd: string;
    timeoutMs?: number;
    spawn?: SpawnFn;
  },
): SpawnResult {
  const spawn = opts.spawn ?? defaultSpawn;
  return spawn({
    args: ['hermes', ...args],
    cwd: opts.launchCwd,
    env: hermesRunEnv(opts.hermesHome),
    timeoutMs: opts.timeoutMs ?? HERMES_CAPTURE_TIMEOUT_MS,
  });
}

function isTimeoutError(e: unknown): boolean {
  return (
    e instanceof HermesTimeoutError ||
    (e instanceof Error &&
      (e.message.toLowerCase().includes('timeout') ||
        e.message.toLowerCase().includes('timed out') ||
        e.constructor.name === 'TimeoutError'))
  );
}

// A hermes session id: 8-digit date, 6-digit time, hex suffix
// (e.g. 20260723_212658_b572cd). Verified live shape.
const HERMES_SESSION_ID_RE = /^\d{8}_\d{6}_[0-9a-f]+$/;

// Parse session ids out of `hermes sessions list`'s plain-text table
// defensively: per line, take the LAST whitespace-separated token (the id is
// the table's last column) and keep it only if it matches the verified id
// shape. Header rows, separator rules, and "(no sessions found)"-style lines
// never produce a token in that shape, so they are skipped without needing to
// know the table's column layout.
export function parseHermesSessionIds(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const last = tokens[tokens.length - 1];
    if (last !== undefined && HERMES_SESSION_ID_RE.test(last)) {
      ids.push(last);
    }
  }
  return ids;
}

function listHermesSessions(opts: {
  hermesHome: string;
  launchCwd: string;
  spawn?: SpawnFn;
}): string[] {
  let result: SpawnResult;
  try {
    result = runHermesCommand(['sessions', 'list'], {
      hermesHome: opts.hermesHome,
      launchCwd: opts.launchCwd,
      ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      throw new HermesCaptureError(
        `hermes sessions list timed out after ${HERMES_CAPTURE_TIMEOUT_MS / 1000}s`,
      );
    }
    throw e;
  }
  if (result.exitCode !== 0) {
    throw new HermesCaptureError(
      `hermes sessions list failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`,
    );
  }
  return parseHermesSessionIds(result.stdout);
}

export function snapshotHermesSessions(opts: {
  home: string;
  launchCwd: string;
  spawn?: SpawnFn;
}): Set<string> {
  const ids = listHermesSessions({
    hermesHome: opts.home,
    launchCwd: opts.launchCwd,
    ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
  });
  return new Set(ids);
}

function exportSession(opts: {
  sessionId: string;
  hermesHome: string;
  launchCwd: string;
  spawn?: SpawnFn;
}): [Record<string, unknown>, string, string] {
  let result: SpawnResult;
  try {
    result = runHermesCommand(
      [
        'sessions',
        'export',
        '--format',
        'jsonl',
        '--session-id',
        opts.sessionId,
        '-',
      ],
      {
        hermesHome: opts.hermesHome,
        launchCwd: opts.launchCwd,
        ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
      },
    );
  } catch (e) {
    if (isTimeoutError(e)) {
      throw new HermesCaptureError(
        `hermes sessions export ${opts.sessionId} timed out after ${HERMES_CAPTURE_TIMEOUT_MS / 1000}s`,
      );
    }
    throw e;
  }
  if (result.exitCode !== 0) {
    throw new HermesCaptureError(
      `hermes sessions export ${opts.sessionId} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`,
    );
  }
  let exportedJson: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('non-object JSON');
    }
    exportedJson = parsed as Record<string, unknown>;
  } catch {
    const byteLen = new TextEncoder().encode(result.stdout).length;
    throw new HermesCaptureError(
      `hermes sessions export ${opts.sessionId} returned invalid JSON ` +
        `(${byteLen} bytes; ` +
        `head: ${JSON.stringify(result.stdout.slice(0, 120))}; ` +
        `stderr: ${result.stderr.trim().slice(0, 300)})`,
    );
  }
  const exportedId = exportedJson['id'];
  if (exportedId !== opts.sessionId) {
    throw new HermesCaptureError(
      `hermes sessions export ${opts.sessionId} returned session id ${JSON.stringify(exportedId)}`,
    );
  }
  return [exportedJson, result.stdout, result.stderr];
}

interface ExportRecord {
  id: string;
  stdout: string;
  stderr: string;
}

export function exportHermesSessions(opts: {
  hermesHome: string;
  exportDir: string;
  launchCwd: string;
  snapshot: Set<string>;
  spawn?: SpawnFn;
}): string[] {
  const { hermesHome, exportDir, launchCwd, snapshot, spawn } = opts;
  mkdirSync(exportDir, { recursive: true });

  const ids = listHermesSessions({
    hermesHome,
    launchCwd,
    ...(spawn !== undefined ? { spawn } : {}),
  });
  // Session ids embed a sortable date_time_hex prefix, so a lexical sort is
  // already chronological order — no separate creation-time lookup needed
  // (unlike opencode, whose ids carry no ordering information of their own).
  const newIds = ids.filter((id) => !snapshot.has(id)).sort();

  const exportRecords: ExportRecord[] = [];
  for (const sessionId of newIds) {
    const [, stdout, stderr] = exportSession({
      sessionId,
      hermesHome,
      launchCwd,
      ...(spawn !== undefined ? { spawn } : {}),
    });
    exportRecords.push({ id: sessionId, stdout, stderr });
  }

  const exported: string[] = [];
  const manifest: Record<string, unknown> = {
    all_ids: ids,
    snapshot_ids: [...snapshot].sort(),
    matched_ids: newIds,
    skipped_existing_ids: ids.filter((id) => snapshot.has(id)),
    exports: [] as unknown[],
  };

  for (const record of exportRecords) {
    const outPath = join(exportDir, `${record.id}.json`);
    writeFileSync(outPath, record.stdout);
    (manifest['exports'] as unknown[]).push({
      id: record.id,
      path: outPath,
      stderr: record.stderr,
    });
    exported.push(outPath);
  }

  writeFileSync(
    join(exportDir, 'hermes-session-export-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return exported;
}
