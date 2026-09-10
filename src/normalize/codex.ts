import {
  type NativeBoundary,
  type NativeChildEvidence,
  type NativeCommunication,
  type NativeToolResultEvidence,
  nativeRecordBytes,
  nativeTextBytes,
  withNativeEvidence,
} from '../atif/provenance.ts';
import {
  ATIF_SCHEMA_VERSION,
  type AtifFinalMetrics,
  type AtifMetrics,
  type AtifObservation,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// Codex token usage lives in `event_msg` rows whose payload.type is
// "token_count". `info.total_token_usage` is the running session cumulative
// (the last one is the session total); `info.last_token_usage` is the per-turn
// delta, and the deltas sum to the cumulative. The session total is recorded as
// AtifTrajectory.final_metrics, and each per-turn delta rides on its own agent
// step as per-step metrics tagged with the session model. The per-step copies
// are what survive a multi-session merge (codex spawns each subagent as its own
// rollout file) so obol attributes tokens to each subagent's actual model, and
// keeping them PER-TURN (real request sizes) — not one lumped cumulative step —
// keeps obol's per-step large-context tier from misfiring. See normalizeCodex.
interface CodexTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

function asTokenUsage(value: unknown): CodexTokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as CodexTokenUsage;
}

function sameTokenUsage(a: CodexTokenUsage, b: CodexTokenUsage): boolean {
  return (
    typeof a.input_tokens === 'number' &&
    typeof a.output_tokens === 'number' &&
    a.input_tokens === b.input_tokens &&
    a.cached_input_tokens === b.cached_input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.reasoning_output_tokens === b.reasoning_output_tokens &&
    a.total_tokens === b.total_tokens
  );
}

// Map the final cumulative codex usage into ATIF final_metrics. cached has no
// first-class final-metrics field so it rides in extra.total_cached_tokens. No
// cost is logged by codex; cost is priced downstream by obol.
function finalMetricsFromUsage(usage: CodexTokenUsage): AtifFinalMetrics {
  const fm: AtifFinalMetrics = {};
  // ATIF token buckets are DISJOINT (prompt = UNCACHED input). codex's
  // input_tokens INCLUDES cached input, so subtract the cached portion; the
  // cached count rides in extra.total_cached_tokens below.
  if (typeof usage.input_tokens === 'number')
    fm.total_prompt_tokens = Math.max(
      0,
      usage.input_tokens - (usage.cached_input_tokens ?? 0),
    );
  // codex output_tokens ALREADY INCLUDES reasoning_output_tokens (verified
  // against real rollouts: total_tokens == input_tokens + output_tokens, and
  // reasoning ⊆ output in every row). completion = output_tokens; folding
  // reasoning in again would double-count it and break the disjoint-sum
  // conservation (prompt + cached + completion == total_tokens).
  if (typeof usage.output_tokens === 'number')
    fm.total_completion_tokens = usage.output_tokens;
  if (typeof usage.cached_input_tokens === 'number')
    fm.extra = { total_cached_tokens: usage.cached_input_tokens };
  return fm;
}

// Per-step view of the same cumulative usage, for attaching to the session's last
// agent step. Same disjoint-bucket mapping as finalMetricsFromUsage: prompt =
// UNCACHED input, completion = output (reasoning already folded in), cached
// rides in cached_tokens.
function stepMetricsFromUsage(usage: CodexTokenUsage): AtifMetrics {
  const m: AtifMetrics = {};
  if (typeof usage.input_tokens === 'number')
    m.prompt_tokens = Math.max(
      0,
      usage.input_tokens - (usage.cached_input_tokens ?? 0),
    );
  if (typeof usage.output_tokens === 'number')
    m.completion_tokens = usage.output_tokens;
  if (typeof usage.cached_input_tokens === 'number')
    m.cached_tokens = usage.cached_input_tokens;
  return m;
}

// Reverse mapping: Codex tool names → canonical names.
// spawn_agent aliases to Agent (1:1 with a subagent launch). wait_agent and
// close_agent are async-protocol join/teardown calls; aliasing them too would
// inflate tool-count Agent threefold.
const CODEX_TOOL_MAP: Record<string, string> = {
  spawn_agent: 'Agent',
};

const NATIVE_TOOLS = new Set([
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

interface CodexFunctionCallPayload {
  type: 'function_call';
  name?: string;
  arguments?: string | Record<string, unknown>;
  call_id?: string;
}

interface CodexCustomToolCallPayload {
  type: 'custom_tool_call';
  name?: string;
  input?: string;
  call_id?: string;
}

interface CodexLocalShellCallPayload {
  type: 'local_shell_call';
  action?: { command?: string[] };
}

interface CodexMessagePayload {
  type: 'message';
  role?: string;
  content?: unknown[];
}

interface CodexReasoningPayload {
  type: 'reasoning';
  summary?: unknown[];
}

interface CodexWebSearchCallPayload {
  type: 'web_search_call';
  action?: {
    type?: string;
    query?: string;
    queries?: string[];
    url?: string;
  };
  status?: string;
}

interface CodexToolSearchCallPayload {
  type: 'tool_search_call';
  call_id?: string;
  arguments?: string | Record<string, unknown>;
  status?: string;
}

interface CodexToolSearchOutputPayload {
  type: 'tool_search_output';
  call_id?: string;
  tools?: unknown;
}

interface CodexFunctionCallOutputPayload {
  type: 'function_call_output';
  call_id?: string;
  output?: unknown;
  name?: string;
}

interface CodexCustomToolCallOutputPayload {
  type: 'custom_tool_call_output';
  call_id?: string;
  output?: unknown;
  name?: string;
}

type CodexPayload =
  | CodexFunctionCallPayload
  | CodexCustomToolCallPayload
  | CodexLocalShellCallPayload
  | CodexMessagePayload
  | CodexReasoningPayload
  | CodexWebSearchCallPayload
  | CodexToolSearchCallPayload
  | CodexFunctionCallOutputPayload
  | CodexCustomToolCallOutputPayload
  | CodexToolSearchOutputPayload
  | { type: string };

function parseArgs(
  raw: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (raw === undefined) return {};
  if (typeof raw === 'object' && raw !== null) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null)
        return parsed as Record<string, unknown>;
      return { raw };
    } catch {
      return { raw };
    }
  }
  return {};
}

// Extract target paths from an apply_patch body (same header format the
// copilot/opencode normalizers parse). Without this, codex apply_patch edits
// carry only `{patch}` and are invisible to the implementation-path checks
// (implementation-tool-not-called / skill-before-implementation-tool).
function applyPatchPaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string') return [];
  const paths: string[] = [];
  const prefixes = ['*** Add File: ', '*** Update File: ', '*** Delete File: '];
  for (const line of patchText.split('\n')) {
    for (const pre of prefixes) {
      if (line.startsWith(pre)) {
        paths.push(line.slice(pre.length).trim());
        break;
      }
    }
  }
  return paths;
}

function withPatchPaths(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if ('file_path' in args) return args;
  const patchText =
    typeof args['patch'] === 'string'
      ? args['patch']
      : typeof args['input'] === 'string'
        ? args['input']
        : undefined;
  const paths = applyPatchPaths(patchText);
  if (paths.length > 0) {
    return { ...args, file_path: paths[0], file_paths: paths };
  }
  return args;
}

/** Extract joined text from Codex content blocks (mirrors Harbor's _extract_message_text). */
function extractMessageText(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      const text = b['text'];
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

/**
 * Parse a Codex tool output blob: if it's a JSON object with an `output` key,
 * return that; if the whole blob is a string, return it; otherwise JSON-encode.
 * Mirrors Harbor's _parse_output_blob.
 */
function parseOutputBlob(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Record<string, unknown>;
        const output = p['output'];
        if (output !== undefined && output !== null) return String(output);
        // No output key — JSON-encode the whole thing
        return JSON.stringify(parsed);
      }
    } catch {
      // raw string is the output
    }
    return raw;
  }
  if (typeof raw === 'object') {
    const p = raw as Record<string, unknown>;
    const output = p['output'];
    if (output !== undefined && output !== null) return String(output);
    return JSON.stringify(raw);
  }
  return String(raw);
}

function codexOutputObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw))
    return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Supported native output envelopes only; never infer failure from file text. */
function nativeCodexResultError(raw: unknown): boolean | undefined {
  const object = codexOutputObject(raw);
  if (object && 'output' in object) {
    const metadata = object['metadata'];
    const exitCode =
      metadata && typeof metadata === 'object'
        ? (metadata as Record<string, unknown>)['exit_code']
        : object['exit_code'];
    if (typeof exitCode === 'number' && Number.isInteger(exitCode))
      return exitCode !== 0;
  }
  // Codex functions.exec wraps returned exec_command objects in input_text
  // blocks after its own execution header. Only those structured return values
  // carry shell status; arbitrary content/error-looking text is not an exit code.
  if (Array.isArray(raw)) {
    const header = raw[0];
    if (
      !header ||
      typeof header !== 'object' ||
      header.type !== 'input_text' ||
      typeof header.text !== 'string' ||
      !/^Script completed\r?\nWall time [^\n]+\r?\nOutput:\r?\n$/.test(
        header.text,
      )
    )
      return undefined;
    const statuses = raw
      .slice(1)
      .map((block) =>
        block && typeof block === 'object' && block.type === 'input_text'
          ? nativeCodexResultError(block.text)
          : undefined,
      );
    if (statuses.some((status) => status === true)) return true;
    if (statuses.length && statuses.every((status) => status === false))
      return false;
  }
  return undefined;
}

type StaticExecOptionType = 'boolean' | 'number' | 'string' | 'string-array';

const STATIC_EXEC_OPTION_TYPES: Record<string, StaticExecOptionType> = {
  cmd: 'string',
  justification: 'string',
  login: 'boolean',
  max_output_tokens: 'number',
  prefix_rule: 'string-array',
  sandbox_permissions: 'string',
  shell: 'string',
  tty: 'boolean',
  workdir: 'string',
  yield_time_ms: 'number',
};

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/.test(source[index] ?? '')) index += 1;
  return index;
}

function staticStringLiteral(
  source: string,
  start: number,
  allowTemplate = true,
): { end: number; value: string } | undefined {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && (!allowTemplate || quote !== '`'))
    return undefined;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char !== quote) continue;
    const body = source.slice(start + 1, index);
    if (quote === '`' && body.includes('${')) return undefined;
    return { end: index + 1, value: unescapeJsLiteral(body) };
  }
  return undefined;
}

function staticStringArray(source: string, start: number): number | undefined {
  if (source[start] !== '[') return undefined;
  let index = skipWhitespace(source, start + 1);
  if (source[index] === ']') return index + 1;
  for (;;) {
    const literal = staticStringLiteral(source, index);
    if (!literal) return undefined;
    index = skipWhitespace(source, literal.end);
    if (source[index] === ']') return index + 1;
    if (source[index] !== ',') return undefined;
    index = skipWhitespace(source, index + 1);
    if (source[index] === ']') return index + 1;
  }
}

function staticExecOptionValue(
  source: string,
  start: number,
  type: StaticExecOptionType,
): { end: number; value?: string } | undefined {
  if (type === 'string') return staticStringLiteral(source, start);
  if (type === 'string-array') {
    const end = staticStringArray(source, start);
    return end === undefined ? undefined : { end };
  }
  if (type === 'boolean') {
    const match = /^(?:true|false)\b/.exec(source.slice(start));
    return match ? { end: start + match[0].length } : undefined;
  }
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
    source.slice(start),
  );
  return match ? { end: start + match[0].length } : undefined;
}

/**
 * Consume one directly emitted exec_command statement whose argument is a
 * static object literal. Values are checked against the native tool's option
 * types, while duplicate, unknown, computed and expression-valued fields are
 * rejected. This is deliberately not a general JavaScript parser.
 */
function staticExecCommandStatement(
  source: string,
): { command: string; length: number } | undefined {
  let index = skipWhitespace(source, 0);
  if (!source.startsWith('text', index)) return undefined;
  index = skipWhitespace(source, index + 'text'.length);
  if (source[index] !== '(') return undefined;
  index = skipWhitespace(source, index + 1);
  if (!source.startsWith('await', index)) return undefined;
  const afterAwait = index + 'await'.length;
  index = skipWhitespace(source, afterAwait);
  if (index === afterAwait || !source.startsWith('tools.exec_command', index))
    return undefined;
  index = skipWhitespace(source, index + 'tools.exec_command'.length);
  if (source[index] !== '(') return undefined;
  index = skipWhitespace(source, index + 1);
  if (source[index] !== '{') return undefined;
  index = skipWhitespace(source, index + 1);

  const seen = new Set<string>();
  let command: string | undefined;
  while (source[index] !== '}') {
    const quotedKey = staticStringLiteral(source, index, false);
    const identifierKey = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
    const key = quotedKey?.value ?? identifierKey?.[0];
    if (!key) return undefined;
    index = quotedKey
      ? quotedKey.end
      : index + (identifierKey?.[0].length ?? 0);
    if (seen.has(key)) return undefined;
    seen.add(key);
    const optionType = STATIC_EXEC_OPTION_TYPES[key];
    if (!optionType) return undefined;
    index = skipWhitespace(source, index);
    if (source[index] !== ':') return undefined;
    index = skipWhitespace(source, index + 1);
    const option = staticExecOptionValue(source, index, optionType);
    if (!option) return undefined;
    if (
      key === 'sandbox_permissions' &&
      option.value !== 'use_default' &&
      option.value !== 'require_escalated'
    )
      return undefined;
    if (key === 'cmd') command = option.value;
    index = skipWhitespace(source, option.end);
    if (source[index] === '}') break;
    if (source[index] !== ',') return undefined;
    index = skipWhitespace(source, index + 1);
    if (source[index] === '}') break;
  }
  if (command === undefined || source[index] !== '}') return undefined;
  index = skipWhitespace(source, index + 1);
  if (source[index] !== ')') return undefined;
  index = skipWhitespace(source, index + 1);
  if (source[index] !== ')') return undefined;
  index = skipWhitespace(source, index + 1);
  if (source[index] !== ';') return undefined;
  return { command, length: index + 1 };
}

/**
 * Qualify only a fully consumed sequence of directly emitted, awaited shell
 * calls with supported static literal options. General exec scripts can
 * reorder, skip, transform or fabricate their outputs, so output count/order
 * alone is unsafe. This deliberately narrow grammar establishes the native
 * output-to-call map; all other script shapes retain their output without
 * qualified subcall status.
 */
function nativeCodexSubcallResults(
  calls: AtifToolCall[],
  callId: string,
  raw: unknown,
): NativeToolResultEvidence['subcalls'] {
  if (
    !calls.length ||
    calls.some((call) => call.extra?.['composite_call_id'] !== callId) ||
    !Array.isArray(raw) ||
    raw.length !== calls.length + 1 ||
    nativeCodexResultError(raw) === undefined
  )
    return undefined;
  let script = calls.map((call) => call.extra?.['script']).join('');
  const outcomes: NonNullable<NativeToolResultEvidence['subcalls']> = [];
  for (const [index, call] of calls.entries()) {
    const statement = staticExecCommandStatement(script);
    if (
      !statement ||
      call.function_name !== 'Bash' ||
      statement.command !== call.arguments['command']
    )
      return undefined;
    script = script.slice(statement.length);
    const block = raw[index + 1];
    if (block?.type !== 'input_text') return undefined;
    const output = codexOutputObject(block.text);
    const isError = nativeCodexResultError(output);
    if (isError === undefined || typeof output?.['output'] !== 'string')
      return undefined;
    outcomes.push({
      toolCallId: call.tool_call_id,
      isError,
      contentBytes: Buffer.byteLength(output['output'], 'utf8'),
    });
  }
  return script.trim() ? undefined : outcomes;
}

function nativeTextBytesFromCodexOutput(raw: unknown): number | undefined {
  const parsed = codexOutputObject(raw);
  return nativeTextBytes(parsed?.['output'] ?? raw);
}

function childIdentityFromCodexOutput(
  raw: unknown,
): Pick<NativeChildEvidence, 'id' | 'name'> | undefined {
  const parsed = codexOutputObject(raw);
  const id = parsed?.['agent_id'] ?? parsed?.['agentId'];
  const name = parsed?.['task_name'];
  const identity: Pick<NativeChildEvidence, 'id' | 'name'> = {};
  if (typeof id === 'string' && id) identity.id = id;
  if (typeof name === 'string' && name) identity.name = name;
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function agentRelationship(
  call: AtifToolCall,
): NativeChildEvidence['relationship'] {
  const args = call.arguments;
  if (args['fork_turns'] === 'none') return 'spawned';
  if (args['fork_turns'] !== undefined) return 'fork';
  const script = call.extra?.['script'];
  if (typeof script === 'string') {
    const forkTurns = plainStringProp(script, 'fork_turns');
    if (forkTurns === 'none') return 'spawned';
    if (forkTurns !== null) return 'fork';
  }
  return 'unknown';
}

// codex ≥0.144 driving the gpt-5.6 family routes ALL tool use through a single
// custom tool named `exec` whose input is a JavaScript program invoking
// tools.exec_command / tools.apply_patch / tools.update_plan / tools.write_stdin
// (PRI-2584). Unpack those invocations into the same canonical calls the
// 5.5-era function_call rollouts produce, or every transcript verb goes blind.
// Segmentation is regex-based, not a JS parse: each tools.<verb>( starts a new
// segment, and the JS preamble (often `const p = ".../SKILL.md"`) rides with
// the first segment so content-matching verbs still see referenced paths.
// Subagent verbs arrive under the `multi_agent_v1__` tool prefix (PRI-3097);
// the prefix is optional and non-capturing so the captured verb — and every
// segment offset — stays the same whether or not the rollout carries it.
const EXEC_SCRIPT_VERB_RE =
  /tools\.(?:multi_agent_v1__)?(exec_command|apply_patch|update_plan|write_stdin|spawn_agent|wait_agent|close_agent|send_input)\s*\(/g;

function unescapeJsLiteral(body: string): string {
  return body.replace(/\\(.)/g, (_, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch;
  });
}

// Extract `<key>: "<literal>"` from a JS segment when the value is a static
// string literal. Template literals with ${…} interpolate variables defined
// elsewhere in the script, so they are NOT extracted — the caller keeps the
// whole segment instead, which still contains whatever the variables name.
function plainStringProp(segment: string, key: string): string | null {
  const re = new RegExp(
    `\\b${key}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)`,
  );
  const m = re.exec(segment);
  const lit = m?.[1];
  if (!lit) return null;
  const body = lit.slice(1, -1);
  if (lit.startsWith('`') && body.includes('${')) return null;
  return unescapeJsLiteral(body);
}

// Provenance convention for unified_exec unpacking (documented in
// docs/atif-unified-exec-convention.md): every call derived from an exec
// script is stamped with the physical rollout call that executed it
// (composite_call_id) and the verbatim JS segment it came from (script), so
// the composite structure and the raw script survive the logical flattening
// and parity tooling can re-group the sub-calls.
function stampProvenance(
  call: AtifToolCall,
  compositeCallId: string,
  script: string,
): AtifToolCall {
  const extra: Record<string, unknown> = { script };
  if (compositeCallId) extra['composite_call_id'] = compositeCallId;
  return { ...call, extra };
}

function normalizeExecScript(callId: string, input: string): AtifToolCall[] {
  const matches = [...input.matchAll(EXEC_SCRIPT_VERB_RE)];
  if (matches.length === 0) {
    // Pure JS (or an unrecognized vocabulary): the script IS what executed;
    // carry it whole so shell-content verbs can still match it.
    return [
      stampProvenance(
        {
          tool_call_id: callId,
          function_name: 'Bash',
          arguments: { command: input },
        },
        callId,
        input,
      ),
    ];
  }
  const calls: AtifToolCall[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m) continue;
    const verb = m[1] ?? '';
    const start = i === 0 ? 0 : (m.index ?? 0);
    const next = matches[i + 1];
    const end = next?.index ?? input.length;
    const segment = input.slice(start, end);
    const id = i === 0 ? callId : callId ? `${callId}#${i}` : '';
    if (verb === 'exec_command') {
      const cmd = plainStringProp(segment, 'cmd');
      calls.push(
        stampProvenance(
          {
            tool_call_id: id,
            function_name: 'Bash',
            arguments: { command: cmd ?? segment },
          },
          callId,
          segment,
        ),
      );
      continue;
    }
    if (verb === 'apply_patch') {
      // The patch text is a string/template literal either inline or assigned
      // to a variable in the segment's preamble. Template literals carry real
      // newlines; quoted literals carry \n escapes, so retry unescaped before
      // giving up on path extraction.
      let patchSource = segment;
      if (applyPatchPaths(patchSource).length === 0) {
        const unescaped = unescapeJsLiteral(segment);
        if (applyPatchPaths(unescaped).length > 0) patchSource = unescaped;
      }
      calls.push(
        stampProvenance(
          {
            tool_call_id: id,
            function_name: 'Edit',
            arguments: withPatchPaths({ patch: patchSource }),
          },
          callId,
          segment,
        ),
      );
      continue;
    }
    if (verb === 'spawn_agent') {
      // The dispatch instruction is `message` on the multi_agent_v1 tools.
      const prompt =
        plainStringProp(segment, 'prompt') ??
        plainStringProp(segment, 'task') ??
        plainStringProp(segment, 'message');
      calls.push(
        stampProvenance(
          {
            tool_call_id: id,
            function_name: 'Agent',
            arguments: prompt !== null ? { prompt } : { input: segment },
          },
          callId,
          segment,
        ),
      );
      continue;
    }
    calls.push(
      stampProvenance(
        {
          tool_call_id: id,
          function_name: CODEX_TOOL_MAP[verb] ?? verb,
          arguments: { input: segment },
        },
        callId,
        segment,
      ),
    );
  }
  return calls;
}

function normalizeToolCallPayload(
  payload: CodexPayload,
): AtifToolCall[] | null {
  if (payload.type === 'function_call') {
    const p = payload as CodexFunctionCallPayload;
    const name = p.name ?? '';
    const args = parseArgs(p.arguments);
    const callId = p.call_id ?? '';
    if (name === 'exec_command') {
      return [
        {
          tool_call_id: callId,
          function_name: 'Bash',
          arguments: {
            command: typeof args['cmd'] === 'string' ? args['cmd'] : '',
          },
        },
      ];
    }
    if (name === 'apply_patch') {
      return [
        {
          tool_call_id: callId,
          function_name: 'Edit',
          arguments: withPatchPaths(args),
        },
      ];
    }
    const canonical = CODEX_TOOL_MAP[name] ?? name;
    return [
      canonicalizeAgentPrompt({
        tool_call_id: callId,
        function_name: canonical,
        arguments: args,
      }),
    ];
  }

  if (payload.type === 'custom_tool_call') {
    const p = payload as CodexCustomToolCallPayload;
    const name = p.name ?? '';
    const callId = p.call_id ?? '';
    if (name === 'apply_patch') {
      return [
        {
          tool_call_id: callId,
          function_name: 'Edit',
          arguments: withPatchPaths({ patch: p.input ?? '' }),
        },
      ];
    }
    if (name === 'exec') {
      return normalizeExecScript(callId, p.input ?? '');
    }
    const canonical = CODEX_TOOL_MAP[name] ?? name;
    return [
      {
        tool_call_id: callId,
        function_name: canonical,
        arguments: { input: p.input ?? '' },
      },
    ];
  }

  if (payload.type === 'local_shell_call') {
    const p = payload as CodexLocalShellCallPayload;
    const cmd = p.action?.command ?? [];
    const cmdStr = Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
    return [
      {
        tool_call_id: '',
        function_name: 'Bash',
        arguments: { command: cmdStr },
      },
    ];
  }

  if (payload.type === 'web_search_call') {
    const p = payload as CodexWebSearchCallPayload;
    const action = p.action ?? {};
    const arguments_: Record<string, unknown> = {
      action_type: action.type ?? '',
    };
    if (action.query !== undefined) arguments_['query'] = action.query;
    if (action.queries !== undefined) arguments_['queries'] = action.queries;
    if (action.url !== undefined) arguments_['url'] = action.url;
    return [
      {
        tool_call_id: '',
        function_name: 'WebSearch',
        arguments: arguments_,
      },
    ];
  }

  // Codex's native tool-discovery call. It carries a call_id, so its
  // tool_search_output pairs onto it like a function_call_output.
  if (payload.type === 'tool_search_call') {
    const p = payload as CodexToolSearchCallPayload;
    return [
      {
        tool_call_id: p.call_id ?? '',
        function_name: 'ToolSearch',
        arguments: parseArgs(p.arguments),
      },
    ];
  }

  return null;
}

/**
 * Convert a Codex rollout log (JSONL) into an ATIF v1.7 trajectory.
 *
 * Codex logs use:
 *   {"type": "session_meta", "payload": {"id": ..., "cli_version": ...}}
 *   {"type": "response_item", "payload": {"type": "message", ...}}
 *   {"type": "response_item", "payload": {"type": "reasoning", "summary": [...]}}
 *   {"type": "response_item", "payload": {"type": "function_call", ...}}
 *   {"type": "response_item", "payload": {"type": "function_call_output", "call_id": ..., "output": ...}}
 *   {"type": "response_item", "payload": {"type": "custom_tool_call", ...}}
 *   {"type": "response_item", "payload": {"type": "custom_tool_call_output", ...}}
 *   {"type": "response_item", "payload": {"type": "local_shell_call", ...}}
 *   {"type": "response_item", "payload": {"type": "web_search_call", ...}}
 *   {"type": "response_item", "payload": {"type": "tool_search_call", "call_id": ..., "arguments": ...}}
 *   {"type": "response_item", "payload": {"type": "tool_search_output", "call_id": ..., "tools": ...}}
 *
 * Full-fidelity features:
 *   - message events → user/agent/system steps
 *   - reasoning events → reasoning_content carried onto the next step
 *   - function_call_output / custom_tool_call_output → observation paired by call_id
 *   - web_search_call → tool-call step with function_name "web_search_call"
 *   - tool_search_call → tool-call step with function_name "ToolSearch"; tool_search_output pairs by call_id
 *   - session_meta → session_id, agent.version, agent.extra (cwd/git/originator/instructions)
 */
export function normalizeCodex(
  raw: string,
  version: string,
  onMalformedLine?: (line: number, message: string) => void,
): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  // Deduplicate local_shell_call / web_search_call (no call_id) by a synthetic
  // counter. For function_call and custom_tool_call, deduplicate by call_id.
  const seenCallIds = new Set<string>();

  // Last cumulative session usage and model, harvested from the non-tool rows.
  let sessionUsage: CodexTokenUsage | undefined;
  let modelName: string | undefined;
  // Per-turn usage deltas (each token_count's last_token_usage), in order. These
  // sum to the cumulative but carry real per-request sizes, so obol tiers each
  // turn correctly (see the attachment step below).
  const turnUsages: Array<{
    usage: CodexTokenUsage;
    line: number;
    timestamp?: string;
  }> = [];
  let previousUsageEvent:
    | { total: CodexTokenUsage; last: CodexTokenUsage }
    | undefined;

  // Session metadata fields.
  let sessionId: string | undefined;
  let agentVersion = version;
  let agentExtra: Record<string, unknown> | undefined;
  let userOrigin: 'parent' | 'unknown' = 'unknown';
  let sessionUsageEvidence: { line: number; timestamp?: string } | undefined;
  const boundaries: NativeBoundary[] = [];
  const communications: NativeCommunication[] = [];

  // Pending reasoning to carry forward onto the next tool-call or message step.
  let pendingReasoning: string | undefined;
  let pendingReasoningLines: number[] = [];

  // Map from call_id → step index in `steps`, for attaching outputs to calls.
  // Once an output is attached, the call_id is marked completed.
  const pendingCallStepIndex = new Map<string, number>();
  const completedCallIds = new Set<string>();

  for (const [lineIndex, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      onMalformedLine?.(
        lineIndex + 1,
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    const sourceLine = lineIndex + 1;
    const entryTimestamp =
      typeof entry['timestamp'] === 'string' ? entry['timestamp'] : undefined;

    // session_meta: extract session_id, agent version, and extra fields.
    if (entry['type'] === 'session_meta') {
      const p = entry['payload'];
      if (p && typeof p === 'object') {
        const payload = p as Record<string, unknown>;
        if (typeof payload['id'] === 'string') sessionId = payload['id'];
        if (
          typeof payload['cli_version'] === 'string' &&
          payload['cli_version']
        )
          agentVersion = payload['cli_version'];
        const extra: Record<string, unknown> = {};
        for (const key of [
          'originator',
          'cwd',
          'git',
          'instructions',
          'parent_thread_id',
          'thread_source',
          'agent_nickname',
          'agent_path',
          'source',
        ] as const) {
          const value = payload[key];
          if (value !== undefined) extra[key] = value;
        }
        const parentSessionId = payload['session_id'];
        if (
          typeof parentSessionId === 'string' &&
          parentSessionId &&
          parentSessionId !== payload['id']
        )
          extra['parent_session_id'] = parentSessionId;
        if (
          (typeof payload['parent_thread_id'] === 'string' &&
            payload['parent_thread_id']) ||
          payload['thread_source'] === 'subagent'
        )
          userOrigin = 'parent';
        if (Object.keys(extra).length > 0) agentExtra = extra;
      }
      continue;
    }

    // token_count events ride on `event_msg` rows, not `response_item`.
    if (entry['type'] === 'event_msg') {
      const payload = entry['payload'];
      const payloadType =
        payload && typeof payload === 'object'
          ? (payload as { type?: unknown }).type
          : undefined;
      if (payloadType === 'task_started' || payloadType === 'task_complete') {
        const durationMs = (payload as Record<string, unknown>)['duration_ms'];
        boundaries.push({
          kind: 'task',
          phase: payloadType === 'task_started' ? 'start' : 'complete',
          ...(payloadType === 'task_complete' &&
          typeof durationMs === 'number' &&
          Number.isFinite(durationMs) &&
          durationMs >= 0
            ? { durationMs }
            : {}),
          evidence: {
            lines: [sourceLine],
            ...(entryTimestamp ? { timestamp: entryTimestamp } : {}),
          },
        });
      } else if (
        typeof payloadType === 'string' &&
        payloadType.toLowerCase().includes('compact')
      ) {
        boundaries.push({
          kind: 'compaction',
          evidence: {
            lines: [sourceLine],
            ...(entryTimestamp ? { timestamp: entryTimestamp } : {}),
          },
        });
      }
      if (
        payload &&
        typeof payload === 'object' &&
        (payload as { type?: unknown }).type === 'token_count'
      ) {
        const info = (payload as { info?: unknown }).info;
        if (info && typeof info === 'object') {
          const total = asTokenUsage(
            (info as { total_token_usage?: unknown }).total_token_usage,
          );
          const last = asTokenUsage(
            (info as { last_token_usage?: unknown }).last_token_usage,
          );
          // Codex may repeat its usage snapshot without making another request.
          // Both counters must match; equal request sizes alone are billable.
          const repeated =
            total !== undefined &&
            last !== undefined &&
            previousUsageEvent !== undefined &&
            sameTokenUsage(total, previousUsageEvent.total) &&
            sameTokenUsage(last, previousUsageEvent.last);
          if (total) {
            sessionUsage = total;
            sessionUsageEvidence = {
              line: sourceLine,
              ...(entryTimestamp ? { timestamp: entryTimestamp } : {}),
            };
          }
          if (last && !repeated)
            turnUsages.push({
              usage: last,
              line: sourceLine,
              ...(entryTimestamp ? { timestamp: entryTimestamp } : {}),
            });
          previousUsageEvent = total && last ? { total, last } : undefined;
        }
      }
      continue;
    }

    // Model is recorded on turn_context (and the session_meta source); take the
    // first one we see.
    if (entry['type'] === 'turn_context') {
      const payload = entry['payload'];
      const model =
        payload && typeof payload === 'object'
          ? (payload as { model?: unknown }).model
          : undefined;
      if (modelName === undefined && typeof model === 'string' && model)
        modelName = model;
      boundaries.push({
        kind: 'turn',
        phase: 'start',
        evidence: {
          lines: [sourceLine],
          ...(entryTimestamp ? { timestamp: entryTimestamp } : {}),
        },
      });
      continue;
    }

    if (entry['type'] !== 'response_item') continue;

    // Codex uses "payload" (real runs) or "item" (test fixtures using item key).
    const payload = (entry['payload'] ?? entry['item'] ?? {}) as CodexPayload;
    const timestamp = entryTimestamp;

    if (payload.type === 'agent_message') {
      const native = payload as unknown as Record<string, unknown>;
      const content = Array.isArray(native['content']) ? native['content'] : [];
      const contentKinds = content.flatMap((block) => {
        if (!block || typeof block !== 'object') return [];
        const type = (block as Record<string, unknown>)['type'];
        return typeof type === 'string' ? [type] : [];
      });
      const id = native['id'];
      const author = native['author'];
      const recipient = native['recipient'];
      communications.push({
        ...(typeof id === 'string' && id ? { id } : {}),
        ...(typeof author === 'string' && author ? { author } : {}),
        ...(typeof recipient === 'string' && recipient ? { recipient } : {}),
        contentKinds,
        opaqueContent: contentKinds.includes('encrypted_content'),
        evidence: {
          lines: [sourceLine],
          ...(timestamp ? { timestamp } : {}),
        },
      });
      continue;
    }

    // ── reasoning event: store pending_reasoning, do NOT emit a step ──────────
    if (payload.type === 'reasoning') {
      const p = payload as CodexReasoningPayload;
      const summary = p.summary;
      if (Array.isArray(summary) && summary.length > 0) {
        pendingReasoning = summary
          .filter((item): item is string => typeof item === 'string')
          .join('\n');
        if (!pendingReasoning) pendingReasoning = undefined;
        pendingReasoningLines = pendingReasoning ? [sourceLine] : [];
      } else {
        pendingReasoning = undefined;
        pendingReasoningLines = [];
      }
      continue;
    }

    // ── message event: emit a user/agent/system step ──────────────────────────
    if (payload.type === 'message') {
      const p = payload as CodexMessagePayload;
      const role = p.role ?? 'user';
      const content = Array.isArray(p.content) ? p.content : [];
      const text = extractMessageText(content);

      let source: 'user' | 'agent' | 'system';
      if (role === 'assistant') source = 'agent';
      else if (role === 'user') source = 'user';
      else source = 'system';
      const consumesReasoning = source === 'agent' && pendingReasoning;

      const step: AtifStep = {
        step_id: stepId++,
        source,
        extra: withNativeEvidence(undefined, {
          lines: consumesReasoning
            ? [...pendingReasoningLines, sourceLine]
            : [sourceLine],
          ...(source === 'user' ? { origin: userOrigin } : {}),
        }),
      };
      if (timestamp) step.timestamp = timestamp;
      if (text) step.message = text;
      // Carry reasoning onto assistant message steps
      if (consumesReasoning) {
        step.reasoning_content = consumesReasoning;
        pendingReasoning = undefined;
        pendingReasoningLines = [];
      }
      steps.push(step);
      continue;
    }

    // ── function_call_output / custom_tool_call_output: attach to pending call ─
    if (
      payload.type === 'function_call_output' ||
      payload.type === 'custom_tool_call_output' ||
      payload.type === 'tool_search_output'
    ) {
      const p = payload as
        | CodexFunctionCallOutputPayload
        | CodexToolSearchOutputPayload;
      const callId = p.call_id;
      const nativeOutput = p.type === 'tool_search_output' ? p.tools : p.output;
      const outputText = parseOutputBlob(nativeOutput);

      // Build the observation result; only set optional fields when they have a value
      // (exactOptionalPropertyTypes forbids assigning undefined to optional string props).
      const contentBytes = nativeTextBytesFromCodexOutput(nativeOutput);
      const obsResult: AtifObservation['results'][number] = {
        extra: withNativeEvidence(undefined, {
          lines: [sourceLine],
          origin: 'unknown',
          ...(timestamp ? { timestamp } : {}),
          ...(contentBytes !== undefined ? { contentBytes } : {}),
          recordBytes: nativeRecordBytes(line),
        }),
      };
      const isError = nativeCodexResultError(nativeOutput);
      if (isError !== undefined)
        obsResult.extra = {
          ...obsResult.extra,
          quorum_result: { isError } satisfies NativeToolResultEvidence,
        };
      if (callId) obsResult.source_call_id = callId;
      if (outputText !== undefined) obsResult.content = outputText;

      if (callId && !completedCallIds.has(callId)) {
        const ownerIdx = pendingCallStepIndex.get(callId);
        if (ownerIdx !== undefined) {
          // Attach to the existing call step
          const owner = steps[ownerIdx];
          if (!owner) continue;
          const subcalls = nativeCodexSubcallResults(
            owner.tool_calls ?? [],
            callId,
            nativeOutput,
          );
          if (subcalls)
            obsResult.extra = {
              ...obsResult.extra,
              quorum_result: {
                ...(isError !== undefined ? { isError } : {}),
                subcalls,
              } satisfies NativeToolResultEvidence,
            };
          owner.observation ??= { results: [] };
          owner.observation.results.push(obsResult);
          const childIdentity = childIdentityFromCodexOutput(nativeOutput);
          const ownerCall = owner.tool_calls?.find(
            (candidate) => candidate.tool_call_id === callId,
          );
          const child = ownerCall?.extra?.['quorum_child'];
          if (
            childIdentity &&
            ownerCall?.function_name === 'Agent' &&
            child &&
            typeof child === 'object'
          ) {
            const identified = {
              ...(child as NativeChildEvidence),
              ...childIdentity,
            };
            ownerCall.extra = { ...ownerCall.extra, quorum_child: identified };
            obsResult.extra = { ...obsResult.extra, quorum_child: identified };
          }
          completedCallIds.add(callId);
          pendingCallStepIndex.delete(callId);
          continue;
        }
      } else if (callId && completedCallIds.has(callId)) {
        // Repeated output for same call_id — skip gracefully
        continue;
      }

      // Orphan output (no matching pending call): emit its own step.
      // Drop source_call_id since there's no matching tool_call in this step
      // (ATIF validator requires source_call_id to match a tool_call_id).
      const orphanResult: AtifObservation['results'][number] = {
        ...(obsResult.extra ? { extra: obsResult.extra } : {}),
      };
      if (outputText !== undefined) orphanResult.content = outputText;
      const orphanObservation: AtifObservation = {
        results: [orphanResult],
      };
      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        observation: orphanObservation,
        extra: withNativeEvidence(undefined, { lines: [sourceLine] }),
      };
      if (timestamp) step.timestamp = timestamp;
      steps.push(step);
      continue;
    }

    // ── tool call events ───────────────────────────────────────────────────────
    // One rollout payload can normalize to SEVERAL canonical calls (the 5.6
    // unified `exec` tool); they share one step, and the FIRST call keeps the
    // rollout call_id so the payload's single output pairs onto it.
    const tcs = normalizeToolCallPayload(payload);
    const first = tcs?.[0];
    if (!tcs || !first) continue;

    // Deduplicate: skip if we've seen this call_id (non-empty).
    if (first.tool_call_id && seenCallIds.has(first.tool_call_id)) continue;
    if (first.tool_call_id) seenCallIds.add(first.tool_call_id);

    const step: AtifStep = {
      step_id: stepId++,
      source: 'agent',
      tool_calls: tcs,
      extra: withNativeEvidence(undefined, {
        lines: [...pendingReasoningLines, sourceLine],
      }),
    };
    for (const tc of tcs) {
      tc.extra = withNativeEvidence(tc.extra, { lines: [sourceLine] });
      if (tc.function_name === 'Agent') {
        tc.extra = {
          ...tc.extra,
          quorum_child: {
            relationship: agentRelationship(tc),
          } satisfies NativeChildEvidence,
        };
      }
    }
    if (timestamp) step.timestamp = timestamp;

    // Attach pending reasoning and clear it
    if (pendingReasoning) {
      step.reasoning_content = pendingReasoning;
      pendingReasoning = undefined;
      pendingReasoningLines = [];
    }

    // Register this step for output pairing (only for calls with a real call_id)
    if (first.tool_call_id) {
      pendingCallStepIndex.set(first.tool_call_id, steps.length);
    }

    steps.push(step);
  }

  // ATIF requires at least one step. If log was empty/unparseable, emit a
  // minimal user step so validateTrajectory doesn't reject it.
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // Hang each turn's usage delta on its own agent step, tagged with the session
  // model. PER-TURN (not the session cumulative) so obol prices each request at
  // its real size: obol decides large-context pricing tiers per step, and a
  // single lumped multi-million-token step would trip a tier that no real
  // per-turn request ever hit. After the multi-session merge this also
  // attributes tokens to each subagent's actual model rather than the
  // orchestrator's single envelope. The deltas sum to the cumulative, so totals
  // are preserved; final_metrics keeps that cumulative (obol ignores it when
  // per-step metrics are present). Extra deltas (turns with no tool-call step)
  // become synthetic usage-only steps so no turn's tokens are dropped.
  if (modelName && turnUsages.length > 0) {
    const agentSteps = steps.filter((s) => s.source === 'agent');
    for (const [i, locatedUsage] of turnUsages.entries()) {
      const usage = locatedUsage.usage;
      const metrics = stepMetricsFromUsage(usage);
      metrics.extra = withNativeEvidence(metrics.extra, {
        lines: [locatedUsage.line],
        ...(locatedUsage.timestamp
          ? { timestamp: locatedUsage.timestamp }
          : {}),
      });
      const target = agentSteps[i];
      if (target) {
        target.model_name = modelName;
        target.metrics = metrics;
      } else {
        steps.push({
          step_id: 0,
          source: 'agent',
          model_name: modelName,
          metrics,
          extra: withNativeEvidence(undefined, { lines: [locatedUsage.line] }),
        });
      }
    }
  }

  // Reassign sequential step_ids (step numbering must be 1-based sequential
  // even if steps were added out of order or skipped in processing).
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step) step.step_id = i + 1;
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'codex', version: agentVersion },
    steps,
  };
  if (sessionId) traj.session_id = sessionId;
  if (modelName) traj.agent.model_name = modelName;
  if (agentExtra) traj.agent.extra = agentExtra;
  if (sessionUsage) {
    traj.final_metrics = finalMetricsFromUsage(sessionUsage);
    if (sessionUsageEvidence) {
      traj.final_metrics.extra = withNativeEvidence(traj.final_metrics.extra, {
        lines: [sessionUsageEvidence.line],
        ...(sessionUsageEvidence.timestamp
          ? { timestamp: sessionUsageEvidence.timestamp }
          : {}),
      });
    }
  }
  if (boundaries.length > 0)
    traj.extra = { ...traj.extra, quorum_boundaries: boundaries };
  if (communications.length > 0)
    traj.extra = { ...traj.extra, quorum_communications: communications };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeCodex produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}

export { NATIVE_TOOLS };
