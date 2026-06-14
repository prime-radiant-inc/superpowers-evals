import { z } from 'zod';
import type { ToolCall } from '../contracts/verdict.ts';
import { classifySource } from './native-tools.ts';

// Reverse mapping: Gemini CLI tool names -> Claude Code canonical names.
// Transcribed verbatim from GEMINI_TOOL_MAP in quorum/normalizers.py. Note the
// divergence: google_web_search/web_fetch/write_todos map to WebSearch/WebFetch/
// TodoWrite, which are NOT in the global NATIVE_TOOLS set, so they classify as
// shell; enter_plan_mode/exit_plan_mode map to EnterPlanMode/ExitPlanMode, which
// ARE global-native.
const GEMINI_TOOL_MAP: Readonly<Record<string, string>> = {
  run_shell_command: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  grep_search: 'Grep',
  glob: 'Glob',
  activate_skill: 'Skill',
  google_web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  write_todos: 'TodoWrite',
  list_directory: 'Glob',
  enter_plan_mode: 'EnterPlanMode',
  exit_plan_mode: 'ExitPlanMode',
};

function canonicalName(name: string): string {
  return Object.hasOwn(GEMINI_TOOL_MAP, name)
    ? (GEMINI_TOOL_MAP[name] ?? name)
    : name;
}

// A Gemini message carries a `type` discriminator and (when type === 'gemini')
// a toolCalls array. Each tool call has a name, optional args record, and an
// optional id used for dedup. Non-object entries are skipped upstream.
const ToolCallEntrySchema = z.object({
  id: z.unknown().optional(),
  name: z.string().catch(''),
  args: z.record(z.unknown()).catch({}).default({}),
});

const MessageSchema = z.object({
  type: z.string().catch(''),
  toolCalls: z.array(z.unknown()).catch([]).default([]),
  timestamp: z.unknown().optional(),
  createdAt: z.unknown().optional(),
  time: z.unknown().optional(),
});

// Per-message timestamp, stringified (Python: _gemini_timestamp). Falls back
// through timestamp -> createdAt -> time; a string passes through, a number is
// stringified, anything else (or absent) yields ''.
function messageTimestamp(message: z.infer<typeof MessageSchema>): string {
  const value = message.timestamp ?? message.createdAt ?? message.time;
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return '';
}

// The whole-input JSON document may be an object with a `messages` array, a bare
// object, or an array. We narrow each shape and collect only the object members.
const DocumentSchema = z.object({
  messages: z.array(z.unknown()).optional(),
});

// Coerce an arbitrary parsed JSON value into the list of candidate message
// objects, mirroring the Python branch structure of normalize_gemini_logs.
function collectMessages(data: unknown): unknown[] {
  const doc = DocumentSchema.safeParse(data);
  if (doc.success && doc.data.messages !== undefined) {
    return doc.data.messages.filter((m) => isObject(m));
  }
  if (isObject(data)) {
    return [data];
  }
  if (Array.isArray(data)) {
    return data.filter((m) => isObject(m));
  }
  return [];
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Parse the raw session log into candidate message objects. Try JSON.parse on
// the WHOLE input first (single JSON document form); on failure fall back to
// JSONL, parsing each non-blank line and keeping only object entries. Blank and
// malformed lines are skipped (parity with Python's JSONDecodeError continue).
function parseMessages(raw: string): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    const messages: unknown[] = [];
    for (const line of raw.trim().split('\n')) {
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
        messages.push(entry);
      }
    }
    return messages;
  }
  return collectMessages(data);
}

// Normalize a single gemini tool-call entry into a ToolCall (Python:
// _normalize_gemini_tool_call). Skill canonicalization: gemini's activate_skill
// carries the skill under `name` (or `skill`); clone args and mint a namespaced
// `skill` arg so downstream matches Claude's shape. A skill that already carries
// a ':' namespace is passed through verbatim.
function normalizeToolCall(
  name: string,
  rawArgs: Record<string, unknown>,
): ToolCall {
  const canonical = canonicalName(name);
  const args: Record<string, unknown> = { ...rawArgs };
  if (canonical === 'Skill') {
    const skill = args['skill'] ?? args['name'];
    if (typeof skill === 'string' && skill) {
      args['skill'] = skill.includes(':') ? skill : `superpowers:${skill}`;
    }
  }
  return { tool: canonical, args, source: classifySource(canonical) };
}

// Normalize Gemini CLI session logs into `[timestamp, ToolCall][]`, carrying the
// per-message timestamp so capture can interleave subagent + main logs in event
// order (Python: normalize_gemini_logs_with_order). Input is EITHER a single
// JSON document (optionally `{messages: [...]}`) OR JSONL. Only messages with
// type === 'gemini' contribute; their toolCalls are deduped by id (a call whose
// id was already seen is skipped; a call without an id is never skipped).
export function normalizeGeminiLogsWithOrder(
  raw: string,
): [string, ToolCall][] {
  const out: [string, ToolCall][] = [];
  const seen = new Set<unknown>();
  for (const rawMessage of parseMessages(raw)) {
    const message = MessageSchema.safeParse(rawMessage);
    if (!message.success || message.data.type !== 'gemini') {
      continue;
    }
    const timestamp = messageTimestamp(message.data);
    for (const rawCall of message.data.toolCalls) {
      const call = ToolCallEntrySchema.safeParse(rawCall);
      if (!call.success) {
        continue;
      }
      // Python keys the seen-set on the raw id value via truthiness
      // (`if tool_call_id`): a truthy id (string OR number) dedups; a falsy id
      // (undefined / null / '' / 0 / false) bypasses the set and is always
      // emitted. id stays `unknown` so a non-string id does NOT drop the whole
      // call (it would under a string-only schema). Accepted divergences vs the
      // oracle: a non-object `args` coerces to {} and a non-string `name`
      // coerces to '' (the ToolCall contract types args as Record, tool as
      // string; real gemini logs never emit either).
      const { id } = call.data;
      if (id) {
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
      }
      out.push([timestamp, normalizeToolCall(call.data.name, call.data.args)]);
    }
  }
  return out;
}

// Normalize Gemini CLI session logs into `ToolCall[]` (drops the per-message
// timestamps). SOURCE OF TRUTH: quorum/normalizers.py normalize_gemini_logs +
// GEMINI_TOOL_MAP.
export function normalizeGeminiLogs(raw: string): ToolCall[] {
  return normalizeGeminiLogsWithOrder(raw).map(([, row]) => row);
}
