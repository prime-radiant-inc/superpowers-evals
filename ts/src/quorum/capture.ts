/**
 * Snapshot, diff, and capture agent-under-test session-log directories.
 *
 * Capture emits the ATIF trajectory.json from a run's new session logs. A run
 * can produce more than one session log — gemini writes a main chat plus a
 * subagent chat, and any agent's subagent runs each write their own file — so
 * capture normalizes EVERY new log and merges them into ONE trajectory ordered
 * by step timestamp. Checks read the ATIF trajectory via QUORUM_TRANSCRIPT_PATH.
 *
 * Port of quorum/capture.py. Two deliberate divergences from the Python:
 *  - Paths are plain strings (the TS convention; see log-filters.ts), not a
 *    Path type.
 *  - ATIF emission is IN-PROCESS: the Python capture shells out to the bun
 *    cli/normalize.ts dispatcher per source log; here we call the per-agent
 *    normalize functions directly and merge their outputs. Same outputs, no
 *    subprocess.
 *
 * capture_token_usage is intentionally not ported here — it depends on
 * obol_capture + timing and is out of scope for this build-ahead port.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Glob } from "bun";

import type { AtifTrajectory } from "../atif/types.ts";
import {
  filterCodexLogsByCwd,
  filterKimiLogsByCwd,
  filterPiLogsByCwd,
  findMisplacedCodexRollouts,
  findMisplacedPiSessions,
  findUnusablePiSessions,
} from "./log-filters.ts";

import { normalizeClaudeLegacy } from "../normalize/claude.ts";
import { normalizeCodex } from "../normalize/codex.ts";
import { normalizeGemini } from "../normalize/gemini.ts";
import { normalizeCopilot } from "../normalize/copilot.ts";
import { normalizeOpencode } from "../normalize/opencode.ts";
import { normalizePi } from "../normalize/pi.ts";
import { normalizeKimi } from "../normalize/kimi.ts";
import { normalizeAntigravity } from "../normalize/antigravity.ts";

export const ATIF_TRAJECTORY_FILENAME = "trajectory.json";

type NormalizeFn = (raw: string, version: string) => AtifTrajectory;

// Mirrors the unified cli/normalize.ts dispatch table. All eight coding agents
// are TS-backed. capture.py reaches these via the bun CLI subprocess; here we
// call them in-process.
const NORMALIZERS: Record<string, NormalizeFn> = {
  claude: normalizeClaudeLegacy,
  codex: normalizeCodex,
  gemini: normalizeGemini,
  copilot: normalizeCopilot,
  opencode: normalizeOpencode,
  pi: normalizePi,
  kimi: normalizeKimi,
  antigravity: normalizeAntigravity,
};

export interface CaptureResult {
  // Path to the emitted ATIF trajectory.json. The file may be absent on a
  // zero-row capture: emission failures and trajectories with no tool calls
  // leave no file (so downstream loaders fail closed and the retry fires).
  path: string;
  sourceLogs: string[];
  rowCount: number;
  // How many capture passes ran (PRI-2081): 1 = first pass succeeded;
  // >1 = the empty-capture retry re-diffed after a delay.
  attempts: number;
}

export interface KimiUnmatchedLogsDiagnostic {
  paths: string[];
  reason: "wrong-cwd" | "unmapped";
  stage: "capture" | "qa-agent-misconfigured";
}

export function snapshotDir(logDir: string, glob: string): Set<string> {
  if (!fs.existsSync(logDir)) return new Set();
  const g = new Glob(glob);
  const out = new Set<string>();
  for (const rel of g.scanSync({ cwd: logDir, onlyFiles: true, dot: true })) {
    out.add(rel);
  }
  return out;
}

export function newFilesSince(
  logDir: string,
  glob: string,
  snapshot: Set<string>,
): string[] {
  if (!fs.existsSync(logDir)) return [];
  const g = new Glob(glob);
  const current = new Map<string, string>();
  for (const rel of g.scanSync({ cwd: logDir, onlyFiles: true, dot: true })) {
    current.set(rel, path.join(logDir, rel));
  }
  const added = [...current.keys()].filter((k) => !snapshot.has(k));
  added.sort();
  return added.map((k) => current.get(k)!);
}

/**
 * New session-log files since `snapshot`, cwd-filtered for shared-log agents.
 *
 * codex, kimi, and pi share one session-log tree across runs, so their new-file
 * diff is narrowed to logs whose recorded session cwd matches the launch cwd.
 * This must be the launch cwd, not the scenario workdir — a scenario may point
 * the agent at a subdir via .quorum-launch-cwd.
 */
function newSessionLogs(
  logDir: string,
  logGlob: string,
  snapshot: Set<string>,
  normalizer: string,
  launchCwd: string | null,
): string[] {
  let newFiles = newFilesSince(logDir, logGlob, snapshot);
  if (normalizer === "codex" && launchCwd !== null) {
    newFiles = filterCodexLogsByCwd(newFiles, launchCwd);
  } else if (normalizer === "kimi" && launchCwd !== null) {
    newFiles = filterKimiLogsByCwd(newFiles, launchCwd);
  } else if (normalizer === "pi" && launchCwd !== null) {
    newFiles = filterPiLogsByCwd(newFiles, launchCwd);
  }
  return newFiles;
}

/**
 * Number of tool_calls across all steps in an emitted ATIF trajectory.
 *
 * A trajectory that parses but carries no tool calls counts as zero — the same
 * "nothing captured" signal the flat-JSONL row count used to give, which keeps
 * the empty-capture retry firing for still-flushing logs.
 */
export function trajectoryToolCallCount(trajectoryPath: string): number {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(trajectoryPath, "utf8"));
  } catch {
    return 0;
  }
  const steps = isRecord(data) && Array.isArray(data["steps"]) ? data["steps"] : [];
  return stepsToolCallCount(steps as unknown[]);
}

export function stepsToolCallCount(steps: unknown[]): number {
  let count = 0;
  for (const step of steps) {
    if (isRecord(step)) {
      const toolCalls = step["tool_calls"];
      if (Array.isArray(toolCalls)) {
        count += toolCalls.length;
      }
    }
  }
  return count;
}

/**
 * ISO-8601 step timestamp, or "" when the step carries none.
 *
 * Empty-string sorts last among the merge keys so timestamped steps order among
 * themselves and untimestamped steps fall back to file/in-file order.
 */
export function stepTimestamp(step: Record<string, unknown>): string {
  const ts = step["timestamp"];
  return typeof ts === "string" ? ts : "";
}

interface OrderedStep {
  noTs: boolean;
  ts: string;
  fileIndex: number;
  inFileIndex: number;
  step: Record<string, unknown>;
}

/**
 * Merge one ATIF trajectory per source file into a single trajectory.
 *
 * A run can produce more than one session log (gemini main + subagent chats;
 * any agent's subagent runs). Emitting from only the first log silently drops
 * every tool call recorded in the others. This merges the steps of all files
 * into one trajectory:
 *
 * - Steps are ordered by their ISO-8601 `timestamp` where present, with a STABLE
 *   fallback (file order = the input `perFile` order, then in-file order) for
 *   steps that carry no timestamp. Timestamped steps sort among themselves by
 *   timestamp; steps lacking a timestamp keep their relative input position via
 *   the (file index, in-file index) tiebreak.
 * - `step_id` is renumbered sequentially from 1 across the merged set.
 * - Each step's `tool_calls`/`observation` are kept intact; observations already
 *   reference tool_call_ids in their own step, so renumbering step_ids preserves
 *   validateTrajectory's same-step observation invariant.
 *
 * Returns the merged trajectory, or null when no file yielded a parseable
 * trajectory with steps. The trajectory envelope (schema_version, agent) is
 * taken from the first file that has steps.
 */
export function mergeTrajectories(
  perFile: Record<string, unknown>[],
): Record<string, unknown> | null {
  let envelope: Record<string, unknown> | null = null;
  const ordered: OrderedStep[] = [];

  for (let fileIndex = 0; fileIndex < perFile.length; fileIndex++) {
    const data = perFile[fileIndex];
    if (!isRecord(data)) continue;
    const steps = data["steps"];
    if (!Array.isArray(steps) || steps.length === 0) continue;
    if (envelope === null) envelope = data;
    for (let inFileIndex = 0; inFileIndex < steps.length; inFileIndex++) {
      const step = steps[inFileIndex];
      if (!isRecord(step)) continue;
      const ts = stepTimestamp(step);
      ordered.push({ noTs: ts === "", ts, fileIndex, inFileIndex, step });
    }
  }

  if (envelope === null || ordered.length === 0) return null;

  // Stable sort on (noTs, ts, fileIndex, inFileIndex) — mirrors the Python
  // tuple sort key item[:4]. JS Array.sort is stable, but the full key is
  // total so stability is not relied upon for correctness.
  ordered.sort((a, b) => {
    if (a.noTs !== b.noTs) return a.noTs ? 1 : -1;
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.fileIndex !== b.fileIndex) return a.fileIndex - b.fileIndex;
    return a.inFileIndex - b.inFileIndex;
  });

  const mergedSteps: Record<string, unknown>[] = [];
  ordered.forEach((item, i) => {
    const merged = { ...item.step };
    merged["step_id"] = i + 1;
    mergedSteps.push(merged);
  });

  const mergedTrajectory = { ...envelope };
  mergedTrajectory["steps"] = mergedSteps;
  return mergedTrajectory;
}

/**
 * Normalize one source log to ATIF in-process and return the trajectory.
 *
 * Returns null on any failure — missing/unreadable log, unknown normalizer, or
 * a normalizer throw — the same fail-closed signal a missing log gives, which
 * keeps the empty-capture retry intact. This is the in-process equivalent of
 * the Python _emit_and_load (which shelled to the bun normalizer).
 */
function emitAndLoad(
  sourceLog: string,
  normalizer: string,
  version: string,
): Record<string, unknown> | null {
  const normalize = NORMALIZERS[normalizer];
  if (!normalize) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(sourceLog, "utf8");
  } catch {
    return null;
  }
  try {
    return normalize(raw, version) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface CaptureToolCallsOptions {
  logDir: string;
  logGlob: string;
  snapshot: Set<string>;
  normalizer: string;
  runDir: string;
  launchCwd?: string | null;
  version?: string;
}

/**
 * Diff logDir, filter by cwd if applicable, emit the merged ATIF trajectory.
 *
 * Locates the run's new source logs (cwd-filtered for shared-tree agents),
 * normalizes EVERY one in-process, and merges their steps into a single
 * runDir/trajectory.json ordered by step timestamp (see mergeTrajectories).
 * rowCount is the number of tool_calls in the merged trajectory. When there is
 * no source log, all emissions fail, or the merge has no tool calls, rowCount is
 * 0 and any stale trajectory.json is removed — so downstream loaders fail closed
 * and the empty-capture retry (PRI-2081) still fires.
 */
export function captureToolCalls(opts: CaptureToolCallsOptions): CaptureResult {
  const { logDir, logGlob, snapshot, normalizer, runDir } = opts;
  const launchCwd = opts.launchCwd ?? null;
  const version = opts.version ?? "unknown";

  const newFiles = newSessionLogs(logDir, logGlob, snapshot, normalizer, launchCwd);
  const outPath = path.join(runDir, ATIF_TRAJECTORY_FILENAME);

  const perFile: Record<string, unknown>[] = [];
  for (const sourceLog of newFiles) {
    const data = emitAndLoad(sourceLog, normalizer, version);
    if (data !== null) perFile.push(data);
  }

  const merged = mergeTrajectories(perFile);
  const rowCount = merged
    ? stepsToolCallCount((merged["steps"] as unknown[]) ?? [])
    : 0;
  if (merged !== null && rowCount > 0) {
    fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n");
  } else {
    // A zero-row capture must not leave a stale trajectory behind: a later
    // retry pass (or a downstream loader) must see "nothing captured".
    try {
      fs.unlinkSync(outPath);
    } catch {
      // missing_ok — nothing to remove
    }
  }

  return { path: outPath, sourceLogs: newFiles, rowCount, attempts: 1 };
}

export interface CaptureToolCallsWithRetryOptions extends CaptureToolCallsOptions {
  attempts?: number;
  delayS?: number;
  sleep?: (seconds: number) => void;
  // Injectable underlying capture, used to isolate the retry loop in tests
  // (the Python suite patches quorum.capture.capture_tool_calls).
  captureImpl?: (opts: CaptureToolCallsOptions) => CaptureResult;
}

/**
 * captureToolCalls with an empty-capture retry/guard (PRI-2081).
 *
 * A run that produced no new source logs — or logs that yield zero tool calls —
 * is usually a real failure, but it is sometimes a transient race: the
 * Coding-Agent's session log is still being flushed (or renamed into place) when
 * the post-drive diff runs. Those races turned whole runs into permanent
 * stage="capture" indeterminates, paying full Gauntlet + subject spend for no
 * verdict.
 *
 * Re-run the same snapshot diff up to `attempts` times, `delayS` apart, until
 * something captures. Each pass re-emits trajectory.json, so the artifact always
 * reflects the final capture. The returned `attempts` field records how many
 * passes ran; a genuinely-empty run still comes back empty, just
 * `delayS * (attempts - 1)` seconds later.
 */
export function captureToolCallsWithRetry(
  opts: CaptureToolCallsWithRetryOptions,
): CaptureResult {
  const attempts = opts.attempts ?? 3;
  const delayS = opts.delayS ?? 2.0;
  const sleep = opts.sleep ?? defaultSleep;
  const capture = opts.captureImpl ?? captureToolCalls;

  const baseOpts: CaptureToolCallsOptions = {
    logDir: opts.logDir,
    logGlob: opts.logGlob,
    snapshot: opts.snapshot,
    normalizer: opts.normalizer,
    runDir: opts.runDir,
    launchCwd: opts.launchCwd ?? null,
    version: opts.version ?? "unknown",
  };

  let result = capture(baseOpts);
  let used = 1;
  while (result.rowCount === 0 && used < attempts) {
    sleep(delayS);
    used += 1;
    result = capture(baseOpts);
  }
  return { ...result, attempts: used };
}

/** Blocking sleep, the default for the retry delay (Python uses time.sleep). */
function defaultSleep(seconds: number): void {
  Bun.sleepSync(seconds * 1000);
}

export interface DetectMisplacedCodexRolloutsOptions {
  logDir: string;
  logGlob: string;
  snapshot: Set<string>;
  runDir: string;
  launchCwd: string;
}

/**
 * Codex rollouts inside this runDir that launched in the wrong cwd.
 *
 * Smoking gun for the QA agent skipping `cd $QUORUM_AGENT_CWD` before launching
 * codex. Returns empty when nothing is misplaced; the runner uses a non-empty
 * return to short-circuit to indeterminate with stage="qa-agent-misconfigured".
 */
export function detectMisplacedCodexRollouts(
  opts: DetectMisplacedCodexRolloutsOptions,
): string[] {
  const newFiles = newFilesSince(opts.logDir, opts.logGlob, opts.snapshot);
  return findMisplacedCodexRollouts(newFiles, {
    runDir: opts.runDir,
    launchCwd: opts.launchCwd,
  });
}

export interface DetectMisplacedPiSessionsOptions {
  logDir: string;
  logGlob: string;
  snapshot: Set<string>;
  launchCwd: string;
}

/** New run-local Pi sessions that launched in the wrong cwd. */
export function detectMisplacedPiSessions(
  opts: DetectMisplacedPiSessionsOptions,
): string[] {
  const newFiles = newFilesSince(opts.logDir, opts.logGlob, opts.snapshot);
  return findMisplacedPiSessions(newFiles, { launchCwd: opts.launchCwd });
}

export interface DetectUnusablePiSessionsOptions {
  logDir: string;
  logGlob: string;
  snapshot: Set<string>;
}

/** New Pi session files whose first row cannot identify a session cwd. */
export function detectUnusablePiSessions(
  opts: DetectUnusablePiSessionsOptions,
): string[] {
  const newFiles = newFilesSince(opts.logDir, opts.logGlob, opts.snapshot);
  return findUnusablePiSessions(newFiles);
}

/** Walk up from a log path to find the kimi home dir (parent of "sessions/"). */
export function kimiHomeForLog(logPath: string): string | null {
  let current = path.dirname(logPath);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    if (path.basename(current) === "sessions") return parent;
    current = parent;
  }
}

interface KimiIndexEntry {
  sessionDir: string;
  workDir: string;
}

export function readKimiSessionIndex(kimiHome: string): KimiIndexEntry[] {
  const entries: KimiIndexEntry[] = [];
  let content: string;
  try {
    content = fs.readFileSync(path.join(kimiHome, "session_index.jsonl"), "utf8");
  } catch {
    return [];
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(entry)) {
      entries.push({
        sessionDir: String(entry["sessionDir"] ?? ""),
        workDir: String(entry["workDir"] ?? ""),
      });
    }
  }
  return entries;
}

export function indexedWrongCwdKimiLogs(paths: string[], launchCwd: string): string[] {
  const target = realpathSafe(launchCwd);
  const mismatched: string[] = [];
  const indexCache = new Map<string, KimiIndexEntry[]>();
  for (const p of paths) {
    const kimiHome = kimiHomeForLog(p);
    if (kimiHome === null) continue;
    if (!indexCache.has(kimiHome)) {
      indexCache.set(kimiHome, readKimiSessionIndex(kimiHome));
    }

    const pathReal = realpathSafe(p);
    for (const entry of indexCache.get(kimiHome)!) {
      const { sessionDir, workDir } = entry;
      if (!sessionDir || !workDir) continue;
      const sessionReal = realpathSafe(sessionDir);
      const insideSession =
        pathReal === sessionReal || pathReal.startsWith(sessionReal + path.sep);
      if (insideSession && realpathSafe(workDir) !== target) {
        mismatched.push(p);
        break;
      }
    }
  }
  return mismatched;
}

export interface DiagnoseKimiUnmatchedLogsOptions {
  logDir: string;
  logGlob: string;
  snapshot: Set<string>;
  launchCwd: string;
}

export function diagnoseKimiUnmatchedLogs(
  opts: DiagnoseKimiUnmatchedLogsOptions,
): KimiUnmatchedLogsDiagnostic | null {
  const newFiles = newFilesSince(opts.logDir, opts.logGlob, opts.snapshot);
  if (newFiles.length === 0) return null;
  const matched = filterKimiLogsByCwd(newFiles, opts.launchCwd);
  if (matched.length > 0) return null;
  const mismatched = indexedWrongCwdKimiLogs(newFiles, opts.launchCwd);
  if (mismatched.length > 0) {
    return { paths: mismatched, reason: "wrong-cwd", stage: "qa-agent-misconfigured" };
  }
  return { paths: newFiles, reason: "unmapped", stage: "capture" };
}

export function detectKimiCwdMismatch(
  opts: DiagnoseKimiUnmatchedLogsOptions,
): string[] {
  const diagnostic = diagnoseKimiUnmatchedLogs(opts);
  if (diagnostic === null || diagnostic.reason !== "wrong-cwd") return [];
  return diagnostic.paths;
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
