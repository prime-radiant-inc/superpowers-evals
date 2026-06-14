import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';
import { normalizeGeminiLogsWithOrder } from '../normalizers/gemini.ts';
import { NORMALIZERS } from '../normalizers/index.ts';
import { estimateSessionLogs } from '../obol/index.ts';
import { filterLogsByCwd } from './cwd-filter.ts';

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
  readonly path: string;
  readonly sourceLogs: readonly string[];
  readonly rowCount: number;
  // How many capture passes ran (PRI-2081): 1 = first pass succeeded;
  // >1 = the empty-capture retry re-diffed after a delay.
  readonly attempts: number;
}

// A gemini row tagged with its sort key (Python: the (not bool(timestamp),
// timestamp, source_index, row_index) tuple). `untimestamped` sinks rows with no
// timestamp to the end; ties break by source-log order then within-log order.
interface GeminiOrderedRow {
  readonly untimestamped: boolean;
  readonly timestamp: string;
  readonly sourceIndex: number;
  readonly rowIndex: number;
  readonly line: string;
}

// Normalize gemini session logs across all new files and serialize them in
// per-message timestamp order rather than path order (Python: the
// normalizer == "gemini" branch in capture_tool_calls). Subagent and main logs
// interleave by the timestamp each toolCall's message carries.
function geminiOrderedLines(newLogs: readonly string[]): string[] {
  const rows: GeminiOrderedRow[] = [];
  newLogs.forEach((log, sourceIndex) => {
    normalizeGeminiLogsWithOrder(readFileSync(log, 'utf8')).forEach(
      ([timestamp, rec], rowIndex) => {
        rows.push({
          untimestamped: timestamp === '',
          timestamp,
          sourceIndex,
          rowIndex,
          line: JSON.stringify(rec),
        });
      },
    );
  });
  rows.sort((a, b) => {
    if (a.untimestamped !== b.untimestamped) {
      return a.untimestamped ? 1 : -1;
    }
    if (a.timestamp !== b.timestamp) {
      return a.timestamp < b.timestamp ? -1 : 1;
    }
    if (a.sourceIndex !== b.sourceIndex) {
      return a.sourceIndex - b.sourceIndex;
    }
    return a.rowIndex - b.rowIndex;
  });
  return rows.map((row) => row.line);
}

/** Normalize each new session log into tool calls and write
 *  coding-agent-tool-calls.jsonl. The file is always written, even when empty,
 *  so downstream consumers can assume it exists. */
export function captureToolCalls(args: CaptureArgs): CaptureResult {
  const { normalizer, runDir } = args;
  const newLogs = capturedLogs(args);
  const fn = NORMALIZERS[normalizer];
  if (fn === undefined) {
    throw new Error(`unknown normalizer: ${normalizer}`);
  }
  const lines: string[] =
    normalizer === 'gemini'
      ? geminiOrderedLines(newLogs)
      : newLogs.flatMap((log) =>
          fn(readFileSync(log, 'utf8')).map((rec) => JSON.stringify(rec)),
        );
  const outPath = join(runDir, 'coding-agent-tool-calls.jsonl');
  writeFileSync(outPath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return {
    path: outPath,
    sourceLogs: newLogs,
    rowCount: lines.length,
    attempts: 1,
  };
}

/** captureToolCalls with an empty-capture retry/guard (PRI-2081).
 *
 *  A run that produced no new source logs — or logs that normalize to zero
 *  rows — is usually a real failure, but it is sometimes a transient race: the
 *  Coding-Agent's session log is still being flushed (or renamed into place)
 *  when the post-drive diff runs. Those races turned whole runs into permanent
 *  stage="capture" indeterminates, paying full Gauntlet + subject spend for no
 *  verdict.
 *
 *  Re-run the same snapshot diff up to `attempts` times, `delayMs` apart, until
 *  something normalizes. Each pass rewrites coding-agent-tool-calls.jsonl, so
 *  the artifact always reflects the final capture. The returned `attempts`
 *  field records how many passes ran; a genuinely-empty run still comes back
 *  empty (and the runner's per-backend diagnostic cascade proceeds unchanged),
 *  just `delayMs * (attempts - 1)` ms later. The sleep is synchronous
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
