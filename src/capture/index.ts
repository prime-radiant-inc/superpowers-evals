import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
// dispatch table; all eight dialects produce an ATIF Trajectory. Replaces the
// old flat ToolCall[] NORMALIZERS registry.
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
// merge so untimestamped steps fall back to (file, in-file) input order.
interface OrderedStep {
  readonly noTimestamp: boolean;
  readonly timestamp: string;
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
 * - Steps are ordered by their ISO-8601 `timestamp` where present, with a STABLE
 *   fallback (file order = the input order, then in-file order) for steps that
 *   carry no timestamp. The sort key is `(noTimestamp, ts, fileIndex,
 *   inFileIndex)` — untimestamped steps sink to the end and keep their relative
 *   input position. This subsumes the old gemini timestamp-ordering special case.
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
    for (let inFileIndex = 0; inFileIndex < steps.length; inFileIndex++) {
      const step = steps[inFileIndex] as AtifStep;
      const timestamp =
        typeof step.timestamp === 'string' ? step.timestamp : '';
      ordered.push({
        noTimestamp: timestamp === '',
        timestamp,
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
    if (a.noTimestamp !== b.noTimestamp) {
      return a.noTimestamp ? 1 : -1;
    }
    if (a.timestamp !== b.timestamp) {
      return a.timestamp < b.timestamp ? -1 : 1;
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

/** First-to-last timestamp span across the given session logs. Spec 1 cannot
 *  yet decode the span (the timing module lands in Spec 2), so this returns
 *  null and the walking skeleton tolerates it. */
function sessionDurationMs(_files: readonly string[]): number | null {
  return null;
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
