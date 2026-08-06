// Codex dialect: per-thread seats from the rollout logs.
//
// Layout, both of which appear in results/:
//   <run>/home/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//   <run>/coding-agent-config/sessions/YYYY/MM/DD/rollout-*.jsonl
//
// One file per thread. The first row is `session_meta`; a spawned thread's
// payload.source.subagent.thread_spawn carries {parent_thread_id, depth,
// agent_path}, and the controller has thread_source "user" with no thread_spawn.
//
// The hard part is getting a shell command out of a tool call. The modern Codex
// `exec` tool takes a JS SNIPPET, not arguments:
//
//   const r = await tools.exec_command({cmd:"npm test", workdir:"…"});
//   const patch = "*** Begin Patch\n…"; await tools.apply_patch({patch});
//   const cmds=["npm test","npm run check"];
//   await Promise.all(cmds.map(cmd=>tools.exec_command({cmd,workdir:wd})));
//
// Regexing that whole payload is what made the prototype count 453 patch
// bodies as suite runs: a task report's TDD-evidence section quotes the very
// commands the implementer ran. So `tools.apply_patch(…)` is never read for
// commands, and only the `cmd` field of `tools.exec_command(…)` is.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCodexRole } from './roles.ts';
import {
  orderThreads,
  type ParsedThread,
  readJsonl,
  shellEvent,
} from './thread.ts';
import type { SeatEvent } from './types.ts';

const SESSION_ROOTS = [
  join('home', '.codex', 'sessions'),
  join('coding-agent-config', 'sessions'),
];

/** Rollout files under a run dir, across both config layouts. */
function rolloutFiles(runDir: string): string[] {
  const out: string[] = [];
  for (const root of SESSION_ROOTS) {
    walk(join(runDir, root), out);
  }
  return out.filter((path) => /rollout-.*\.jsonl$/.test(path));
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else {
      out.push(path);
    }
  }
}

/** True when the run has Codex rollout logs. The `sessions` directory name is
 *  shared with other agents (Claude and pi both write one), so presence of the
 *  directory is not enough — a rollout-*.jsonl file has to exist. */
export function hasCodexLogs(runDir: string): boolean {
  return rolloutFiles(runDir).length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

// --- exec-snippet command extraction ----------------------------------------

/** Read the JS string literal starting at `pos` ('…', "…", or `…`), applying
 *  the escapes that matter for shell text. Returns null when `pos` does not
 *  start a literal — which is how a `{cmd, …}` shorthand is detected. */
function readStringLiteral(src: string, pos: number): string | null {
  const quote = src[pos];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return null;
  }
  const out: string[] = [];
  let escaped = false;
  for (let i = pos + 1; i < src.length; i += 1) {
    const ch = src[i] ?? '';
    if (escaped) {
      out.push(ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch);
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) {
      return out.join('');
    }
    out.push(ch);
  }
  return null;
}

/** Advance past the balanced `open`/`close` pair starting at `start`, ignoring
 *  brackets that sit inside string literals. Returns the index of the closer,
 *  or -1 when unbalanced. */
function matchBracket(
  src: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

const CMD_KEY =
  /(?:"cmd"|'cmd'|\bcmd\b|"command"|'command'|\bcommand\b)\s*:\s*/;
const CMD_ARRAY = /\b(?:const|let|var)\s+cmds?\s*=\s*\[/g;

/** Every string literal in a `[…]` array literal starting at `start`. */
function arrayStringLiterals(src: string, start: number): string[] {
  const end = matchBracket(src, start, '[', ']');
  if (end < 0) {
    return [];
  }
  const body = src.slice(start, end + 1);
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? '';
    if (ch === '"' || ch === "'" || ch === '`') {
      const literal = readStringLiteral(body, i);
      if (literal === null) {
        break;
      }
      out.push(literal);
      // Skip the literal's source span.
      let j = i + 1;
      let escaped = false;
      for (; j < body.length; j += 1) {
        const c = body[j] ?? '';
        if (escaped) {
          escaped = false;
        } else if (c === '\\') {
          escaped = true;
        } else if (c === ch) {
          break;
        }
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

export interface ExecSnippet {
  /** Inner tool names the snippet invoked, in order (`exec_command`,
   *  `apply_patch`, `update_plan`, `write_stdin`, `view_image`). */
  readonly innerTools: readonly string[];
  /** Shell commands the snippet actually ran. */
  readonly commands: readonly string[];
}

/**
 * Pull the shell commands out of an `exec` tool call's JS snippet.
 *
 * `tools.apply_patch(…)` is deliberately never read: its argument is a patch
 * body, i.e. file CONTENT, and content that quotes a test command is not a test
 * run. `tools.update_plan(…)`, `write_stdin`, and `view_image` are ignored for
 * the same reason.
 *
 * Two `cmd` shapes exist. The common one is a literal
 * (`{cmd:"npm test", …}` / `{"cmd":"npm test", …}`). The other is the shorthand
 * `{cmd, workdir}` inside `cmds.map(cmd => tools.exec_command({cmd, …}))`,
 * where the commands live in a `const cmds=[…]` array; that array is harvested
 * so a batched `["npm test","npm run check"]` verification is not lost.
 */
export function extractExecCommands(input: string): ExecSnippet {
  const innerTools = [...input.matchAll(/tools\.(\w+)\s*\(/g)].map(
    (m) => m[1] ?? '',
  );
  const commands: string[] = [];
  let needsArrayFallback = false;
  const marker = 'tools.exec_command(';
  let cursor = 0;
  for (;;) {
    const at = input.indexOf(marker, cursor);
    if (at < 0) {
      break;
    }
    const braceAt = input.indexOf('{', at + marker.length);
    if (braceAt < 0) {
      break;
    }
    const end = matchBracket(input, braceAt, '{', '}');
    if (end < 0) {
      break;
    }
    const objectSrc = input.slice(braceAt, end + 1);
    const key = CMD_KEY.exec(objectSrc);
    const literal =
      key === null
        ? null
        : readStringLiteral(objectSrc, key.index + key[0].length);
    if (literal === null) {
      needsArrayFallback = true;
    } else {
      commands.push(literal);
    }
    cursor = end + 1;
  }
  if (needsArrayFallback) {
    CMD_ARRAY.lastIndex = 0;
    for (const match of input.matchAll(CMD_ARRAY)) {
      commands.push(
        ...arrayStringLiterals(input, match.index + match[0].length - 1),
      );
    }
  }
  return { innerTools, commands };
}

// --- thread parsing ---------------------------------------------------------

interface ThreadSpawn {
  readonly parentId: string | null;
  readonly depth: number | null;
  readonly agentPath: string | null;
  /** "worker" / "default". The only label older CLIs recorded. */
  readonly agentRole: string | null;
}

function readThreadSpawn(meta: Record<string, unknown>): ThreadSpawn | null {
  const source = asRecord(meta['source']);
  if (source === null) {
    // The controller's `source` is the string "cli".
    return null;
  }
  const spawn = asRecord(asRecord(source['subagent'])?.['thread_spawn']);
  if (spawn === null) {
    return null;
  }
  const parent = spawn['parent_thread_id'];
  const depth = spawn['depth'];
  const agentPath = spawn['agent_path'];
  const agentRole = spawn['agent_role'];
  return {
    parentId: typeof parent === 'string' ? parent : null,
    depth: typeof depth === 'number' ? depth : null,
    agentPath: typeof agentPath === 'string' ? agentPath : null,
    agentRole: typeof agentRole === 'string' ? agentRole : null,
  };
}

function toolCommands(
  payload: Record<string, unknown>,
): { tool: string; commands: string[] } | null {
  const type = payload['type'];
  const name =
    typeof payload['name'] === 'string' ? payload['name'] : 'unknown';
  if (type === 'custom_tool_call' && name === 'exec') {
    const input = payload['input'];
    const snippet = extractExecCommands(typeof input === 'string' ? input : '');
    // Name the event after what the snippet actually did — an exec that only
    // applies a patch reads as `apply_patch`.
    const tool =
      snippet.commands.length > 0
        ? 'exec_command'
        : (snippet.innerTools[0] ?? 'exec');
    return { tool, commands: [...snippet.commands] };
  }
  if (type === 'function_call' && name === 'exec_command') {
    const args = payload['arguments'];
    if (typeof args !== 'string') {
      return { tool: name, commands: [] };
    }
    try {
      const parsed = asRecord(JSON.parse(args));
      const value = parsed?.['cmd'] ?? parsed?.['command'];
      if (typeof value === 'string') {
        return { tool: name, commands: [value] };
      }
      if (Array.isArray(value)) {
        return { tool: name, commands: [value.map(String).join(' ')] };
      }
    } catch {
      // Malformed arguments: record the call, claim no command.
    }
    return { tool: name, commands: [] };
  }
  if (type === 'custom_tool_call' || type === 'function_call') {
    return { tool: name, commands: [] };
  }
  return null;
}

/**
 * The raw label the seat role was read from.
 *
 * Codex CLI 0.134.0 and 0.144.3 recorded thread_spawn with `agent_path: null`
 * and only `agent_role` ("worker" / "default"): 968 of the recorded sdd seats
 * look like that. agent_role cannot distinguish a task reviewer from a final
 * reviewer, so it never becomes a role — but keeping it as the label means the
 * unclassifiable seats are still analyzable downstream instead of blank.
 */
function seatLabel(spawn: ThreadSpawn | null): string {
  if (spawn === null) {
    return '';
  }
  if (spawn.agentPath !== null) {
    return spawn.agentPath;
  }
  return spawn.agentRole === null ? '' : `agent_role:${spawn.agentRole}`;
}

/**
 * Every Codex thread in the run, as a seat, ordered by first timestamp.
 *
 * Patch events come from `event_msg` `patch_apply_end` rows, not from
 * apply_patch calls: 1579 apply_patch calls in the corpus produced 1570
 * patch_apply_end rows, so nine patches were rejected and never touched the
 * tree. Redundancy adjudication must not be reset by a patch that did not land.
 */
export function parseCodexThreads(runDir: string): ParsedThread[] {
  const threads: ParsedThread[] = [];
  for (const path of rolloutFiles(runDir)) {
    const rows = readJsonl(path);
    const first = rows[0];
    if (first === undefined) {
      continue;
    }
    const meta = asRecord(first['payload']) ?? {};
    const spawn = readThreadSpawn(meta);
    const threadId = meta['id'];
    const seatId = typeof threadId === 'string' ? threadId : path;
    const events: SeatEvent[] = [];
    const models: string[] = [];
    let firstTimestamp: string | null = null;
    for (const row of rows) {
      const ts = typeof row['timestamp'] === 'string' ? row['timestamp'] : '';
      if (ts !== '' && (firstTimestamp === null || ts < firstTimestamp)) {
        firstTimestamp = ts;
      }
      const payload = asRecord(row['payload']);
      if (payload === null) {
        continue;
      }
      if (row['type'] === 'turn_context') {
        const model = payload['model'];
        if (typeof model === 'string' && !models.includes(model)) {
          models.push(model);
        }
        continue;
      }
      if (
        row['type'] === 'event_msg' &&
        payload['type'] === 'patch_apply_end'
      ) {
        events.push({ kind: 'patch', tool: 'patch_apply_end', timestamp: ts });
        continue;
      }
      if (row['type'] !== 'response_item') {
        continue;
      }
      const call = toolCommands(payload);
      if (call === null) {
        continue;
      }
      if (call.commands.length === 0) {
        events.push({ kind: 'tool_call', tool: call.tool, timestamp: ts });
        continue;
      }
      for (const command of call.commands) {
        events.push(shellEvent(call.tool, command, ts));
      }
    }
    threads.push({
      seatId,
      role: spawn === null ? 'controller' : classifyCodexRole(spawn.agentPath),
      taskLabel: seatLabel(spawn),
      spawnDepth: spawn?.depth ?? null,
      parentId: spawn?.parentId ?? null,
      models,
      events,
      firstTimestamp: firstTimestamp ?? '',
    });
  }
  return orderThreads(threads);
}
