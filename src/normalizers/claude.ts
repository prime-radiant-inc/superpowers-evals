import { z } from 'zod';
import type { ToolCall } from '../contracts/verdict.ts';

/**
 * Tools the harness considers "native"; everything else is "shell". Global set,
 * matches the Python `NATIVE_TOOLS` (quorum/normalizers.py). Claude does not
 * remap tool names, so membership is checked against the raw name.
 */
export const NATIVE_TOOLS: ReadonlySet<string> = new Set([
  'EnterWorktree',
  'ExitWorktree',
  'EnterPlanMode',
  'ExitPlanMode',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'Skill',
  'Agent',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
]);

// A single tool_use block: `{ type: 'tool_use', name, input }`. `input` is
// optional and defaults to `{}` (Python uses `block.get("input", {})`); a
// non-object `input` is tolerated by falling back to `{}` rather than throwing.
const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  name: z.string(),
  input: z.record(z.unknown()).catch({}).default({}),
});

// Flat shape: a top-level entry that is itself a tool_use block.
const FlatEntrySchema = ToolUseBlockSchema;

// Nested shape: `{ type: 'assistant', message: { content: [...blocks] } }`.
// The content array is permissive — only tool_use blocks are kept; text and
// other block kinds are ignored.
const AssistantEntrySchema = z.object({
  type: z.literal('assistant'),
  message: z
    .object({ content: z.array(z.unknown()).default([]) })
    .default({ content: [] }),
});

function toCall(name: string, input: Record<string, unknown>): ToolCall {
  return {
    tool: name,
    args: input,
    source: NATIVE_TOOLS.has(name) ? 'native' : 'shell',
  };
}

/**
 * Normalize Claude Code session-log JSONL into `ToolCall[]`. Each non-empty
 * line is parsed as `unknown`, then narrowed by zod into one of the two known
 * shapes. Blank and malformed lines are skipped. Names are not remapped.
 */
export function normalizeClaudeLogs(raw: string): ToolCall[] {
  const out: ToolCall[] = [];
  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed JSON lines are skipped (parity with Python's
      // JSONDecodeError continue).
      continue;
    }

    const nested = AssistantEntrySchema.safeParse(parsed);
    if (nested.success) {
      for (const block of nested.data.message.content) {
        const tu = ToolUseBlockSchema.safeParse(block);
        if (tu.success) {
          out.push(toCall(tu.data.name, tu.data.input));
        }
      }
      continue;
    }

    const flat = FlatEntrySchema.safeParse(parsed);
    if (flat.success) {
      out.push(toCall(flat.data.name, flat.data.input));
    }
  }
  return out;
}
