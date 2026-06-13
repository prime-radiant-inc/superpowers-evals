import { z } from 'zod';
import type { ToolCall } from '../contracts/verdict.ts';

// Reverse mapping: OpenCode tool names -> Claude Code canonical names. Mirrors
// OPENCODE_TOOL_MAP in quorum/normalizers.py. apply_patch shares the Edit
// canonical with edit; bash stays Bash (and is the lone non-native entry).
const OPENCODE_TOOL_MAP: Readonly<Record<string, string>> = {
  skill: 'Skill',
  task: 'Agent',
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  todowrite: 'TodoWrite',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
};

// Native set is the OPENCODE_TOOL_MAP values minus Bash, plus the three web/todo
// canonicals. Built from the map so the two stay in lockstep. Membership is
// checked against the canonical (post-map) name, exactly like Python.
const OPENCODE_NATIVE_TOOLS: ReadonlySet<string> = (() => {
  const native = new Set<string>(Object.values(OPENCODE_TOOL_MAP));
  native.delete('Bash');
  native.add('TodoWrite');
  native.add('WebFetch');
  native.add('WebSearch');
  return native;
})();

// A plain object is the JS analogue of Python isinstance(x, dict): a non-null
// object that is not an array. zod's z.record alone would also accept arrays,
// so we guard arrays out explicitly.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Whole-document envelope. messages must be an array; everything below is
// validated per-element so a single malformed entry never aborts the doc.
const DocumentSchema = z.object({
  messages: z.array(z.unknown()).catch([]).default([]),
});

const MessageSchema = z.object({
  parts: z.array(z.unknown()).catch([]).default([]),
});

const PartSchema = z.object({
  type: z.string().catch(''),
  tool: z.unknown().optional(),
  state: z.unknown().optional(),
});

// state.input, mirroring _opencode_tool_input: state must be a plain object,
// else {}. A present-but-undefined input also falls back to {}.
function toolInput(part: z.infer<typeof PartSchema>): unknown {
  const { state } = part;
  if (!isPlainObject(state)) {
    return {};
  }
  // Python `state.get("input", {})` defaults only on ABSENCE; a present-null
  // input stays null (so raw_input is preserved as null downstream).
  return Object.hasOwn(state, 'input') ? state['input'] : {};
}

// Collect file paths from an apply_patch body. Shared logic with copilot:
// scan each line for the three change-op prefixes and take the trimmed tail.
function applyPatchPaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string') {
    return [];
  }
  const prefixes = ['*** Add File: ', '*** Update File: ', '*** Delete File: '];
  const paths: string[] = [];
  for (const line of patchText.split('\n')) {
    for (const prefix of prefixes) {
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

// Mirror _normalize_opencode_args: seed args from the raw input dict (or {}),
// always stash raw_input, then apply the per-tool inference rules in order.
function normalizeArgs(name: string, input: unknown): Record<string, unknown> {
  const args: Record<string, unknown> = isPlainObject(input)
    ? { ...input }
    : {};
  args['raw_input'] = input;

  if (name === 'skill' && isPlainObject(input)) {
    // Python `raw_input.get("skill") or raw_input.get("name")`: a FALSY skill
    // (missing / empty-string / 0 / false) falls through to name; a TRUTHY
    // non-string skill short-circuits and yields no string candidate (so no
    // rewrite). Use truthy selection, NOT nullish (??), to match.
    const candidate = input['skill'] ? input['skill'] : input['name'];
    if (typeof candidate === 'string') {
      const idx = candidate.indexOf(':');
      args['name'] = idx >= 0 ? candidate.slice(idx + 1) : candidate;
      args['skill'] = idx >= 0 ? candidate : `superpowers:${candidate}`;
    }
  }

  if (name === 'bash' && !Object.hasOwn(args, 'command')) {
    const cmd = args['cmd'];
    if (typeof cmd === 'string') {
      args['command'] = cmd;
    }
  }

  if (
    (name === 'read' || name === 'write' || name === 'edit') &&
    !Object.hasOwn(args, 'file_path')
  ) {
    for (const key of ['file_path', 'filePath', 'path', 'file']) {
      const value = args[key];
      if (typeof value === 'string') {
        args['file_path'] = value;
        break;
      }
    }
  }

  if (name === 'apply_patch' && !Object.hasOwn(args, 'file_path')) {
    const patch = args['patch'];
    const patchText =
      typeof patch === 'string'
        ? patch
        : typeof input === 'string'
          ? input
          : undefined;
    const paths = applyPatchPaths(patchText);
    if (paths.length > 0) {
      args['file_path'] = paths[0];
      args['file_paths'] = paths;
    }
  }

  return args;
}

// Normalize an OpenCode exported session JSON into ToolCall[]. The WHOLE input
// is parsed as one JSON document; a parse error or a non-object root yields [].
// messages -> message.parts -> tool parts are walked, validating each layer so
// malformed elements are skipped (parity with the Python isinstance guards).
// SOURCE OF TRUTH: quorum/normalizers.py normalize_opencode_logs +
// OPENCODE_TOOL_MAP + OPENCODE_NATIVE_TOOLS.
export function normalizeOpencodeLogs(raw: string): ToolCall[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) {
    return [];
  }
  const doc = DocumentSchema.safeParse(parsed);
  if (!doc.success) {
    return [];
  }

  const out: ToolCall[] = [];
  for (const rawMessage of doc.data.messages) {
    if (!isPlainObject(rawMessage)) {
      continue;
    }
    const message = MessageSchema.safeParse(rawMessage);
    if (!message.success) {
      continue;
    }
    for (const rawPart of message.data.parts) {
      if (!isPlainObject(rawPart)) {
        continue;
      }
      const part = PartSchema.safeParse(rawPart);
      if (!part.success || part.data.type !== 'tool') {
        continue;
      }
      const name = part.data.tool;
      if (typeof name !== 'string' || !name) {
        continue;
      }
      const canonical = OPENCODE_TOOL_MAP[name] ?? name;
      const args = normalizeArgs(name, toolInput(part.data));
      const source: ToolCall['source'] = OPENCODE_NATIVE_TOOLS.has(canonical)
        ? 'native'
        : 'shell';
      out.push({ tool: canonical, args, source });
    }
  }
  return out;
}
