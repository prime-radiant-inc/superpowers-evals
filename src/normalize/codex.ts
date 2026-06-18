import {
  ATIF_SCHEMA_VERSION,
  type AtifFinalMetrics,
  type AtifObservation,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// Codex token usage lives in `event_msg` rows whose payload.type is
// "token_count". `info.total_token_usage` is the running session cumulative
// (the last one is the session total); `info.last_token_usage` is a per-turn
// delta. Codex rollout steps are individual tool calls with no turn/message
// structure to hang per-turn usage on, so the session total maps to
// AtifTrajectory.final_metrics, not per-step metrics.
interface CodexTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
}

function asTokenUsage(value: unknown): CodexTokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as CodexTokenUsage;
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
  | CodexFunctionCallOutputPayload
  | CodexCustomToolCallOutputPayload
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

function normalizeToolCallPayload(payload: CodexPayload): AtifToolCall | null {
  if (payload.type === 'function_call') {
    const p = payload as CodexFunctionCallPayload;
    const name = p.name ?? '';
    const args = parseArgs(p.arguments);
    const callId = p.call_id ?? '';
    if (name === 'exec_command') {
      return {
        tool_call_id: callId,
        function_name: 'Bash',
        arguments: {
          command: typeof args['cmd'] === 'string' ? args['cmd'] : '',
        },
      };
    }
    if (name === 'apply_patch') {
      return {
        tool_call_id: callId,
        function_name: 'Edit',
        arguments: withPatchPaths(args),
      };
    }
    const canonical = CODEX_TOOL_MAP[name] ?? name;
    return canonicalizeAgentPrompt({
      tool_call_id: callId,
      function_name: canonical,
      arguments: args,
    });
  }

  if (payload.type === 'custom_tool_call') {
    const p = payload as CodexCustomToolCallPayload;
    const name = p.name ?? '';
    const callId = p.call_id ?? '';
    if (name === 'apply_patch') {
      return {
        tool_call_id: callId,
        function_name: 'Edit',
        arguments: withPatchPaths({ patch: p.input ?? '' }),
      };
    }
    const canonical = CODEX_TOOL_MAP[name] ?? name;
    return {
      tool_call_id: callId,
      function_name: canonical,
      arguments: { input: p.input ?? '' },
    };
  }

  if (payload.type === 'local_shell_call') {
    const p = payload as CodexLocalShellCallPayload;
    const cmd = p.action?.command ?? [];
    const cmdStr = Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
    return {
      tool_call_id: '',
      function_name: 'Bash',
      arguments: { command: cmdStr },
    };
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
    return {
      tool_call_id: '',
      function_name: 'WebSearch',
      arguments: arguments_,
    };
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
 *
 * Full-fidelity features:
 *   - message events → user/agent/system steps
 *   - reasoning events → reasoning_content carried onto the next step
 *   - function_call_output / custom_tool_call_output → observation paired by call_id
 *   - web_search_call → tool-call step with function_name "web_search_call"
 *   - session_meta → session_id, agent.version, agent.extra (cwd/git/originator/instructions)
 */
export function normalizeCodex(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  // Deduplicate local_shell_call / web_search_call (no call_id) by a synthetic
  // counter. For function_call and custom_tool_call, deduplicate by call_id.
  const seenCallIds = new Set<string>();

  // Last cumulative session usage and model, harvested from the non-tool rows.
  let sessionUsage: CodexTokenUsage | undefined;
  let modelName: string | undefined;

  // Session metadata fields.
  let sessionId: string | undefined;
  let agentVersion = version;
  let agentExtra: Record<string, unknown> | undefined;

  // Pending reasoning to carry forward onto the next tool-call or message step.
  let pendingReasoning: string | undefined;

  // Map from call_id → step index in `steps`, for attaching outputs to calls.
  // Once an output is attached, the call_id is marked completed.
  const pendingCallStepIndex = new Map<string, number>();
  const completedCallIds = new Set<string>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

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
        ] as const) {
          const value = payload[key];
          if (value !== undefined) extra[key] = value;
        }
        if (Object.keys(extra).length > 0) agentExtra = extra;
      }
      continue;
    }

    // token_count events ride on `event_msg` rows, not `response_item`.
    if (entry['type'] === 'event_msg') {
      const payload = entry['payload'];
      if (
        payload &&
        typeof payload === 'object' &&
        (payload as { type?: unknown }).type === 'token_count'
      ) {
        const info = (payload as { info?: unknown }).info;
        const total =
          info && typeof info === 'object'
            ? asTokenUsage(
                (info as { total_token_usage?: unknown }).total_token_usage,
              )
            : undefined;
        if (total) sessionUsage = total;
      }
      continue;
    }

    // Model is recorded on turn_context (and the session_meta source); take the
    // first one we see.
    if (entry['type'] === 'turn_context' && modelName === undefined) {
      const payload = entry['payload'];
      const model =
        payload && typeof payload === 'object'
          ? (payload as { model?: unknown }).model
          : undefined;
      if (typeof model === 'string' && model) modelName = model;
      continue;
    }

    if (entry['type'] !== 'response_item') continue;

    // Codex uses "payload" (real runs) or "item" (test fixtures using item key).
    const payload = (entry['payload'] ?? entry['item'] ?? {}) as CodexPayload;
    const timestamp =
      typeof entry['timestamp'] === 'string' ? entry['timestamp'] : undefined;

    // ── reasoning event: store pending_reasoning, do NOT emit a step ──────────
    if (payload.type === 'reasoning') {
      const p = payload as CodexReasoningPayload;
      const summary = p.summary;
      if (Array.isArray(summary) && summary.length > 0) {
        pendingReasoning = summary
          .filter((item): item is string => typeof item === 'string')
          .join('\n');
        if (!pendingReasoning) pendingReasoning = undefined;
      } else {
        pendingReasoning = undefined;
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

      const step: AtifStep = { step_id: stepId++, source };
      if (timestamp) step.timestamp = timestamp;
      if (text) step.message = text;
      // Carry reasoning onto assistant message steps
      if (source === 'agent' && pendingReasoning) {
        step.reasoning_content = pendingReasoning;
        pendingReasoning = undefined;
      }
      steps.push(step);
      continue;
    }

    // ── function_call_output / custom_tool_call_output: attach to pending call ─
    if (
      payload.type === 'function_call_output' ||
      payload.type === 'custom_tool_call_output'
    ) {
      const p = payload as CodexFunctionCallOutputPayload;
      const callId = p.call_id;
      const outputText = parseOutputBlob(p.output);

      // Build the observation result; only set optional fields when they have a value
      // (exactOptionalPropertyTypes forbids assigning undefined to optional string props).
      const obsResult: { source_call_id?: string; content?: string | null } =
        {};
      if (callId) obsResult.source_call_id = callId;
      if (outputText !== undefined) obsResult.content = outputText;

      if (callId && !completedCallIds.has(callId)) {
        const ownerIdx = pendingCallStepIndex.get(callId);
        if (ownerIdx !== undefined) {
          // Attach to the existing call step
          const owner = steps[ownerIdx];
          if (!owner) continue;
          owner.observation ??= { results: [] };
          owner.observation.results.push(obsResult);
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
      const orphanResult: { content?: string | null } = {};
      if (outputText !== undefined) orphanResult.content = outputText;
      const orphanObservation: AtifObservation = {
        results: [orphanResult],
      };
      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        observation: orphanObservation,
      };
      if (timestamp) step.timestamp = timestamp;
      steps.push(step);
      continue;
    }

    // ── tool call events ───────────────────────────────────────────────────────
    const tc = normalizeToolCallPayload(payload);
    if (!tc) continue;

    // Deduplicate: skip if we've seen this call_id (non-empty).
    if (tc.tool_call_id && seenCallIds.has(tc.tool_call_id)) continue;
    if (tc.tool_call_id) seenCallIds.add(tc.tool_call_id);

    const step: AtifStep = {
      step_id: stepId++,
      source: 'agent',
      tool_calls: [tc],
    };
    if (timestamp) step.timestamp = timestamp;

    // Attach pending reasoning and clear it
    if (pendingReasoning) {
      step.reasoning_content = pendingReasoning;
      pendingReasoning = undefined;
    }

    // Register this step for output pairing (only for calls with a real call_id)
    if (tc.tool_call_id) {
      pendingCallStepIndex.set(tc.tool_call_id, steps.length);
    }

    steps.push(step);
  }

  // ATIF requires at least one step. If log was empty/unparseable, emit a
  // minimal user step so validateTrajectory doesn't reject it.
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
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
  if (sessionUsage) traj.final_metrics = finalMetricsFromUsage(sessionUsage);

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeCodex produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}

export { NATIVE_TOOLS };
