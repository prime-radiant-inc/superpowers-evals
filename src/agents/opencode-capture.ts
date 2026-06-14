// OpenCode session capture/export from isolated per-run state.
//
// Port of quorum/opencode_capture.py. OpenCode does not write capturable session
// logs to disk on its own: snapshotOpencodeSessions records the existing session
// ids before a run, then exportOpencodeSessions runs `opencode export <id>` per
// new session and writes `<created>-<id>.json` files plus an export manifest into
// the per-run export dir. The runner (Wave 2b) wires these around the gauntlet
// drive; this module is the building block.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { envSnapshot } from '../env.ts';

export class OpenCodeCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeCaptureError';
  }
}

// quorum/opencode_capture.py:opencode_env — the XDG-isolation env the OpenCode
// subprocess receives. HOME and every XDG root live under opencodeHome.
export function opencodeEnv(opencodeHome: string): Record<string, string> {
  return {
    HOME: opencodeHome,
    XDG_CONFIG_HOME: join(opencodeHome, '.config'),
    XDG_DATA_HOME: join(opencodeHome, '.local', 'share'),
    XDG_STATE_HOME: join(opencodeHome, '.local', 'state'),
    XDG_CACHE_HOME: join(opencodeHome, '.cache'),
    TMPDIR: join(opencodeHome, '.tmp'),
    OPENCODE_CONFIG_DIR: join(opencodeHome, '.config', 'opencode'),
  };
}

// quorum/opencode_capture.py:OPENCODE_ENV_ALLOWLIST — the fixed set of host env
// vars an opencode subprocess may inherit. Everything else (proxy vars, ambient
// OPENCODE_CONFIG_DIR, other harness vars) is scrubbed so the subprocess exercises
// the pinned provider, not opencode's ambient-key auto-selection.
export const OPENCODE_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
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

export const OPENCODE_CAPTURE_TIMEOUT_MS = 30_000;

// quorum/opencode_capture.py:opencode_run_env — filter os.environ to the
// allowlist, setdefault PATH/TERM/LANG (POSIX os.defpath = "/bin:/usr/bin"),
// then overlay the XDG isolation vars.
export function opencodeRunEnv(opencodeHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envSnapshot())) {
    if (OPENCODE_ENV_ALLOWLIST.has(key) && value !== undefined) {
      env[key] = value;
    }
  }
  if (!('PATH' in env)) env['PATH'] = '/bin:/usr/bin';
  if (!('TERM' in env)) env['TERM'] = 'xterm-256color';
  if (!('LANG' in env)) env['LANG'] = 'C.UTF-8';
  Object.assign(env, opencodeEnv(opencodeHome));
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

// quorum/opencode_capture.py:run_opencode_command docstring — the opencode binary
// ends every command with a bare process.exit(), which discards stdout that has
// not yet drained. Through a pipe, payloads >64KiB arrive truncated at the
// pipe-buffer boundary (still exit 0) and tiny replies can vanish under load. A
// regular-file stdout drains synchronously, so the payload survives. stderr stays
// piped (always small).
export function defaultSpawn(opts: {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}): SpawnResult {
  const { args, cwd, env, timeoutMs } = opts;
  const tmpFile = join(
    tmpdir(),
    `opencode-stdout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
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

export function runOpencodeCommand(
  args: string[],
  opts: {
    opencodeHome: string;
    launchCwd: string;
    timeoutMs?: number;
    spawn?: SpawnFn;
  },
): SpawnResult {
  const spawn = opts.spawn ?? defaultSpawn;
  return spawn({
    args: ['opencode', ...args],
    cwd: opts.launchCwd,
    env: opencodeRunEnv(opts.opencodeHome),
    timeoutMs: opts.timeoutMs ?? OPENCODE_CAPTURE_TIMEOUT_MS,
  });
}

// Mirror Python os.path.realpath: resolve symlinks but never throw on a missing
// path (fs.realpathSync throws ENOENT; fall back to a non-resolving resolve).
function realpathSafe(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

interface SessionRow {
  readonly id: string;
  readonly directory: string;
  readonly [key: string]: unknown;
}

interface SessionDecision {
  index: number;
  id?: unknown;
  directory?: string;
  directory_realpath?: string;
  launch_cwd_realpath?: string;
  matched: boolean;
  reason?: string;
}

function sessionDecisions(
  rawSessions: unknown,
  launchCwd: string,
): [SessionDecision[], SessionRow[]] {
  if (!Array.isArray(rawSessions)) {
    throw new OpenCodeCaptureError(
      'opencode session list returned non-list JSON',
    );
  }
  const target = realpathSafe(launchCwd);
  const decisions: SessionDecision[] = [];
  const matches: SessionRow[] = [];
  for (let index = 0; index < rawSessions.length; index += 1) {
    const session = rawSessions[index];
    if (
      typeof session !== 'object' ||
      session === null ||
      Array.isArray(session)
    ) {
      decisions.push({ index, matched: false, reason: 'non-dict row' });
      continue;
    }
    const row = session as Record<string, unknown>;
    const directory = row['directory'];
    const sessionId = row['id'];
    if (typeof directory !== 'string' || typeof sessionId !== 'string') {
      decisions.push({
        index,
        id: sessionId,
        matched: false,
        reason: 'missing id or directory',
      });
      continue;
    }
    const directoryRealpath = realpathSafe(directory);
    const matched = directoryRealpath === target;
    decisions.push({
      index,
      id: sessionId,
      directory,
      directory_realpath: directoryRealpath,
      launch_cwd_realpath: target,
      matched,
    });
    if (matched) {
      matches.push(row as SessionRow);
    }
  }
  return [decisions, matches];
}

function isTimeoutError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.message.toLowerCase().includes('timeout') ||
      e.constructor.name === 'TimeoutError')
  );
}

function listSessions(opts: {
  opencodeHome: string;
  launchCwd: string;
  spawn?: SpawnFn;
}): unknown[] {
  let result: SpawnResult;
  try {
    result = runOpencodeCommand(['session', 'list', '--format', 'json'], {
      opencodeHome: opts.opencodeHome,
      launchCwd: opts.launchCwd,
      ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      throw new OpenCodeCaptureError(
        `opencode session list timed out after ${OPENCODE_CAPTURE_TIMEOUT_MS / 1000}s`,
      );
    }
    throw e;
  }
  if (result.exitCode !== 0) {
    throw new OpenCodeCaptureError(
      `opencode session list failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`,
    );
  }
  let sessions: unknown;
  try {
    sessions = JSON.parse(result.stdout || '[]');
  } catch {
    throw new OpenCodeCaptureError(
      'opencode session list returned invalid JSON',
    );
  }
  if (!Array.isArray(sessions)) {
    throw new OpenCodeCaptureError(
      'opencode session list returned non-list JSON',
    );
  }
  return sessions;
}

export function snapshotOpencodeSessions(opts: {
  home: string;
  launchCwd: string;
  spawn?: SpawnFn;
}): Set<string> {
  const rawSessions = listSessions({
    opencodeHome: opts.home,
    launchCwd: opts.launchCwd,
    ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
  });
  const [, sessions] = sessionDecisions(rawSessions, opts.launchCwd);
  return new Set(sessions.map((s) => s.id));
}

function sessionCreated(session: Record<string, unknown>): number | null {
  for (const key of ['created', 'time_created']) {
    const value = session[key];
    if (typeof value === 'number') return value;
  }
  return null;
}

function exportedCreated(exportedJson: Record<string, unknown>): number | null {
  const info = exportedJson['info'];
  if (typeof info !== 'object' || info === null) return null;
  const time = (info as Record<string, unknown>)['time'];
  if (typeof time !== 'object' || time === null) return null;
  const created = (time as Record<string, unknown>)['created'];
  return typeof created === 'number' ? created : null;
}

function exportSession(opts: {
  sessionId: string;
  opencodeHome: string;
  launchCwd: string;
  spawn?: SpawnFn;
}): [Record<string, unknown>, string, string] {
  let result: SpawnResult;
  try {
    result = runOpencodeCommand(['export', opts.sessionId], {
      opencodeHome: opts.opencodeHome,
      launchCwd: opts.launchCwd,
      ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      throw new OpenCodeCaptureError(
        `opencode export ${opts.sessionId} timed out after ${OPENCODE_CAPTURE_TIMEOUT_MS / 1000}s`,
      );
    }
    throw e;
  }
  if (result.exitCode !== 0) {
    throw new OpenCodeCaptureError(
      `opencode export ${opts.sessionId} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`,
    );
  }
  let exportedJson: Record<string, unknown>;
  try {
    exportedJson = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    const byteLen = new TextEncoder().encode(result.stdout).length;
    throw new OpenCodeCaptureError(
      `opencode export ${opts.sessionId} returned invalid JSON ` +
        `(${byteLen} bytes; ` +
        `head: ${JSON.stringify(result.stdout.slice(0, 120))}; ` +
        `stderr: ${result.stderr.trim().slice(0, 300)})`,
    );
  }
  const info = exportedJson['info'];
  const exportedId =
    typeof info === 'object' && info !== null
      ? (info as Record<string, unknown>)['id']
      : undefined;
  if (exportedId !== opts.sessionId) {
    throw new OpenCodeCaptureError(
      `opencode export ${opts.sessionId} returned session id ${JSON.stringify(exportedId)}`,
    );
  }
  return [exportedJson, result.stdout, result.stderr];
}

interface ExportRecord {
  id: string;
  json: Record<string, unknown>;
  stdout: string;
  stderr: string;
  created: number | null;
}

export function exportOpencodeSessions(opts: {
  opencodeHome: string;
  exportDir: string;
  launchCwd: string;
  snapshot: Set<string>;
  spawn?: SpawnFn;
}): string[] {
  const { opencodeHome, exportDir, launchCwd, snapshot, spawn } = opts;
  mkdirSync(exportDir, { recursive: true });

  const rawSessions = listSessions({
    opencodeHome,
    launchCwd,
    ...(spawn !== undefined ? { spawn } : {}),
  });
  const [decisions, sessions] = sessionDecisions(rawSessions, launchCwd);
  const newSessions = sessions.filter((s) => !snapshot.has(s.id));

  const exportRecords: ExportRecord[] = [];
  for (const session of newSessions) {
    const sessionId = session.id;
    const [exportedJson, stdout, stderr] = exportSession({
      sessionId,
      opencodeHome,
      launchCwd,
      ...(spawn !== undefined ? { spawn } : {}),
    });
    const created = sessionCreated(session) ?? exportedCreated(exportedJson);
    exportRecords.push({
      id: sessionId,
      json: exportedJson,
      stdout,
      stderr,
      created,
    });
  }

  if (
    exportRecords.length > 1 &&
    exportRecords.some((r) => r.created === null)
  ) {
    throw new OpenCodeCaptureError(
      'cannot order multiple new OpenCode sessions without creation times',
    );
  }

  exportRecords.sort((a, b) => {
    const ca = a.created ?? 0;
    const cb = b.created ?? 0;
    if (ca !== cb) return ca - cb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const exported: string[] = [];
  const manifest: Record<string, unknown> = {
    raw_session_rows: rawSessions,
    session_decisions: decisions,
    snapshot_ids: [...snapshot].sort(),
    all_matching_ids: sessions.map((s) => s.id),
    matched_ids: newSessions.map((s) => s.id),
    skipped_existing_ids: sessions
      .filter((s) => snapshot.has(s.id))
      .map((s) => s.id),
    skipped_nonmatching_ids: decisions
      .filter((d) => d.id !== undefined && d.id !== null && !d.matched)
      .map((d) => d.id as string),
    exports: [] as unknown[],
  };

  for (const record of exportRecords) {
    const created = record.created ?? 0;
    const filename = `${created.toString().padStart(16, '0')}-${record.id}.json`;
    const outPath = join(exportDir, filename);
    writeFileSync(outPath, record.stdout);
    (manifest['exports'] as unknown[]).push({
      id: record.id,
      created,
      path: outPath,
      stderr: record.stderr,
    });
    exported.push(outPath);
  }

  writeFileSync(
    join(exportDir, 'opencode-session-export-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return exported;
}
