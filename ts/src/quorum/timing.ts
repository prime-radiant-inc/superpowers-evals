/**
 * Wall-clock span of session logs.
 *
 * Scans every JSONL row for either an ISO-8601 `timestamp` (Claude Code, Codex)
 * or an epoch-ms numeric `time` (Kimi) and returns last - first in milliseconds.
 *
 * Port of quorum/timing.py — public API is camelCase TS, logic is identical.
 */

import * as fs from "node:fs";

/**
 * Parse an ISO-8601 timestamp string to epoch milliseconds.
 * Handles "Z" suffix by treating it as "+00:00".
 * Returns null on any parse failure.
 */
export function isoToMs(ts: string): number | null {
  try {
    const normalized = ts.endsWith("Z") ? ts.slice(0, -1) + "+00:00" : ts;
    const ms = new Date(normalized).getTime();
    if (isNaN(ms)) return null;
    return ms;
  } catch {
    return null;
  }
}

/**
 * Span in ms across all timestamps found in files, or null if none found.
 *
 * Reads each file line by line, parsing JSONL records. Collects timestamps from:
 * - `timestamp` string fields (ISO-8601, Claude Code / Codex style)
 * - `time` numeric fields (epoch-ms, Kimi style)
 *
 * Unreadable files, non-JSON lines, non-dict records, and unrecognised timestamp
 * formats are all silently skipped. Returns max(points) - min(points), floored
 * at 0; null if no timestamps were found.
 */
export function sessionLogsDurationMs(files: string[]): number | null {
  const points: number[] = [];

  for (const filePath of files) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;

      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
        continue;
      }

      const record = rec as Record<string, unknown>;

      const ts = record["timestamp"];
      if (typeof ts === "string") {
        const ms = isoToMs(ts);
        if (ms !== null) {
          points.push(ms);
        }
      }

      const t = record["time"];
      if (typeof t === "number" && typeof t !== "boolean") {
        points.push(t);
      }
    }
  }

  if (points.length === 0) return null;
  return Math.max(Math.max(...points) - Math.min(...points), 0) | 0;
}
