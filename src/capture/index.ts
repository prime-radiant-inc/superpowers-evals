import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';
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
  const lines: string[] = [];
  for (const log of newLogs) {
    for (const rec of fn(readFileSync(log, 'utf8'))) {
      lines.push(JSON.stringify(rec));
    }
  }
  const outPath = join(runDir, 'coding-agent-tool-calls.jsonl');
  writeFileSync(outPath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return { path: outPath, sourceLogs: newLogs, rowCount: lines.length };
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
