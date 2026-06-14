/**
 * Export OpenCode sessions from isolated per-run state.
 *
 * Port of quorum/opencode_capture.py — public API is camelCase TS, logic is identical.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class OpenCodeCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeCaptureError";
  }
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

export function opencodeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TMPDIR: path.join(home, ".tmp"),
    OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
  };
}

export const OPENCODE_ENV_ALLOWLIST = new Set([
  "PATH",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

export const OPENCODE_CAPTURE_TIMEOUT_MS = 30_000;

export function opencodeRunEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (OPENCODE_ENV_ALLOWLIST.has(key) && value !== undefined) {
      env[key] = value;
    }
  }
  if (!("PATH" in env)) env["PATH"] = "/usr/bin:/bin";
  if (!("TERM" in env)) env["TERM"] = "xterm-256color";
  if (!("LANG" in env)) env["LANG"] = "C.UTF-8";
  Object.assign(env, opencodeEnv(home));
  return env;
}

// ---------------------------------------------------------------------------
// Spawn function type
// ---------------------------------------------------------------------------

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Injectable spawn function type. Takes the command args, cwd, env, and
 * timeout (ms). Returns SpawnResult synchronously.
 */
export type SpawnFn = (opts: {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}) => SpawnResult;

// ---------------------------------------------------------------------------
// Default spawn implementation (uses Bun.spawnSync + temp file for stdout)
// ---------------------------------------------------------------------------

/**
 * Run an opencode CLI command with stdout redirected to a temp file.
 *
 * The opencode binary ends every command with a bare process.exit(), which
 * discards stdout that has not yet drained. Through a pipe, payloads >64KiB
 * arrive truncated at the pipe-buffer boundary (still exit 0) and tiny
 * replies can vanish entirely under load. A regular-file stdout drains
 * synchronously, so the payload survives. stderr stays piped (always small).
 */
export function defaultSpawn(opts: {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}): SpawnResult {
  const { args, cwd, env, timeoutMs } = opts;
  const tmpFile = path.join(
    os.tmpdir(),
    `opencode-stdout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  fs.writeFileSync(tmpFile, "");
  try {
    const stdoutFd = fs.openSync(tmpFile, "r+");
    try {
      const proc = Bun.spawnSync(args, {
        cwd,
        env,
        stdin: "ignore",
        stdout: stdoutFd,
        stderr: "pipe",
        timeout: timeoutMs,
      });
      const stdout = fs.readFileSync(tmpFile, "utf8");
      const stderr =
        proc.stderr instanceof Uint8Array
          ? new TextDecoder().decode(proc.stderr)
          : typeof proc.stderr === "string"
            ? proc.stderr
            : "";
      const exitCode = proc.exitCode ?? 0;
      return { stdout, stderr, exitCode };
    } finally {
      fs.closeSync(stdoutFd);
    }
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// runOpencodeCommand
// ---------------------------------------------------------------------------

export function runOpencodeCommand(
  args: string[],
  opts: {
    opencodeHome: string;
    launchCwd: string;
    timeoutMs?: number;
    spawn?: SpawnFn;
  },
): SpawnResult {
  const { opencodeHome, launchCwd, timeoutMs = OPENCODE_CAPTURE_TIMEOUT_MS, spawn = defaultSpawn } =
    opts;
  const result = spawn({
    args: ["opencode", ...args],
    cwd: launchCwd,
    env: opencodeRunEnv(opencodeHome),
    timeoutMs,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function _realpath(value: string): string {
  // Mirror Python's os.path.realpath: resolves symlinks but does not throw
  // for non-existent paths (unlike fs.realpathSync which throws ENOENT).
  try {
    return fs.realpathSync(value);
  } catch {
    // For non-existent paths, normalize without resolving symlinks.
    return path.resolve(value);
  }
}

interface SessionRow {
  id: string;
  directory: string;
  [key: string]: unknown;
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
    throw new OpenCodeCaptureError("opencode session list returned non-list JSON");
  }
  const target = _realpath(launchCwd);
  const decisions: SessionDecision[] = [];
  const matches: SessionRow[] = [];
  for (let index = 0; index < rawSessions.length; index++) {
    const session = rawSessions[index];
    if (typeof session !== "object" || session === null || Array.isArray(session)) {
      decisions.push({ index, matched: false, reason: "non-dict row" });
      continue;
    }
    const sessionRow = session as Record<string, unknown>;
    const directory = sessionRow["directory"];
    const sessionId = sessionRow["id"];
    if (typeof directory !== "string" || typeof sessionId !== "string") {
      decisions.push({
        index,
        id: sessionId,
        matched: false,
        reason: "missing id or directory",
      });
      continue;
    }
    const directoryRealpath = _realpath(directory);
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
      matches.push(sessionRow as unknown as SessionRow);
    }
  }
  return [decisions, matches];
}

function listSessions(opts: {
  opencodeHome: string;
  launchCwd: string;
  spawn?: SpawnFn;
}): unknown[] {
  const { opencodeHome, launchCwd, spawn } = opts;
  let result: SpawnResult;
  try {
    result = runOpencodeCommand(["session", "list", "--format", "json"], {
      opencodeHome,
      launchCwd,
      spawn,
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
    sessions = JSON.parse(result.stdout || "[]");
  } catch {
    throw new OpenCodeCaptureError("opencode session list returned invalid JSON");
  }
  if (!Array.isArray(sessions)) {
    throw new OpenCodeCaptureError("opencode session list returned non-list JSON");
  }
  return sessions;
}

function isTimeoutError(e: unknown): boolean {
  if (e instanceof Error) {
    return e.message.toLowerCase().includes("timeout") || e.constructor.name === "TimeoutError";
  }
  return false;
}

// ---------------------------------------------------------------------------
// snapshotOpencodeSessions
// ---------------------------------------------------------------------------

export function snapshotOpencodeSessions(opts: {
  home: string;
  launchCwd: string;
  spawn?: SpawnFn;
}): Set<string> {
  const { home, launchCwd, spawn } = opts;
  const rawSessions = listSessions({ opencodeHome: home, launchCwd, spawn });
  const [, sessions] = sessionDecisions(rawSessions, launchCwd);
  return new Set(sessions.map((s) => s["id"]));
}

// ---------------------------------------------------------------------------
// Session created timestamp helpers
// ---------------------------------------------------------------------------

function sessionCreated(session: Record<string, unknown>): number | null {
  for (const key of ["created", "time_created"]) {
    const value = session[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function exportedCreated(exportedJson: Record<string, unknown>): number | null {
  const info = exportedJson["info"];
  if (typeof info !== "object" || info === null) return null;
  const time = (info as Record<string, unknown>)["time"];
  if (typeof time !== "object" || time === null) return null;
  const created = (time as Record<string, unknown>)["created"];
  return typeof created === "number" ? created : null;
}

// ---------------------------------------------------------------------------
// exportSession
// ---------------------------------------------------------------------------

function exportSession(opts: {
  sessionId: string;
  opencodeHome: string;
  launchCwd: string;
  spawn?: SpawnFn;
}): [Record<string, unknown>, string, string] {
  const { sessionId, opencodeHome, launchCwd, spawn } = opts;
  let result: SpawnResult;
  try {
    result = runOpencodeCommand(["export", sessionId], {
      opencodeHome,
      launchCwd,
      spawn,
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      throw new OpenCodeCaptureError(
        `opencode export ${sessionId} timed out after ${OPENCODE_CAPTURE_TIMEOUT_MS / 1000}s`,
      );
    }
    throw e;
  }
  if (result.exitCode !== 0) {
    throw new OpenCodeCaptureError(
      `opencode export ${sessionId} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`,
    );
  }
  let exportedJson: Record<string, unknown>;
  try {
    exportedJson = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    const byteLen = new TextEncoder().encode(result.stdout).length;
    throw new OpenCodeCaptureError(
      `opencode export ${sessionId} returned invalid JSON ` +
        `(${byteLen} bytes; ` +
        `head: ${JSON.stringify(result.stdout.slice(0, 120))}; ` +
        `stderr: ${result.stderr.trim().slice(0, 300)})`,
    );
  }
  const info = exportedJson["info"];
  const exportedId =
    typeof info === "object" && info !== null ? (info as Record<string, unknown>)["id"] : undefined;
  if (exportedId !== sessionId) {
    throw new OpenCodeCaptureError(
      `opencode export ${sessionId} returned session id ${JSON.stringify(exportedId)}`,
    );
  }
  return [exportedJson, result.stdout, result.stderr];
}

// ---------------------------------------------------------------------------
// exportOpencodeSessions
// ---------------------------------------------------------------------------

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
  fs.mkdirSync(exportDir, { recursive: true });

  const rawSessions = listSessions({ opencodeHome, launchCwd, spawn });
  const [decisions, sessions] = sessionDecisions(rawSessions, launchCwd);
  const newSessions = sessions.filter((s) => !snapshot.has(s["id"]));

  const exportRecords: ExportRecord[] = [];
  for (const session of newSessions) {
    const sessionId = session["id"];
    const [exportedJson, stdout, stderr] = exportSession({
      sessionId,
      opencodeHome,
      launchCwd,
      spawn,
    });
    const created =
      sessionCreated(session as Record<string, unknown>) || exportedCreated(exportedJson);
    exportRecords.push({ id: sessionId, json: exportedJson, stdout, stderr, created });
  }

  if (exportRecords.length > 1 && exportRecords.some((r) => r.created === null)) {
    throw new OpenCodeCaptureError(
      "cannot order multiple new OpenCode sessions without creation times",
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
    all_matching_ids: sessions.map((s) => s["id"]),
    matched_ids: newSessions.map((s) => s["id"]),
    skipped_existing_ids: sessions.filter((s) => snapshot.has(s["id"])).map((s) => s["id"]),
    skipped_nonmatching_ids: decisions
      .filter((d) => d.id !== undefined && !d.matched)
      .map((d) => d.id as string),
    exports: [] as unknown[],
  };

  for (const record of exportRecords) {
    const created = record.created ?? 0;
    const filename = `${created.toString().padStart(16, "0")}-${record.id}.json`;
    const outPath = path.join(exportDir, filename);
    fs.writeFileSync(outPath, record.stdout, "utf8");
    (manifest["exports"] as unknown[]).push({
      id: record.id,
      created,
      path: outPath,
      stderr: record.stderr,
    });
    exported.push(outPath);
  }

  fs.writeFileSync(
    path.join(exportDir, "opencode-session-export-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  return exported;
}
