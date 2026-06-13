import { z } from 'zod';
import type { ToolCall } from '../contracts/verdict.ts';

// Reverse mapping: Antigravity tool names -> Claude Code canonical names.
// Mirrors ANTIGRAVITY_TOOL_MAP in quorum/normalizers.py (byte-exact precedence).
const ANTIGRAVITY_TOOL_MAP: Readonly<Record<string, string>> = {
  run_command: 'Bash',
  view_file: 'Read',
  write_to_file: 'Write',
  create_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  edit_file: 'Edit',
  grep_search: 'Grep',
  search_directory: 'Grep',
  list_dir: 'Glob',
  find_by_name: 'Glob',
  find_file: 'Glob',
  list_directory: 'Glob',
  invoke_subagent: 'Agent',
  search_web: 'WebSearch',
  read_url_content: 'WebFetch',
};

// Native set = mapped canonical names minus Bash, plus the two manage tools.
// Mirrors ANTIGRAVITY_NATIVE_TOOLS in quorum/normalizers.py. Membership is
// checked against the canonical (post-TOOL_MAP) name.
const ANTIGRAVITY_NATIVE_TOOLS: ReadonlySet<string> = (() => {
  const native = new Set<string>(Object.values(ANTIGRAVITY_TOOL_MAP));
  native.delete('Bash');
  native.add('manage_task');
  native.add('list_permissions');
  return native;
})();

function canonicalToolName(name: string): string {
  return Object.hasOwn(ANTIGRAVITY_TOOL_MAP, name)
    ? (ANTIGRAVITY_TOOL_MAP[name] ?? name)
    : name;
}

// Sentinel for "key not present". Distinct from any JSON value, so presence
// checks stay PRESENCE-based (Object.hasOwn), never truthiness-based.
const MISSING = Symbol('missing');

// Return the value of the first key that is PRESENT on obj (Object.hasOwn),
// else MISSING. Mirrors Python _first_arg.
function firstPresent(
  obj: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (Object.hasOwn(obj, key)) {
      return obj[key];
    }
  }
  return MISSING;
}

// If value is a non-string, return it unchanged. Otherwise JSON-parse it; keep
// the parsed value only when it is a scalar (string | boolean | number),
// else fall back to the original string. Mirrors _antigravity_canonical_value.
// Accepted divergence: JS JSON.parse rejects NaN/Infinity (Python json.loads
// accepts them) and parses bignum literals lossily; such string-encoded values
// would canonicalize differently. These are pathological as command/path/bool
// values and do not occur in real antigravity transcripts.
function canonicalValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (
    typeof parsed === 'string' ||
    typeof parsed === 'boolean' ||
    typeof parsed === 'number'
  ) {
    return parsed;
  }
  return value;
}

// A plain object is a non-null, non-array object. Mirrors Python isinstance(x, dict).
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RUN_COMMAND_KEYS = ['CommandLine', 'command'] as const;
const RUN_COMMAND_CWD_KEYS = [
  'Cwd',
  'cwd',
  'WorkingDirectory',
  'working_directory',
] as const;
const VIEW_FILE_PATH_KEYS = [
  'AbsolutePath',
  'Path',
  'path',
  'file_path',
  'filePath',
] as const;
const SKILL_FILE_KEYS = [
  'IsSkillFile',
  'isSkillFile',
  'is_skill_file',
] as const;
const LIST_DIR_KEYS = ['DirectoryPath', 'directory_path', 'path'] as const;
const WRITE_EDIT_KEYS = [
  'TargetFile',
  'target_file',
  'TargetPath',
  'Path',
  'path',
  'file_path',
  'filePath',
] as const;
const WRITE_EDIT_NAMES: ReadonlySet<string> = new Set([
  'write_to_file',
  'create_file',
  'replace_file_content',
  'multi_replace_file_content',
  'edit_file',
]);

// Build the canonicalized args for one call. raw_args always carries a copy of
// the original args. When raw is a plain object, the original keys are spread
// in and tool-specific canonical keys are layered on top. Mirrors
// _normalize_antigravity_args.
function normalizeArgs(name: string, raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    return { raw_args: raw };
  }

  const args: Record<string, unknown> = { ...raw };
  args['raw_args'] = { ...raw };

  if (name === 'run_command') {
    const command = firstPresent(raw, RUN_COMMAND_KEYS);
    if (command !== MISSING) {
      args['command'] = canonicalValue(command);
    }
    const cwd = firstPresent(raw, RUN_COMMAND_CWD_KEYS);
    if (cwd !== MISSING) {
      args['cwd'] = canonicalValue(cwd);
    }
  } else if (name === 'view_file') {
    const filePath = firstPresent(raw, VIEW_FILE_PATH_KEYS);
    if (filePath !== MISSING) {
      args['file_path'] = canonicalValue(filePath);
    }

    let isSkill = firstPresent(raw, SKILL_FILE_KEYS);
    if (isSkill === MISSING) {
      const metadata = raw['metadata'];
      if (isPlainObject(metadata)) {
        isSkill = firstPresent(metadata, SKILL_FILE_KEYS);
      }
    }
    if (isSkill !== MISSING) {
      args['is_skill_file'] = canonicalValue(isSkill);
    }
  } else if (name === 'list_dir') {
    const path = firstPresent(raw, LIST_DIR_KEYS);
    if (path !== MISSING) {
      args['path'] = canonicalValue(path);
    }
  } else if (WRITE_EDIT_NAMES.has(name)) {
    const filePath = firstPresent(raw, WRITE_EDIT_KEYS);
    if (filePath !== MISSING) {
      args['file_path'] = canonicalValue(filePath);
    }
  }

  return args;
}

// One Antigravity call object: name (string) + optional args. Both narrowed
// from unknown; non-string/absent name yields '' which is skipped by the caller.
const CallSchema = z.object({
  name: z.unknown().optional(),
  args: z.unknown().optional(),
});

// A JSONL entry: a top-level object plus optional planner-response containers
// that themselves carry tool_calls/toolCalls arrays.
const EntrySchema = z.object({
  tool_calls: z.unknown().optional(),
  toolCalls: z.unknown().optional(),
  PLANNER_RESPONSE: z.unknown().optional(),
  planner_response: z.unknown().optional(),
});

const CALLS_KEYS = ['tool_calls', 'toolCalls'] as const;
const PLANNER_KEYS = ['PLANNER_RESPONSE', 'planner_response'] as const;

// Gather every call object across the entry and its planner-response containers.
// Mirrors _antigravity_tool_calls: container order is [entry, PLANNER_RESPONSE,
// planner_response]; within each container tool_calls precedes toolCalls.
function collectCalls(entry: Record<string, unknown>): unknown[] {
  const containers: Record<string, unknown>[] = [entry];
  for (const plannerKey of PLANNER_KEYS) {
    const plannerResponse = entry[plannerKey];
    if (isPlainObject(plannerResponse)) {
      containers.push(plannerResponse);
    }
  }

  const calls: unknown[] = [];
  for (const container of containers) {
    for (const callsKey of CALLS_KEYS) {
      const toolCalls = container[callsKey];
      if (!Array.isArray(toolCalls)) {
        continue;
      }
      for (const call of toolCalls) {
        if (isPlainObject(call)) {
          calls.push(call);
        }
      }
    }
  }
  return calls;
}

// Normalize Antigravity JSONL transcript tool calls into ToolCall[]. Each
// non-blank line is JSON-parsed; non-object entries and malformed lines are
// skipped (parity with Python's continue). Antigravity emits tool calls in
// top-level tool_calls/toolCalls arrays and, for planner turns, nested under
// PLANNER_RESPONSE/planner_response. SOURCE OF TRUTH:
// quorum/normalizers.py normalize_antigravity_logs + ANTIGRAVITY_TOOL_MAP.
export function normalizeAntigravityLogs(raw: string): ToolCall[] {
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
    if (!isPlainObject(parsed)) {
      continue;
    }
    const entry = EntrySchema.passthrough().parse(parsed);

    for (const rawCall of collectCalls(entry)) {
      const call = CallSchema.safeParse(rawCall);
      if (!call.success) {
        continue;
      }
      const { name } = call.data;
      if (typeof name !== 'string' || !name) {
        continue;
      }
      const canonical = canonicalToolName(name);
      // Python `tool_call.get("args", {})` defaults only on ABSENCE; a present
      // null arg must reach normalizeArgs as null (-> {raw_args: null}), not {}.
      const rawArgs = call.data.args === undefined ? {} : call.data.args;
      const args = normalizeArgs(name, rawArgs);
      const source = ANTIGRAVITY_NATIVE_TOOLS.has(canonical)
        ? 'native'
        : 'shell';
      out.push({ tool: canonical, args, source });
    }
  }
  return out;
}
