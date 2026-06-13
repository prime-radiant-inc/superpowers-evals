import { z } from 'zod';
import type { ToolCall } from '../contracts/verdict.ts';

// Reverse mapping: Pi tool names -> Claude Code canonical names. Mirrors
// PI_TOOL_MAP in quorum/normalizers.py. Both ls and find collapse to Glob.
const PI_TOOL_MAP: Readonly<Record<string, string>> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  find: 'Glob',
  ls: 'Glob',
};

// Pi-specific native set (NOT the global NATIVE_TOOLS). It is the PI_TOOL_MAP
// canonical values minus Bash, plus the agent/todo names. Mirrors
// PI_NATIVE_TOOLS in quorum/normalizers.py. Built once at module load so a
// drift in PI_TOOL_MAP stays in sync.
const PI_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  ...Object.values(PI_TOOL_MAP).filter((name) => name !== 'Bash'),
  'Agent',
  'subagent',
  'todo',
  'manage_todo_list',
]);

function canonicalName(name: string): string {
  return Object.hasOwn(PI_TOOL_MAP, name) ? (PI_TOOL_MAP[name] ?? name) : name;
}

function classifyPiSource(tool: string): 'native' | 'shell' {
  return PI_NATIVE_TOOLS.has(tool) ? 'native' : 'shell';
}

// A plain object is the JS analogue of Python isinstance(x, dict): a non-null
// object that is not an array.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A toolCall content block: `{ type: 'toolCall', name, arguments }`. Python
// reads name via `block.get("name", "")` and args via
// `block.get("arguments", {})`. `arguments` stays `unknown` so the subagent
// alias can inspect its raw object-ness BEFORE the emitted args are coerced to
// a record (see resolveCanonical / the loop body).
const ToolCallBlockSchema = z.object({
  type: z.literal('toolCall'),
  name: z.string().catch(''),
  arguments: z.unknown().optional(),
});

// An assistant message entry: `{ type: 'message', message: { role, content } }`.
// content is an array of blocks; non-array content yields no rows.
const MessageEntrySchema = z.object({
  type: z.literal('message'),
  message: z.object({
    role: z.string().catch(''),
    content: z.array(z.unknown()).catch([]).default([]),
  }),
});

// pi-subagents multiplexes one `subagent` tool: execution calls
// (single/chain/parallel) omit `action`; management and control calls (list,
// status, resume, ...) set it. Only execution calls launch subagents, so only
// those alias to Agent — keeping tool-count Agent 1:1 with launches, as the
// codex spawn_agent mapping does. Mirrors quorum/normalizers.py.
function resolveCanonical(name: string, rawArgs: unknown): string {
  // The subagent->Agent alias fires only when `arguments` is a plain object
  // WITHOUT an "action" key. A missing arguments key defaults to {} (so it
  // aliases to Agent); a non-object / null arguments is not a dict in the
  // Python oracle, so it does NOT alias (stays "subagent").
  if (
    name === 'subagent' &&
    isPlainObject(rawArgs) &&
    !Object.hasOwn(rawArgs, 'action')
  ) {
    return 'Agent';
  }
  return canonicalName(name);
}

// Normalize Pi JSONL session logs into `ToolCall[]`. Each non-empty line is
// parsed as `unknown`; kept only when `type === 'message'` and the message
// role is `assistant`. Each `toolCall` content block emits one row. Blank and
// malformed lines are skipped (parity with Python's JSONDecodeError continue).
// SOURCE OF TRUTH: quorum/normalizers.py normalize_pi_logs + PI_TOOL_MAP +
// PI_NATIVE_TOOLS.
export function normalizePiLogs(raw: string): ToolCall[] {
  const out: ToolCall[] = [];
  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = MessageEntrySchema.safeParse(parsed);
    if (!entry.success) {
      continue;
    }
    if (entry.data.message.role !== 'assistant') {
      continue;
    }
    for (const rawBlock of entry.data.message.content) {
      const block = ToolCallBlockSchema.safeParse(rawBlock);
      if (!block.success) {
        continue;
      }
      const { name } = block.data;
      // Python `block.get("arguments", {})`: an absent key defaults to {}; a
      // present non-object (string / null / array) is preserved verbatim by the
      // oracle but coerced to {} here to satisfy the ToolCall args contract
      // (accepted divergence). The alias decision uses the raw value.
      const rawArgs =
        block.data.arguments === undefined ? {} : block.data.arguments;
      const args: Record<string, unknown> = isPlainObject(rawArgs)
        ? { ...rawArgs }
        : {};
      const canonical = resolveCanonical(name, rawArgs);
      out.push({ tool: canonical, args, source: classifyPiSource(canonical) });
    }
  }
  return out;
}
