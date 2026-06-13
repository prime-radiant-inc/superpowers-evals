import { z } from 'zod';
import type { ToolCall } from '../contracts/verdict.ts';

// Copilot CLI tool names -> Claude Code canonical names. Mirrors
// COPILOT_TOOL_MAP in quorum/normalizers.py byte-for-byte.
const COPILOT_TOOL_MAP: Readonly<Record<string, string>> = {
  skill: 'Skill',
  bash: 'Bash',
  apply_patch: 'Edit',
  edit: 'Edit',
  create: 'Write',
  write: 'Write',
  view: 'Read',
  rg: 'Grep',
  glob: 'Glob',
  task: 'Agent',
  read_agent: 'Agent',
  list_agents: 'Agent',
  write_agent: 'Agent',
  update_todo: 'TodoWrite',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
};

// Dialect-local native set: the mapped canonical values minus Bash, plus the
// three always-native names. This is NOT the global NATIVE_TOOLS set — the
// Python oracle classifies source against COPILOT_NATIVE_TOOLS, so we do too.
// (set(COPILOT_TOOL_MAP.values()) - {"Bash"}) | {TodoWrite, WebFetch, WebSearch}
const COPILOT_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  ...Object.values(COPILOT_TOOL_MAP).filter((value) => value !== 'Bash'),
  'TodoWrite',
  'WebFetch',
  'WebSearch',
]);

// Tool names whose args carry an inferable file path. Copilot uses
// {view, edit, create, write} (differs from opencode's {read, write, edit}).
const FILE_PATH_TOOLS: ReadonlySet<string> = new Set([
  'view',
  'edit',
  'create',
  'write',
]);

const FILE_PATH_KEYS = ['file_path', 'filePath', 'path', 'file'] as const;

const APPLY_PATCH_PREFIXES = [
  '*** Add File: ',
  '*** Update File: ',
  '*** Delete File: ',
] as const;

// A Copilot session-state line. Only assistant.message entries carrying a
// toolRequests array contribute tool calls; everything else is skipped.
const EntrySchema = z.object({
  type: z.literal('assistant.message'),
  data: z
    .object({
      toolRequests: z.array(z.unknown()).catch([]).default([]),
    })
    .catch({ toolRequests: [] })
    .default({ toolRequests: [] }),
});

const RequestSchema = z.object({
  name: z.string().catch(''),
  arguments: z.unknown().optional(),
});

// Extract the path lines from an apply_patch body (parity with
// _apply_patch_paths). Non-string input yields no paths.
function applyPatchPaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string') {
    return [];
  }
  const paths: string[] = [];
  for (const line of patchText.split('\n')) {
    for (const prefix of APPLY_PATCH_PREFIXES) {
      if (line.startsWith(prefix)) {
        const path = line.slice(prefix.length).trim();
        if (path) {
          paths.push(path);
        }
        break;
      }
    }
  }
  return paths;
}

// Pull a string value from args by key (mirrors args.get(key) + isinstance str).
function stringField(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = Object.hasOwn(args, key) ? args[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

// Mirror of _normalize_copilot_args. Starts from a shallow copy of a dict-shaped
// raw_input (or {} otherwise), records raw_input, then layers tool-specific
// inferences (skill name, bash command, file_path, apply_patch paths).
function normalizeArgs(
  name: string,
  rawInput: unknown,
): Record<string, unknown> {
  const parsed = z.record(z.unknown()).safeParse(rawInput);
  const isDict = parsed.success;
  const args: Record<string, unknown> = isDict ? { ...parsed.data } : {};
  args['raw_input'] = rawInput;

  if (name === 'skill') {
    let skillName = '';
    if (isDict) {
      // Python `raw_input.get("skill") or raw_input.get("name")`: a TRUTHY skill
      // (even a non-string) short-circuits the `or`; only a FALSY skill falls
      // through to name. `isinstance(candidate, str)` then gates the rewrite, so
      // a truthy non-string skill yields NO rewrite. Select on the raw values to
      // match — not on stringField (which would discard a truthy non-string and
      // wrongly fall through to name).
      const skillRaw = Object.hasOwn(parsed.data, 'skill')
        ? parsed.data['skill']
        : undefined;
      const chosen = skillRaw ? skillRaw : parsed.data['name'];
      skillName = typeof chosen === 'string' ? chosen : '';
    }
    if (skillName) {
      const colonIndex = skillName.indexOf(':');
      args['name'] =
        colonIndex === -1 ? skillName : skillName.slice(colonIndex + 1);
      args['skill'] = skillName.includes(':')
        ? skillName
        : `superpowers:${skillName}`;
    }
  }

  if (name === 'bash' && !Object.hasOwn(args, 'command')) {
    const command = stringField(args, 'cmd');
    if (command !== undefined) {
      args['command'] = command;
    }
  }

  if (FILE_PATH_TOOLS.has(name) && !Object.hasOwn(args, 'file_path')) {
    for (const key of FILE_PATH_KEYS) {
      const value = stringField(args, key);
      if (value !== undefined) {
        args['file_path'] = value;
        break;
      }
    }
  }

  if (name === 'apply_patch' && !Object.hasOwn(args, 'file_path')) {
    let patchText = Object.hasOwn(args, 'patch') ? args['patch'] : undefined;
    if (typeof patchText !== 'string' && typeof rawInput === 'string') {
      patchText = rawInput;
    }
    const paths = applyPatchPaths(patchText);
    if (paths.length > 0) {
      args['file_path'] = paths[0];
      args['file_paths'] = paths;
    }
  }

  return args;
}

// Normalize Copilot CLI session-state JSONL into ToolCall[]. Each non-blank
// line is JSON-parsed; only object entries with type === 'assistant.message'
// and an array data.toolRequests contribute. Blank/malformed lines are skipped
// (parity with Python's continue). SOURCE OF TRUTH: quorum/normalizers.py
// normalize_copilot_logs + COPILOT_TOOL_MAP + COPILOT_NATIVE_TOOLS.
export function normalizeCopilotLogs(raw: string): ToolCall[] {
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
    for (const rawRequest of entry.data.data.toolRequests) {
      const request = RequestSchema.safeParse(rawRequest);
      if (!request.success) {
        continue;
      }
      const { name } = request.data;
      if (!name) {
        continue;
      }
      const canonical = Object.hasOwn(COPILOT_TOOL_MAP, name)
        ? (COPILOT_TOOL_MAP[name] ?? name)
        : name;
      const args = normalizeArgs(name, request.data.arguments ?? {});
      const source: ToolCall['source'] = COPILOT_NATIVE_TOOLS.has(canonical)
        ? 'native'
        : 'shell';
      out.push({ tool: canonical, args, source });
    }
  }
  return out;
}
