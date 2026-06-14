/**
 * Attribute shared-tree session logs to the run that produced them.
 *
 * Codex, Pi, and Kimi write every session into one shared tree (~/.codex/sessions,
 * etc.), so a post-drive snapshot diff sees logs from concurrent runs too. These
 * helpers narrow a new-file diff to the logs whose recorded session cwd matches
 * the run's launch cwd, and flag logs that landed in the wrong cwd (a QA-agent
 * misconfiguration) versus logs that simply can't be attributed.
 *
 * These are log-location concerns, not tool-call normalization — normalization is
 * handled by the TS ATIF normalizers.
 *
 * Port of quorum/log_filters.py — public API is camelCase TS, logic is identical.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/**
 * Drop codex rollouts whose session_meta.cwd doesn't match target_cwd.
 *
 * Codex stores all sessions under a shared ~/.codex/sessions/ tree, so when
 * multiple drill scenarios run in parallel each one's snapshot diff sees every
 * other run's rollouts. Each rollout's first line is a `session_meta` event
 * that records the cwd the codex CLI was launched in — use it to attribute
 * rollouts to the run that produced them.
 *
 * Paths are compared after realpath resolution: macOS hands out workdirs
 * under /var/folders/... but codex records the resolved /private/var/...
 * realpath, so raw string equality would drop every rollout.
 */
export function filterCodexLogsByCwd(
  paths: string[],
  targetCwd: string,
): string[] {
  const target = realpathSafe(targetCwd);
  const matched: string[] = [];
  for (const p of paths) {
    const entry = readFirstLineJson(p);
    if (entry === null) continue;
    if (entry["type"] !== "session_meta") continue;
    const payload = entry["payload"];
    if (!isRecord(payload)) continue;
    const cwd = payload["cwd"];
    if (typeof cwd !== "string" || !cwd) continue;
    if (realpathSafe(cwd) === target) {
      matched.push(p);
    }
  }
  return matched;
}

/**
 * Rollouts whose cwd is inside run_dir but isn't the expected launch_cwd.
 *
 * Smoking gun for "QA agent skipped `cd $QUORUM_AGENT_CWD` before launching
 * codex" — the rollout is clearly attributable to this run (it's inside the
 * run dir) but codex booted in the wrong subdirectory, so filterCodexLogsByCwd
 * correctly excludes it from the normalized output. The runner uses this to
 * distinguish that QA-agent misconfiguration from a genuine never-launched
 * failure.
 */
export function findMisplacedCodexRollouts(
  paths: string[],
  { runDir, launchCwd }: { runDir: string; launchCwd: string },
): string[] {
  const runDirReal = realpathSafe(runDir);
  const launchCwdReal = realpathSafe(launchCwd);
  const misplaced: string[] = [];
  for (const p of paths) {
    const entry = readFirstLineJson(p);
    if (entry === null) continue;
    if (entry["type"] !== "session_meta") continue;
    const payload = entry["payload"];
    if (!isRecord(payload)) continue;
    const cwd = payload["cwd"];
    if (typeof cwd !== "string" || !cwd) continue;
    const cwdReal = realpathSafe(cwd);
    const insideRunDir =
      cwdReal === runDirReal ||
      cwdReal.startsWith(runDirReal + path.sep);
    if (insideRunDir && cwdReal !== launchCwdReal) {
      misplaced.push(p);
    }
  }
  return misplaced;
}

// ---------------------------------------------------------------------------
// Pi
// ---------------------------------------------------------------------------

/**
 * Drop Pi sessions whose header cwd doesn't match target_cwd.
 *
 * Paths are realpath-resolved before comparison — see filterCodexLogsByCwd
 * for why raw string equality fails on macOS.
 */
export function filterPiLogsByCwd(
  paths: string[],
  targetCwd: string,
): string[] {
  const target = realpathSafe(targetCwd);
  const matched: string[] = [];
  for (const p of paths) {
    const entry = readFirstLineJson(p);
    if (entry === null) continue;
    if (entry["type"] !== "session") continue;
    const cwd = entry["cwd"];
    if (typeof cwd !== "string" || !cwd) continue;
    if (realpathSafe(cwd) === target) {
      matched.push(p);
    }
  }
  return matched;
}

/** Return the cwd from a Pi session header, or null if not present/parseable. */
function piSessionHeaderCwd(p: string): string | null {
  const entry = readFirstLineJson(p);
  if (entry === null) return null;
  if (entry["type"] !== "session") return null;
  const cwd = entry["cwd"];
  return typeof cwd === "string" && cwd ? cwd : null;
}

/** New run-local Pi sessions that launched in the wrong cwd. */
export function findMisplacedPiSessions(
  paths: string[],
  { launchCwd }: { launchCwd: string },
): string[] {
  const launchCwdReal = realpathSafe(launchCwd);
  const misplaced: string[] = [];
  for (const p of paths) {
    const cwd = piSessionHeaderCwd(p);
    if (cwd === null) continue;
    if (realpathSafe(cwd) !== launchCwdReal) {
      misplaced.push(p);
    }
  }
  return misplaced;
}

/** New Pi session files whose first row cannot identify a session cwd. */
export function findUnusablePiSessions(paths: string[]): string[] {
  return paths.filter((p) => piSessionHeaderCwd(p) === null);
}

// ---------------------------------------------------------------------------
// Kimi
// ---------------------------------------------------------------------------

/**
 * Walk up from a log path to find the kimi home dir (parent of "sessions/").
 * Returns null if no "sessions" ancestor is found.
 */
function kimiHomeForLog(logPath: string): string | null {
  let current = path.dirname(logPath);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root
      return null;
    }
    if (path.basename(current) === "sessions") {
      return parent;
    }
    current = parent;
  }
}

interface KimiIndexEntry {
  sessionDir: string;
  workDir: string;
}

/** Drop Kimi wire logs whose session_index workDir doesn't match target_cwd. */
export function filterKimiLogsByCwd(
  paths: string[],
  targetCwd: string,
): string[] {
  const target = realpathSafe(targetCwd);
  const matched: string[] = [];
  const indexCache = new Map<string, KimiIndexEntry[]>();

  for (const p of paths) {
    const kimiHome = kimiHomeForLog(p);
    if (kimiHome === null) continue;

    if (!indexCache.has(kimiHome)) {
      const entries: KimiIndexEntry[] = [];
      const indexPath = path.join(kimiHome, "session_index.jsonl");
      try {
        const content = fs.readFileSync(indexPath, "utf8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          let entry: unknown;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isRecord(entry)) continue;
          entries.push({
            sessionDir: String(entry["sessionDir"] ?? ""),
            workDir: String(entry["workDir"] ?? ""),
          });
        }
      } catch {
        // OSError equivalent — leave entries empty
      }
      indexCache.set(kimiHome, entries);
    }

    const pathReal = realpathSafe(p);
    const cachedEntries = indexCache.get(kimiHome)!;
    for (const entry of cachedEntries) {
      const { sessionDir, workDir } = entry;
      if (!sessionDir || !workDir) continue;
      const sessionReal = realpathSafe(sessionDir);
      const insideSession =
        pathReal === sessionReal ||
        pathReal.startsWith(sessionReal + path.sep);
      if (insideSession && realpathSafe(workDir) === target) {
        matched.push(p);
        break;
      }
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Read and JSON-parse the first line of a file. Returns null on any error. */
function readFirstLineJson(filePath: string): Record<string, unknown> | null {
  let content: string;
  try {
    // Read the whole file then take just the first line — avoids streaming
    const raw = fs.readFileSync(filePath, "utf8");
    const newline = raw.indexOf("\n");
    content = newline === -1 ? raw : raw.slice(0, newline);
  } catch {
    return null;
  }
  if (!content.trim()) return null;
  try {
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Resolve a path to its realpath; returns the original path if resolution fails. */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Type guard: value is a non-null Record<string, unknown>. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
