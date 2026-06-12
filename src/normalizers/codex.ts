import { z } from 'zod';
import type { ToolCall } from '../contracts/verdict.ts';
import { classifySource } from './native-tools.ts';

// Reverse mapping: Codex tool names -> Claude Code canonical names. Only
// spawn_agent aliases to Agent (1:1 with a subagent launch). wait_agent and
// close_agent are the async-protocol join/teardown halves; aliasing them too
// would inflate tool-count Agent threefold and break the codex-tool-mapping
// scenarios that grep for the raw codex names. Mirrors CODEX_TOOL_MAP in
// quorum/normalizers.py.
const CODEX_TOOL_MAP: Readonly<Record<string, string>> = {
  spawn_agent: 'Agent',
};

function canonicalName(name: string): string {
  return Object.hasOwn(CODEX_TOOL_MAP, name)
    ? (CODEX_TOOL_MAP[name] ?? name)
    : name;
}

// A codex rollout entry: `{ type: 'response_item', payload: ... }`. Current
// runs carry the tool under `payload`; older runs use `item` — Python reads
// `entry.get("payload", entry.get("item", {}))`, so we accept either.
const EntrySchema = z.object({
  type: z.literal('response_item'),
  payload: z.unknown().optional(),
  item: z.unknown().optional(),
});

// function_call: `arguments` is a JSON-encoded STRING; non-string is used
// as-is (Python `if isinstance(raw_args, str)`).
const FunctionCallSchema = z.object({
  type: z.literal('function_call'),
  name: z.string().catch(''),
  arguments: z.unknown().optional(),
});

// custom_tool_call: `input` is a RAW string, not JSON-encoded args.
const CustomToolCallSchema = z.object({
  type: z.literal('custom_tool_call'),
  name: z.string().catch(''),
  input: z.string().catch(''),
});

// local_shell_call: `action.command` is an array (joined on space) or string.
const LocalShellCallSchema = z.object({
  type: z.literal('local_shell_call'),
  action: z
    .object({
      command: z
        .union([z.array(z.string()), z.string()])
        .catch([])
        .default([]),
    })
    .catch({ command: [] })
    .default({ command: [] }),
});

// The exec_command shell tool carries `{cmd: string}` (JSON-decoded). A missing
// or non-string cmd falls back to '' (Python `args.get("cmd", "")`).
const ExecArgsSchema = z
  .object({ cmd: z.string().catch('') })
  .catch({ cmd: '' });

function bashCall(command: string): ToolCall {
  return { tool: 'Bash', args: { command }, source: 'shell' };
}

// Decode the function_call `arguments` field. A JSON-string that fails to parse
// becomes `{raw: argsString}` (Python's JSONDecodeError fallback); a non-string
// value is returned verbatim.
function decodeFunctionArgs(rawArgs: unknown): Record<string, unknown> {
  if (typeof rawArgs === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      return { raw: rawArgs };
    }
    return z.record(z.unknown()).catch({}).parse(parsed);
  }
  return z.record(z.unknown()).catch({}).parse(rawArgs);
}

function emitFunctionCall(payload: unknown, out: ToolCall[]): void {
  const fc = FunctionCallSchema.safeParse(payload);
  if (!fc.success) {
    return;
  }
  const { name } = fc.data;
  const args = decodeFunctionArgs(fc.data.arguments);
  if (name === 'exec_command') {
    out.push(bashCall(ExecArgsSchema.parse(args).cmd));
    return;
  }
  if (name === 'apply_patch') {
    out.push({ tool: 'Edit', args, source: 'native' });
    return;
  }
  const canonical = canonicalName(name);
  out.push({ tool: canonical, args, source: classifySource(canonical) });
}

function emitCustomToolCall(payload: unknown, out: ToolCall[]): void {
  const ct = CustomToolCallSchema.safeParse(payload);
  if (!ct.success) {
    return;
  }
  const { name, input } = ct.data;
  if (name === 'apply_patch') {
    out.push({ tool: 'Edit', args: { patch: input }, source: 'native' });
    return;
  }
  const canonical = canonicalName(name);
  out.push({
    tool: canonical,
    args: { input },
    source: classifySource(canonical),
  });
}

function emitLocalShellCall(payload: unknown, out: ToolCall[]): void {
  const ls = LocalShellCallSchema.safeParse(payload);
  if (!ls.success) {
    return;
  }
  const { command } = ls.data.action;
  const commandStr = Array.isArray(command) ? command.join(' ') : command;
  out.push(bashCall(commandStr));
}

// Normalize Codex rollout JSONL into `ToolCall[]`. Each non-empty line is
// parsed as `unknown`, kept only when `type === 'response_item'`, then the
// tool payload (`payload`, else `item`) is dispatched on its own `type`.
// Blank and malformed lines are skipped (parity with Python's
// JSONDecodeError continue). SOURCE OF TRUTH: quorum/normalizers.py
// normalize_codex_logs + CODEX_TOOL_MAP.
export function normalizeCodexLogs(raw: string): ToolCall[] {
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
    const payload = entry.data.payload ?? entry.data.item ?? {};
    const tagged = z.object({ type: z.string().catch('') }).safeParse(payload);
    const payloadType = tagged.success ? tagged.data.type : '';
    if (payloadType === 'function_call') {
      emitFunctionCall(payload, out);
    } else if (payloadType === 'custom_tool_call') {
      emitCustomToolCall(payload, out);
    } else if (payloadType === 'local_shell_call') {
      emitLocalShellCall(payload, out);
    }
  }
  return out;
}
