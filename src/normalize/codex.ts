import {
  ATIF_SCHEMA_VERSION,
  type AtifFinalMetrics,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';

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

type CodexPayload =
  | CodexFunctionCallPayload
  | CodexCustomToolCallPayload
  | CodexLocalShellCallPayload
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

function normalizePayload(payload: CodexPayload): AtifToolCall | null {
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
    return {
      tool_call_id: callId,
      function_name: canonical,
      arguments: args,
    };
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

  return null;
}

/**
 * Convert a Codex rollout log (JSONL) into an ATIF v1.7 trajectory.
 *
 * Codex logs use:
 *   {"type": "response_item", "payload": {"type": "function_call", ...}}
 *   {"type": "response_item", "payload": {"type": "custom_tool_call", ...}}
 *   {"type": "response_item", "payload": {"type": "local_shell_call", ...}}
 *
 * All tool calls are collected into a single agent step, since Codex rollout
 * logs do not carry separate message/turn structure. Each tool call gets its
 * own step to match the ATIF convention of one step per logical action.
 */
export function normalizeCodex(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  // Deduplicate local_shell_call by a synthetic id since they lack call_id.
  // For function_call and custom_tool_call, deduplicate by call_id.
  const seenCallIds = new Set<string>();

  // Last cumulative session usage and model, harvested from the non-tool rows.
  let sessionUsage: CodexTokenUsage | undefined;
  let modelName: string | undefined;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
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

    const tc = normalizePayload(payload);
    if (!tc) continue;

    // Deduplicate: skip if we've seen this call_id (non-empty).
    if (tc.tool_call_id && seenCallIds.has(tc.tool_call_id)) continue;
    if (tc.tool_call_id) seenCallIds.add(tc.tool_call_id);

    steps.push({
      step_id: stepId++,
      source: 'agent',
      tool_calls: [tc],
    });
  }

  // ATIF requires at least one step. If log was empty/unparseable, emit a
  // minimal user step so validateTrajectory doesn't reject it.
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'codex', version },
    steps,
  };
  if (modelName) traj.agent.model_name = modelName;
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
