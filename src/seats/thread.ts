// Shared shapes and helpers for the two dialect parsers.

import { existsSync, readFileSync } from 'node:fs';
import {
  isEvidenceRead,
  matchSuiteRuns,
  normalizeCommand,
  type SuiteFamily,
  type SuiteScope,
} from './test-commands.ts';
import type { RoleSource, SeatEvent, SeatRole } from './types.ts';

/** One parsed thread, before run-level metadata is attached. */
export interface ParsedThread {
  readonly seatId: string;
  readonly role: SeatRole;
  /** Which signal produced `role`. */
  readonly roleSource: RoleSource;
  readonly taskLabel: string;
  readonly spawnDepth: number | null;
  readonly parentId: string | null;
  readonly models: readonly string[];
  readonly events: readonly SeatEvent[];
  /** The thread's earliest row timestamp; threads are ordered by it. */
  readonly firstTimestamp: string;
}

/** Read a whole JSON file, or null when it is missing or malformed. */
export function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Parse a JSONL log, skipping blank and unparseable lines. A truncated final
 *  line is normal in a killed run and must not abort the scan. */
export function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A partial trailing line, or a log the CLI corrupted. Skip it.
    }
  }
  return rows;
}

/** Build a shell tool_call event, tagging it with whatever the command did. */
export function shellEvent(
  tool: string,
  command: string,
  timestamp: string,
): SeatEvent {
  const normalized = normalizeCommand(command);
  const matches = matchSuiteRuns(normalized);
  if (matches.length === 0) {
    return isEvidenceRead(command)
      ? { kind: 'tool_call', tool, command, timestamp, isEvidenceRead: true }
      : { kind: 'tool_call', tool, command, timestamp };
  }
  const families: SuiteFamily[] = matches.map((m) => m.family);
  // One shell line can run several families. The scope reported is the
  // BROADEST one: a line that ran a package-wide suite ran a package-wide
  // suite, whatever else it also did.
  const scope: SuiteScope = matches.some((m) => m.scope === 'full')
    ? 'full'
    : 'focused';
  return {
    kind: 'tool_call',
    tool,
    command,
    timestamp,
    isSuiteRun: true,
    suiteScope: scope,
    suiteFamilies: families,
  };
}

/** Order threads by first row timestamp, then by seat id so the result is
 *  stable when two threads start in the same millisecond. */
export function orderThreads(threads: ParsedThread[]): ParsedThread[] {
  return [...threads].sort((a, b) => {
    if (a.firstTimestamp !== b.firstTimestamp) {
      return a.firstTimestamp < b.firstTimestamp ? -1 : 1;
    }
    return a.seatId < b.seatId ? -1 : 1;
  });
}
