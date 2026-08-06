// Claude Code dialect: per-thread seats from the session log tree.
//
// Layout, both of which appear in results/:
//   <run>/coding-agent-config/projects/<slug>/    (CLAUDE_CONFIG_DIR — 230 runs)
//   <run>/home/.claude/projects/<slug>/           (a real $HOME — 33 runs)
//
// Inside a project dir:
//   <uuid>.jsonl                            the controller thread
//   <uuid>/subagents/agent-<id>.jsonl       one file per child thread
//   <uuid>/subagents/agent-<id>.meta.json   the child's seat label
//
// The child's meta.json carries `toolUseId`, the id of the controller's Agent
// tool_use block that spawned it. That is the only exact parent link available,
// so parentId is resolved by looking that id up across every thread in the run
// — which also gets depth-2 nesting right without special-casing it.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { classifyClaudeRole } from './roles.ts';
import {
  orderThreads,
  type ParsedThread,
  readJsonFile,
  readJsonl,
  shellEvent,
} from './thread.ts';
import type { SeatEvent } from './types.ts';

const PROJECT_ROOTS = [
  join('coding-agent-config', 'projects'),
  join('home', '.claude', 'projects'),
];

// Tools that mutate the tree. Everything else is a plain tool call.
const PATCH_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

// Tools whose input is a shell command.
const SHELL_TOOLS = new Set(['Bash', 'BashOutput']);

/** Project dirs under a run dir, across both config layouts. */
function projectDirs(runDir: string): string[] {
  const out: string[] = [];
  for (const root of PROJECT_ROOTS) {
    const dir = join(runDir, root);
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      const candidate = join(dir, name);
      if (statSync(candidate).isDirectory()) {
        out.push(candidate);
      }
    }
  }
  return out;
}

/** True when the run has a Claude session tree at all. */
export function hasClaudeLogs(runDir: string): boolean {
  return projectDirs(runDir).length > 0;
}

interface RawThread {
  readonly seatId: string;
  readonly label: string;
  readonly spawnDepth: number | null;
  readonly toolUseId: string | null;
  readonly isController: boolean;
  readonly rows: readonly Record<string, unknown>[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readMeta(metaPath: string): {
  label: string;
  spawnDepth: number | null;
  toolUseId: string | null;
} {
  const meta = readJsonFile(metaPath) ?? {};
  const depth = meta['spawnDepth'];
  const toolUseId = meta['toolUseId'];
  return {
    label: typeof meta['description'] === 'string' ? meta['description'] : '',
    spawnDepth: typeof depth === 'number' ? depth : null,
    toolUseId: typeof toolUseId === 'string' ? toolUseId : null,
  };
}

function collectRawThreads(runDir: string): RawThread[] {
  const out: RawThread[] = [];
  for (const projectDir of projectDirs(runDir)) {
    for (const name of readdirSync(projectDir)) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      const sessionId = name.slice(0, -'.jsonl'.length);
      out.push({
        seatId: sessionId,
        label: '',
        spawnDepth: null,
        toolUseId: null,
        isController: true,
        rows: readJsonl(join(projectDir, name)),
      });
      const subagents = join(projectDir, sessionId, 'subagents');
      if (!existsSync(subagents)) {
        continue;
      }
      for (const child of readdirSync(subagents)) {
        if (!child.endsWith('.jsonl')) {
          continue;
        }
        const meta = readMeta(
          join(subagents, `${child.slice(0, -'.jsonl'.length)}.meta.json`),
        );
        const rows = readJsonl(join(subagents, child));
        // The agentId on the rows is the authoritative seat id; the filename
        // carries it too (agent-<id>.jsonl) as a fallback for an empty log.
        const firstAgentId = rows
          .map((row) => row['agentId'])
          .find((id): id is string => typeof id === 'string');
        out.push({
          seatId:
            firstAgentId ?? basename(child, '.jsonl').replace(/^agent-/, ''),
          label: meta.label,
          spawnDepth: meta.spawnDepth,
          toolUseId: meta.toolUseId,
          isController: false,
          rows,
        });
      }
    }
  }
  return out;
}

function timestampOf(row: Record<string, unknown>): string | null {
  const ts = row['timestamp'];
  return typeof ts === 'string' ? ts : null;
}

function eventsAndModels(rows: readonly Record<string, unknown>[]): {
  events: SeatEvent[];
  models: string[];
  /** toolUseId -> true for every tool_use block this thread issued. */
  issuedToolUseIds: Set<string>;
  firstTimestamp: string;
} {
  const events: SeatEvent[] = [];
  const models: string[] = [];
  const issuedToolUseIds = new Set<string>();
  let firstTimestamp: string | null = null;
  for (const row of rows) {
    const ts = timestampOf(row);
    if (ts !== null && (firstTimestamp === null || ts < firstTimestamp)) {
      firstTimestamp = ts;
    }
    const message = asRecord(row['message']);
    if (message === null) {
      continue;
    }
    const model = message['model'];
    // '<synthetic>' marks a message the CLI fabricated (an interrupt notice),
    // not a model the seat ran on.
    if (
      typeof model === 'string' &&
      model !== '<synthetic>' &&
      !models.includes(model)
    ) {
      models.push(model);
    }
    if (row['type'] !== 'assistant') {
      continue;
    }
    const content = message['content'];
    if (!Array.isArray(content)) {
      continue;
    }
    for (const raw of content) {
      const block = asRecord(raw);
      if (block === null || block['type'] !== 'tool_use') {
        continue;
      }
      const id = block['id'];
      if (typeof id === 'string') {
        issuedToolUseIds.add(id);
      }
      const name =
        typeof block['name'] === 'string' ? block['name'] : 'unknown';
      const timestamp = ts ?? '';
      if (PATCH_TOOLS.has(name)) {
        events.push({ kind: 'patch', tool: name, timestamp });
        continue;
      }
      const input = asRecord(block['input']);
      const command = input === null ? undefined : input['command'];
      if (SHELL_TOOLS.has(name) && typeof command === 'string') {
        events.push(shellEvent(name, command, timestamp));
        continue;
      }
      events.push({ kind: 'tool_call', tool: name, timestamp });
    }
  }
  return {
    events,
    models,
    issuedToolUseIds,
    firstTimestamp: firstTimestamp ?? '',
  };
}

/**
 * Every Claude thread in the run, as a seat, ordered by first timestamp.
 *
 * Returns [] when the run has no Claude session tree (so the caller can try the
 * other dialect).
 */
export function parseClaudeThreads(runDir: string): ParsedThread[] {
  const raws = collectRawThreads(runDir);
  if (raws.length === 0) {
    return [];
  }
  const parsed = raws.map((raw) => ({
    raw,
    ...eventsAndModels(raw.rows),
  }));
  // toolUseId -> the seat that issued it, for the exact parent link.
  const issuer = new Map<string, string>();
  for (const entry of parsed) {
    for (const id of entry.issuedToolUseIds) {
      issuer.set(id, entry.raw.seatId);
    }
  }
  return orderThreads(
    parsed.map(({ raw, events, models, firstTimestamp }) => ({
      seatId: raw.seatId,
      role: raw.isController ? 'controller' : classifyClaudeRole(raw.label),
      taskLabel: raw.label,
      spawnDepth: raw.spawnDepth,
      parentId:
        raw.toolUseId === null ? null : (issuer.get(raw.toolUseId) ?? null),
      models,
      events,
      firstTimestamp,
    })),
  );
}
