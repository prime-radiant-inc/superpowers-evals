import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Glob } from 'bun';
import { flattenToolCalls } from '../atif/project.ts';
import type { AtifStep, AtifTrajectory } from '../atif/types.ts';
import { normalizeAntigravity } from '../normalize/antigravity.ts';
import { normalizeClaudeLegacy } from '../normalize/claude.ts';
import { normalizeCodex } from '../normalize/codex.ts';
import { normalizeCopilot } from '../normalize/copilot.ts';
import { normalizeGemini } from '../normalize/gemini.ts';
import { normalizeKimi } from '../normalize/kimi.ts';
import { normalizeOpencode } from '../normalize/opencode.ts';
import { normalizePi } from '../normalize/pi.ts';
import { estimateSessionLogs } from '../obol/index.ts';
import { filterLogsByCwd } from './cwd-filter.ts';

// Backend (coding-agent name) -> ATIF normalizer. Mirrors the cli/normalize.ts
// dispatch table; all eight dialects produce an ATIF Trajectory.
type AtifNormalizer = (raw: string, version: string) => AtifTrajectory;

const NORMALIZERS: Record<string, AtifNormalizer> = {
  antigravity: normalizeAntigravity,
  claude: normalizeClaudeLegacy,
  codex: normalizeCodex,
  copilot: normalizeCopilot,
  gemini: normalizeGemini,
  kimi: normalizeKimi,
  opencode: normalizeOpencode,
  pi: normalizePi,
};

// The agent.version carried into ATIF when capture has no version to thread.
const ATIF_AGENT_VERSION = 'unknown';

export const ATIF_TRAJECTORY_FILENAME = 'trajectory.json';

/** Map each matched log to its (relative path -> absolute path). Empty when the
 *  log dir does not exist. */
function globRel(logDir: string, glob: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(logDir)) {
    return out;
  }
  for (const abs of new Glob(glob).scanSync({ cwd: logDir, absolute: true })) {
    out.set(relative(logDir, abs), abs);
  }
  return out;
}

/** Set of relative paths under `logDir` matching `glob` (the pre-run snapshot). */
export function snapshotDir(logDir: string, glob: string): Set<string> {
  return new Set(globRel(logDir, glob).keys());
}

/** Absolute paths of logs present now but absent from `snapshot`, sorted by
 *  relative path. Built from map entries so no cast is needed for the lookup. */
export function newFilesSince(
  logDir: string,
  glob: string,
  snapshot: ReadonlySet<string>,
): string[] {
  return [...globRel(logDir, glob).entries()]
    .filter(([rel]) => !snapshot.has(rel))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, abs]) => abs);
}

export interface CaptureArgs {
  readonly logDir: string;
  readonly logGlob: string;
  readonly snapshot: ReadonlySet<string>;
  readonly normalizer: string;
  readonly runDir: string;
  // The run's launch cwd. codex/kimi/pi share a home tree, so new logs are
  // filtered to those whose recorded cwd matches this before normalizing
  // (parity with quorum/capture.py). Other dialects ignore it.
  readonly launchCwd: string;
}

// New session logs since the snapshot, narrowed to this run via cwd filtering.
function capturedLogs(args: CaptureArgs): string[] {
  const newLogs = newFilesSince(args.logDir, args.logGlob, args.snapshot);
  return filterLogsByCwd(args.normalizer, newLogs, args.launchCwd);
}

export interface CaptureResult {
  // Path to the emitted ATIF trajectory.json. The file may be absent on a
  // zero-row capture: emission failures and trajectories with no tool calls
  // leave no file (so downstream loaders fail closed and the retry fires).
  readonly path: string;
  readonly sourceLogs: readonly string[];
  readonly rowCount: number;
  // How many capture passes ran (PRI-2081): 1 = first pass succeeded;
  // >1 = the empty-capture retry re-diffed after a delay.
  readonly attempts: number;
}

// A normalized trajectory tagged with its source-file order, carried into the
// merge so untimestamped steps keep their file-relative input position.
interface OrderedStep {
  // True only when the step's whole file carried no timestamp at all — those
  // files sink to the tail. A step that merely lacks its own timestamp but
  // sits in a timestamped file gets a carried effectiveTs and stays in place.
  readonly noEffectiveTs: boolean;
  readonly effectiveTs: string;
  readonly fileIndex: number;
  readonly inFileIndex: number;
  readonly step: AtifStep;
}

/**
 * Merge one ATIF trajectory per source file into a single trajectory.
 *
 * A run can produce more than one session log (gemini main + subagent chats;
 * any agent's subagent runs). Emitting from only the first log silently drops
 * every tool call recorded in the others. This merges the steps of all files
 * into one trajectory:
 *
 * - Steps from ALL dialects are ordered by ISO-8601 `timestamp`. A step that
 *   lacks its own timestamp inherits one by CARRY-FORWARD from the last
 *   timestamped step earlier in its file (carry-BACKWARD from the file's first
 *   timestamp for leading untimestamped steps), so a mid-stream untimestamped
 *   step keeps its file-relative position instead of sinking. Only a file with
 *   NO timestamps at all sinks to the tail (kept in input order). The sort key
 *   is `(noEffectiveTs, effectiveTs, fileIndex, inFileIndex)`. This is uniform
 *   across dialects; it subsumes the old gemini-only timestamp-ordering case.
 * - `step_id` is renumbered sequentially from 1 across the merged set.
 * - Each step's `tool_calls`/`observation` are kept intact; observations already
 *   reference tool_call_ids in their own step, so renumbering step_ids preserves
 *   validateTrajectory's same-step observation invariant.
 *
 * Returns null when no file yielded a trajectory with steps. The envelope
 * (schema_version, agent) is taken from the first file that has steps.
 */
function mergeTrajectories(perFile: AtifTrajectory[]): AtifTrajectory | null {
  let envelope: AtifTrajectory | undefined;
  const ordered: OrderedStep[] = [];

  for (let fileIndex = 0; fileIndex < perFile.length; fileIndex++) {
    const traj = perFile[fileIndex] as AtifTrajectory;
    const steps = traj.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      continue;
    }
    if (envelope === undefined) {
      envelope = traj;
    }

    // The file's first timestamp, used to carry BACKWARD onto any leading
    // untimestamped steps so they stay before the first timestamped step.
    let firstTs = '';
    for (const s of steps) {
      if (typeof s.timestamp === 'string' && s.timestamp !== '') {
        firstTs = s.timestamp;
        break;
      }
    }
    const fileHasTs = firstTs !== '';

    // Carry FORWARD the last-seen timestamp onto untimestamped steps so a
    // mid-stream untimestamped step inherits its predecessor's time.
    let lastTs = firstTs;
    for (let inFileIndex = 0; inFileIndex < steps.length; inFileIndex++) {
      const step = steps[inFileIndex] as AtifStep;
      const own = typeof step.timestamp === 'string' ? step.timestamp : '';
      if (own !== '') {
        lastTs = own;
      }
      ordered.push({
        noEffectiveTs: !fileHasTs,
        effectiveTs: own !== '' ? own : lastTs,
        fileIndex,
        inFileIndex,
        step,
      });
    }
  }

  if (envelope === undefined || ordered.length === 0) {
    return null;
  }

  ordered.sort((a, b) => {
    if (a.noEffectiveTs !== b.noEffectiveTs) {
      return a.noEffectiveTs ? 1 : -1;
    }
    if (a.effectiveTs !== b.effectiveTs) {
      return a.effectiveTs < b.effectiveTs ? -1 : 1;
    }
    if (a.fileIndex !== b.fileIndex) {
      return a.fileIndex - b.fileIndex;
    }
    return a.inFileIndex - b.inFileIndex;
  });

  const mergedSteps = ordered.map((item, i) => ({
    ...item.step,
    step_id: i + 1,
  }));

  return { ...envelope, steps: mergedSteps };
}

/**
 * Normalize one source log to an ATIF trajectory in-process, or null on any
 * failure — missing/unreadable log or a normalizer throw. The same fail-closed
 * signal a missing log gives, which keeps the empty-capture retry intact.
 */
function emitTrajectory(
  sourceLog: string,
  normalize: AtifNormalizer,
): AtifTrajectory | null {
  let raw: string;
  try {
    raw = readFileSync(sourceLog, 'utf8');
  } catch {
    return null;
  }
  try {
    return normalize(raw, ATIF_AGENT_VERSION);
  } catch {
    return null;
  }
}

/**
 * Normalize each new session log into an ATIF trajectory, merge them into one,
 * and write run_dir/trajectory.json.
 *
 * A run can produce more than one session log; capture normalizes EVERY new log
 * and merges their steps into a single trajectory ordered by step timestamp (see
 * mergeTrajectories). rowCount is the number of tool calls in the merged
 * trajectory. When there is no source log, all emissions fail, or the merge has
 * no tool calls, rowCount is 0 and any stale trajectory.json is removed — so
 * downstream loaders fail closed and the empty-capture retry (PRI-2081) fires.
 */
export function captureToolCalls(args: CaptureArgs): CaptureResult {
  const { normalizer, runDir } = args;
  const normalize = NORMALIZERS[normalizer];
  if (normalize === undefined) {
    throw new Error(`unknown normalizer: ${normalizer}`);
  }
  const newLogs = capturedLogs(args);
  const outPath = join(runDir, ATIF_TRAJECTORY_FILENAME);

  const perFile: AtifTrajectory[] = [];
  for (const log of newLogs) {
    const traj = emitTrajectory(log, normalize);
    if (traj !== null) {
      perFile.push(traj);
    }
  }

  const merged = mergeTrajectories(perFile);
  const rowCount = merged === null ? 0 : flattenToolCalls(merged).length;
  if (merged !== null && rowCount > 0) {
    writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);
  } else {
    // A zero-row capture must not leave a stale trajectory behind: a later
    // retry pass (or a downstream loader) must see "nothing captured".
    rmSync(outPath, { force: true });
  }

  return {
    path: outPath,
    sourceLogs: newLogs,
    rowCount,
    attempts: 1,
  };
}

/** captureToolCalls with an empty-capture retry/guard (PRI-2081).
 *
 *  A run that produced no new source logs — or logs that normalize to zero
 *  tool calls — is usually a real failure, but it is sometimes a transient
 *  race: the Coding-Agent's session log is still being flushed (or renamed into
 *  place) when the post-drive diff runs. Those races turned whole runs into
 *  permanent stage="capture" indeterminates, paying full Gauntlet + subject
 *  spend for no verdict.
 *
 *  Re-run the same snapshot diff up to `attempts` times, `delayMs` apart, until
 *  something normalizes. Each pass rewrites trajectory.json, so the artifact
 *  always reflects the final capture. The returned `attempts` field records how
 *  many passes ran; a genuinely-empty run still comes back empty (and the
 *  runner's per-backend diagnostic cascade proceeds unchanged), just
 *  `delayMs * (attempts - 1)` ms later. The sleep is synchronous
 *  (Bun.sleepSync) so the runner stays sync; tests inject a spy. */
export function captureToolCallsWithRetry(
  args: CaptureArgs,
  opts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => void;
  } = {},
): CaptureResult {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 2000;
  const sleep = opts.sleep ?? ((ms) => Bun.sleepSync(ms));
  let result = captureToolCalls(args);
  let used = 1;
  while (result.rowCount === 0 && used < attempts) {
    sleep(delayMs);
    used += 1;
    result = captureToolCalls(args);
  }
  return { ...result, attempts: used };
}

// ---------------------------------------------------------------------------
// qa-agent-misconfigured detectors
//
// codex/pi/kimi write sessions into a shared home tree. cwd-filter.ts narrows a
// post-drive diff to the run's own logs; these detectors flag the logs that were
// EXCLUDED because they landed in the wrong cwd — the smoking gun that the QA
// agent skipped `cd $QUORUM_AGENT_CWD` before launching the coding-agent. The
// Wave-2b runner uses a non-empty return to compose an indeterminate verdict
// with stage="qa-agent-misconfigured" instead of a generic capture failure.
// Each detector returns only file PATHS (never log contents), so they cannot
// leak secrets from a session log into a verdict. Ports the find_misplaced_* /
// find_unusable_* / diagnose_kimi_* helpers from quorum/{normalizers,capture}.py.
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve symlinks like Python os.path.realpath; falls back to a plain resolve
 *  when the path does not exist, so a recorded-but-absent cwd still compares. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Parse the first line of a log as JSON, or undefined on any read/parse error.
 *  The cwd-bearing header is always the first line for codex/pi. */
function firstLineEntry(path: string): unknown {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const nl = content.indexOf('\n');
  const firstLine = nl === -1 ? content : content.slice(0, nl);
  try {
    return JSON.parse(firstLine);
  } catch {
    return undefined;
  }
}

export interface DetectMisplacedCodexRolloutsArgs {
  readonly logDir: string;
  readonly logGlob: string;
  readonly snapshot: ReadonlySet<string>;
  readonly runDir: string;
  readonly launchCwd: string;
}

/** Codex rollouts whose session_meta cwd is inside runDir but != launchCwd. */
export function detectMisplacedCodexRollouts(
  args: DetectMisplacedCodexRolloutsArgs,
): string[] {
  const newLogs = newFilesSince(args.logDir, args.logGlob, args.snapshot);
  const runDirReal = realPath(args.runDir);
  const launchCwdReal = realPath(args.launchCwd);
  const misplaced: string[] = [];
  for (const path of newLogs) {
    const entry = firstLineEntry(path);
    if (!isObject(entry) || entry['type'] !== 'session_meta') {
      continue;
    }
    const payload = entry['payload'];
    const cwd = isObject(payload) ? payload['cwd'] : undefined;
    if (typeof cwd !== 'string' || cwd === '') {
      continue;
    }
    const cwdReal = realPath(cwd);
    const insideRunDir =
      cwdReal === runDirReal || cwdReal.startsWith(runDirReal + sep);
    if (insideRunDir && cwdReal !== launchCwdReal) {
      misplaced.push(path);
    }
  }
  return misplaced;
}

/** The cwd from a Pi session header, or null when not present/parseable. */
function piSessionHeaderCwd(path: string): string | null {
  const entry = firstLineEntry(path);
  if (!isObject(entry) || entry['type'] !== 'session') {
    return null;
  }
  const cwd = entry['cwd'];
  return typeof cwd === 'string' && cwd !== '' ? cwd : null;
}

export interface DetectMisplacedPiSessionsArgs {
  readonly logDir: string;
  readonly logGlob: string;
  readonly snapshot: ReadonlySet<string>;
  readonly launchCwd: string;
}

/** New Pi sessions whose header cwd realpath != launchCwd realpath. */
export function detectMisplacedPiSessions(
  args: DetectMisplacedPiSessionsArgs,
): string[] {
  const newLogs = newFilesSince(args.logDir, args.logGlob, args.snapshot);
  const launchCwdReal = realPath(args.launchCwd);
  const misplaced: string[] = [];
  for (const path of newLogs) {
    const cwd = piSessionHeaderCwd(path);
    if (cwd === null) {
      continue;
    }
    if (realPath(cwd) !== launchCwdReal) {
      misplaced.push(path);
    }
  }
  return misplaced;
}

export interface DetectUnusablePiSessionsArgs {
  readonly logDir: string;
  readonly logGlob: string;
  readonly snapshot: ReadonlySet<string>;
}

/** New Pi session files whose first row cannot identify a session cwd. */
export function detectUnusablePiSessions(
  args: DetectUnusablePiSessionsArgs,
): string[] {
  const newLogs = newFilesSince(args.logDir, args.logGlob, args.snapshot);
  return newLogs.filter((path) => piSessionHeaderCwd(path) === null);
}

// The kimi home for a wire log is the parent of the nearest ancestor dir named
// "sessions". Mirrors _kimi_home_for_log.
function kimiHomeForLog(path: string): string | undefined {
  let dir = dirname(path);
  for (;;) {
    if (basename(dir) === 'sessions') {
      return dirname(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

interface KimiIndexEntry {
  readonly sessionDir: string;
  readonly workDir: string;
}

function readKimiIndex(kimiHome: string): KimiIndexEntry[] {
  const entries: KimiIndexEntry[] = [];
  let content: string;
  try {
    content = readFileSync(join(kimiHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return entries;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObject(entry)) {
      entries.push({
        sessionDir: String(entry['sessionDir'] ?? ''),
        workDir: String(entry['workDir'] ?? ''),
      });
    }
  }
  return entries;
}

/** Kimi wire logs attributable (via session_index) to a workDir whose realpath
 *  is NOT the launch cwd — the wrong-cwd half of the kimi diagnosis. Mirrors the
 *  inclusion filter's per-home index cache but flips the workDir test. */
function indexedWrongCwdKimiLogs(paths: string[], launchCwd: string): string[] {
  const target = realPath(launchCwd);
  const indexCache = new Map<string, KimiIndexEntry[]>();
  const mismatched: string[] = [];
  for (const path of paths) {
    const kimiHome = kimiHomeForLog(path);
    if (kimiHome === undefined) {
      continue;
    }
    let index = indexCache.get(kimiHome);
    if (index === undefined) {
      index = readKimiIndex(kimiHome);
      indexCache.set(kimiHome, index);
    }
    const pathReal = realPath(path);
    for (const entry of index) {
      if (!entry.sessionDir || !entry.workDir) {
        continue;
      }
      const sessionReal = realPath(entry.sessionDir);
      const inside =
        pathReal === sessionReal || pathReal.startsWith(sessionReal + sep);
      if (inside && realPath(entry.workDir) !== target) {
        mismatched.push(path);
        break;
      }
    }
  }
  return mismatched;
}

export interface KimiUnmatchedLogsDiagnostic {
  readonly paths: string[];
  readonly reason: 'wrong-cwd' | 'unmapped';
  readonly stage: 'capture' | 'qa-agent-misconfigured';
}

export interface DiagnoseKimiUnmatchedLogsArgs {
  readonly logDir: string;
  readonly logGlob: string;
  readonly snapshot: ReadonlySet<string>;
  readonly launchCwd: string;
}

/** When new kimi logs exist but none match the launch cwd, distinguish
 *  reason="wrong-cwd" (stage qa-agent-misconfigured: a log attributable to a
 *  different workDir) from reason="unmapped" (stage capture: no index entry
 *  attributes it). Returns null when there are no new logs or one matches. */
export function diagnoseKimiUnmatchedLogs(
  args: DiagnoseKimiUnmatchedLogsArgs,
): KimiUnmatchedLogsDiagnostic | null {
  const newLogs = newFilesSince(args.logDir, args.logGlob, args.snapshot);
  if (newLogs.length === 0) {
    return null;
  }
  const matched = filterLogsByCwd('kimi', newLogs, args.launchCwd);
  if (matched.length > 0) {
    return null;
  }
  const mismatched = indexedWrongCwdKimiLogs(newLogs, args.launchCwd);
  if (mismatched.length > 0) {
    return {
      paths: mismatched,
      reason: 'wrong-cwd',
      stage: 'qa-agent-misconfigured',
    };
  }
  return { paths: newLogs, reason: 'unmapped', stage: 'capture' };
}

/** Just the wrong-cwd kimi log paths (empty unless the diagnosis is wrong-cwd). */
export function detectKimiCwdMismatch(
  args: DiagnoseKimiUnmatchedLogsArgs,
): string[] {
  const diagnostic = diagnoseKimiUnmatchedLogs(args);
  if (diagnostic === null || diagnostic.reason !== 'wrong-cwd') {
    return [];
  }
  return diagnostic.paths;
}

/** Parse an ISO-8601 timestamp string to epoch milliseconds, treating a `Z`
 *  suffix as `+00:00` (parity with Python datetime.fromisoformat). Returns null
 *  on any parse failure. */
function isoToMs(ts: string): number | null {
  const normalized = ts.endsWith('Z') ? `${ts.slice(0, -1)}+00:00` : ts;
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** First-to-last timestamp span (ms) across the given session logs, or null when
 *  no timestamps are found. Scans every JSONL row for an ISO-8601 `timestamp`
 *  string (Claude/Codex, parsed via isoToMs) AND a numeric epoch-ms `time` value
 *  (Kimi; booleans excluded), then returns max(max - min, 0). Unreadable files,
 *  blank/non-JSON lines, and non-object rows are skipped. Ports
 *  quorum/timing.py session_logs_duration_ms. */
export function sessionDurationMs(files: readonly string[]): number | null {
  const points: number[] = [];
  for (const filePath of files) {
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
        continue;
      }
      const row = rec as Record<string, unknown>;
      const ts = row['timestamp'];
      if (typeof ts === 'string') {
        const ms = isoToMs(ts);
        if (ms !== null) {
          points.push(ms);
        }
      }
      const t = row['time'];
      if (typeof t === 'number') {
        points.push(t);
      }
    }
  }
  if (points.length === 0) {
    return null;
  }
  return Math.max(Math.trunc(Math.max(...points) - Math.min(...points)), 0);
}

/** Price the new session logs with obol and write coding-agent-token-usage.json
 *  (carrying duration_ms). Returns the output path, or null when nothing could
 *  be priced. */
export async function captureTokenUsage(
  args: CaptureArgs,
): Promise<string | null> {
  const newLogs = capturedLogs(args);
  const usage = await estimateSessionLogs(args.normalizer, newLogs);
  if (usage === null) {
    return null;
  }
  const withDuration = { ...usage, duration_ms: sessionDurationMs(newLogs) };
  const outPath = join(args.runDir, 'coding-agent-token-usage.json');
  writeFileSync(outPath, `${JSON.stringify(withDuration, null, 2)}\n`);
  return outPath;
}
