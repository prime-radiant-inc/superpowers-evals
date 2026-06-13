import { z } from 'zod';
import type { ToolCall } from '../contracts/verdict.ts';
import { NATIVE_TOOLS } from './native-tools.ts';

// Kimi classifies by the RAW tool name: it does NOT remap names, so there is
// no TOOL_MAP and no canonicalName helper here. The native set is the GLOBAL
// NATIVE_TOOLS plus the kimi-specific extras below. Mirrors KIMI_NATIVE_TOOLS
// in quorum/normalizers.py.
const KIMI_NATIVE_EXTRAS: readonly string[] = [
  'AskUserQuestion',
  'BashOutput',
  'FetchURL',
  'TaskOutput',
  'TaskStop',
  'TodoList',
  'WebSearch',
];
const KIMI_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  ...NATIVE_TOOLS,
  ...KIMI_NATIVE_EXTRAS,
]);

// A kimi wire.jsonl entry: an object tagged
// `{ type: 'context.append_loop_event', event: { type: 'tool.call', name, args } }`.
// Anything else (e.g. a tool.result event) is skipped. `event` and `args` are
// narrowed from `unknown` so non-object shapes degrade to skip / raw_args
// wrapping rather than throwing.
const EntrySchema = z.object({
  type: z.literal('context.append_loop_event'),
  event: z.unknown().optional(),
});

const EventSchema = z.object({
  type: z.literal('tool.call'),
  name: z.unknown().optional(),
  args: z.unknown().optional(),
});

// A plain JSON object (Python `isinstance(raw_args, dict)`). Arrays and scalars
// must NOT match: zod's record only accepts string-keyed objects, which is the
// same boundary the Python oracle draws.
const PlainObjectSchema = z.record(z.unknown());

// Build the args record. A plain object is shallow-copied; anything else is
// wrapped as `{ raw_args: <value> }` (parity with the Python ternary).
function buildArgs(rawArgs: unknown): Record<string, unknown> {
  const asObject = PlainObjectSchema.safeParse(rawArgs);
  if (asObject.success) {
    return { ...asObject.data };
  }
  return { raw_args: rawArgs };
}

// Apply the Skill canonicalization: a non-empty, non-namespaced `skill` string
// gets the `superpowers:` prefix. A missing or already-namespaced skill, or a
// non-string value, is left untouched.
function canonicalizeSkill(args: Record<string, unknown>): void {
  const skill = args['skill'];
  if (typeof skill === 'string' && skill && !skill.includes(':')) {
    args['skill'] = `superpowers:${skill}`;
  }
}

// Normalize Kimi Code wire.jsonl tool calls into `ToolCall[]`. Each non-empty
// line is parsed as `unknown`; only `context.append_loop_event` entries whose
// `event` is a `tool.call` with a non-empty string `name` emit a row. Blank and
// malformed lines are skipped (parity with Python's JSONDecodeError / continue).
// SOURCE OF TRUTH: quorum/normalizers.py normalize_kimi_logs + KIMI_NATIVE_TOOLS.
export function normalizeKimiLogs(raw: string): ToolCall[] {
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
    const entry = EntrySchema.safeParse(parsed);
    if (!entry.success) {
      continue;
    }
    const event = EventSchema.safeParse(entry.data.event);
    if (!event.success) {
      continue;
    }
    const { name } = event.data;
    if (typeof name !== 'string' || !name) {
      continue;
    }
    // Python `event.get("args", {})`: an ABSENT args key defaults to {} (a truly
    // empty object), not to a {raw_args: undefined} wrap. Map undefined (absent)
    // to {} before building; a present null stays null and is wrapped.
    const rawArgs = event.data.args === undefined ? {} : event.data.args;
    const args = buildArgs(rawArgs);
    if (name === 'Skill') {
      canonicalizeSkill(args);
    }
    const source = KIMI_NATIVE_TOOLS.has(name) ? 'native' : 'shell';
    out.push({ tool: name, args, source });
  }
  return out;
}
