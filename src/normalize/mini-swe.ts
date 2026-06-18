// Ported from Harbor's src/harbor/agents/installed/mini_swe_agent.py
//   repo:   https://github.com/laude-institute/harbor (Apache-2.0)
//   commit: 5352049de712613e58459cad41afcf0bf8645738 (v0.14.0)
// Log-parsing logic is derived from Harbor; token buckets, tool-name
// canonicalization, and message-id dedup follow OUR conventions
// (docs/superpowers/reference/atif-normalizers.md), NOT Harbor's.

import {
  ATIF_SCHEMA_VERSION,
  type AtifMetrics,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// Reverse mapping: mini-swe-agent native tool names → canonical names.
// mini-swe-agent primarily uses "bash" as its main tool. Unknown names pass through.
const MINI_SWE_TOOL_MAP: Record<string, string> = {
  bash: 'Bash',
  computer: 'Bash', // fallback for any computer-use alias
  str_replace_editor: 'Edit',
  str_replace_based_edit_tool: 'Edit',
  create_file: 'Write',
  view: 'Read',
  find_file: 'Glob',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
};

/**
 * Normalize message content which may be a string, list of parts, or null.
 * Mirrors Harbor's _normalize_content.
 */
function normalizeContent(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const part of raw) {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        const text = p['text'];
        parts.push(typeof text === 'string' ? text : JSON.stringify(part));
      } else {
        parts.push(String(part));
      }
    }
    return parts.join('\n');
  }
  return String(raw);
}

/**
 * Normalize upstream timestamps to ISO 8601. Accepts epoch seconds (int/float)
 * or existing ISO strings. Returns undefined when no valid timestamp is found.
 * Mirrors Harbor's _iso_timestamp.
 */
function isoTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      return new Date(value * 1000).toISOString().replace('Z', '+00:00');
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'string' && value) {
    try {
      return new Date(value.replace('Z', '+00:00'))
        .toISOString()
        .replace('Z', '+00:00');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Return the best upstream timestamp from a message.
 * Mirrors Harbor's _message_timestamp: tries created_at, timestamp, completed_at,
 * then extra.timestamp.
 */
function messageTimestamp(
  message: Record<string, unknown>,
): string | undefined {
  for (const field of ['created_at', 'timestamp', 'completed_at'] as const) {
    const ts = isoTimestamp(message[field]);
    if (ts) return ts;
  }
  const extra = message['extra'];
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    const ts = isoTimestamp((extra as Record<string, unknown>)['timestamp']);
    if (ts) return ts;
  }
  return undefined;
}

interface MessageUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number; // from prompt_tokens_details.cached_tokens
  reasoning_tokens: number; // from completion_tokens_details.reasoning_tokens
}

/**
 * Extract normalized usage from a message.
 *
 * Handles two shapes mini-swe-agent emits:
 * - LitellmModel (chat completions): usage under extra.response.usage with
 *   prompt_tokens / completion_tokens.
 * - LitellmResponseModel (Responses API): usage at top level with
 *   input_tokens / output_tokens when object == "response".
 *
 * Mirrors Harbor's _message_usage.
 */
function messageUsage(message: Record<string, unknown>): MessageUsage {
  // LitellmModel path: usage in extra.response.usage
  const extra = message['extra'];
  let usage: Record<string, unknown> = {};
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    const response = (extra as Record<string, unknown>)['response'];
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      const u = (response as Record<string, unknown>)['usage'];
      if (u && typeof u === 'object' && !Array.isArray(u)) {
        usage = u as Record<string, unknown>;
      }
    }
  }

  // LitellmResponseModel path: usage at top level when object == "response"
  if (Object.keys(usage).length === 0 && message['object'] === 'response') {
    const u = message['usage'];
    if (u && typeof u === 'object' && !Array.isArray(u)) {
      usage = u as Record<string, unknown>;
    }
  }

  const promptTokens =
    typeof usage['prompt_tokens'] === 'number'
      ? usage['prompt_tokens']
      : typeof usage['input_tokens'] === 'number'
        ? usage['input_tokens']
        : 0;

  const completionTokens =
    typeof usage['completion_tokens'] === 'number'
      ? usage['completion_tokens']
      : typeof usage['output_tokens'] === 'number'
        ? usage['output_tokens']
        : 0;

  const ptDetails =
    usage['prompt_tokens_details'] ?? usage['input_tokens_details'];
  const ctDetails =
    usage['completion_tokens_details'] ?? usage['output_tokens_details'];

  const ptDetailsObj =
    ptDetails && typeof ptDetails === 'object' && !Array.isArray(ptDetails)
      ? (ptDetails as Record<string, unknown>)
      : {};
  const ctDetailsObj =
    ctDetails && typeof ctDetails === 'object' && !Array.isArray(ctDetails)
      ? (ctDetails as Record<string, unknown>)
      : {};

  const cachedTokens =
    typeof ptDetailsObj['cached_tokens'] === 'number'
      ? ptDetailsObj['cached_tokens']
      : 0;
  const reasoningTokens =
    typeof ctDetailsObj['reasoning_tokens'] === 'number'
      ? ctDetailsObj['reasoning_tokens']
      : 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached_tokens: cachedTokens,
    reasoning_tokens: reasoningTokens,
  };
}

/**
 * Parse tool arguments: accepts a JSON string, a dict, or any other value.
 * Mirrors Harbor's _parse_tool_calls argument handling.
 */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
      return { command: raw };
    } catch {
      return { command: raw };
    }
  }
  return { command: String(raw) };
}

/**
 * Build per-step ATIF metrics from message usage, applying DISJOINT bucket
 * correction: prompt_tokens in the log is INCLUSIVE of cache, so we subtract
 * cached_tokens to get the uncached-only prompt_tokens for our disjoint bucket.
 *
 * Returns undefined when both prompt and completion are zero (no usage).
 */
function buildStepMetrics(usage: MessageUsage): AtifMetrics | undefined {
  const {
    prompt_tokens: rawPrompt,
    completion_tokens: completion,
    cached_tokens: cached,
  } = usage;
  if (rawPrompt === 0 && completion === 0) return undefined;

  // DISJOINT: uncached input only
  const uncachedPrompt = Math.max(0, rawPrompt - cached);

  const metrics: AtifMetrics = {};
  if (uncachedPrompt > 0) metrics.prompt_tokens = uncachedPrompt;
  if (completion > 0) metrics.completion_tokens = completion;
  if (cached > 0) metrics.cached_tokens = cached;

  // If all three are zero after correction (shouldn't happen if raw > 0, but guard)
  if (Object.keys(metrics).length === 0) return undefined;
  return metrics;
}

/**
 * Convert a mini-swe-agent v2 trajectory JSON string to an ATIF v1.7 trajectory.
 *
 * mini-swe-agent uses a flat messages array with roles: system, user, assistant,
 * tool, and exit. Tool calls are in assistant messages' tool_calls array.
 * Tool results are in role=="tool" messages (or role=="user" at index > 1).
 *
 * Token conventions (DISJOINT):
 * - prompt_tokens in the log is INCLUSIVE of cached_tokens → subtract cached
 *   to get uncached-only prompt_tokens for our disjoint bucket.
 * - cached_tokens → metrics.cached_tokens
 * - completion_tokens stays as-is
 * - No cache_write bucket (mini-swe-agent logs don't carry cache_creation)
 *
 * Cost: info.model_stats.instance_cost is a session total → distributed across
 * agent steps as per-step metrics.cost_usd (proportional to completion tokens),
 * passthrough not computed. obol honors per-step cost_usd but ignores
 * final_metrics.total_cost_usd when per-step token metrics are present, so the
 * cost must ride per-step to be counted.
 *
 * Token SINGLE-SOURCE: per-message usage is present → per-step metrics only,
 * NO final_metrics token totals (to avoid obol double-count).
 *
 * format: `mini-swe-agent.trajectory.json`
 */
export function normalizeMiniSwe(raw: string, version: string): AtifTrajectory {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    data = {};
  }

  // Extract metadata
  const info =
    data['info'] &&
    typeof data['info'] === 'object' &&
    !Array.isArray(data['info'])
      ? (data['info'] as Record<string, unknown>)
      : {};
  const config =
    info['config'] &&
    typeof info['config'] === 'object' &&
    !Array.isArray(info['config'])
      ? (info['config'] as Record<string, unknown>)
      : {};
  const modelConfig =
    config['model'] &&
    typeof config['model'] === 'object' &&
    !Array.isArray(config['model'])
      ? (config['model'] as Record<string, unknown>)
      : {};
  const agentConfig =
    config['agent'] &&
    typeof config['agent'] === 'object' &&
    !Array.isArray(config['agent'])
      ? (config['agent'] as Record<string, unknown>)
      : {};

  const modelName =
    typeof modelConfig['model_name'] === 'string' && modelConfig['model_name']
      ? modelConfig['model_name']
      : 'unknown';

  const miniVersion =
    typeof info['mini_version'] === 'string' && info['mini_version']
      ? info['mini_version']
      : version;

  const trajectoryFormat =
    typeof data['trajectory_format'] === 'string'
      ? data['trajectory_format']
      : 'unknown';

  // Session cost from info.model_stats.instance_cost — passthrough, do NOT compute
  const modelStats =
    info['model_stats'] &&
    typeof info['model_stats'] === 'object' &&
    !Array.isArray(info['model_stats'])
      ? (info['model_stats'] as Record<string, unknown>)
      : {};
  const instanceCost =
    typeof modelStats['instance_cost'] === 'number'
      ? modelStats['instance_cost']
      : 0;

  const messages = Array.isArray(data['messages'])
    ? (data['messages'] as unknown[])
    : [];

  const steps: AtifStep[] = [];
  let stepId = 1;

  // Map from tool_call_id → step index, for attaching tool results to the right step
  const callIdToStepIndex = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || typeof message !== 'object' || Array.isArray(message))
      continue;
    const msg = message as Record<string, unknown>;
    const role = typeof msg['role'] === 'string' ? msg['role'] : '';
    const content = normalizeContent(msg['content']);
    const timestamp = messageTimestamp(msg);

    if (role === 'system') {
      const step: AtifStep = { step_id: stepId++, source: 'system' };
      if (timestamp) step.timestamp = timestamp;
      if (content) step.message = content;
      steps.push(step);
      continue;
    }

    if (role === 'user') {
      if (i === 1) {
        // Only the first user message (index 1) becomes a user step.
        // Mirrors Harbor: i==1 check.
        const step: AtifStep = { step_id: stepId++, source: 'user' };
        if (timestamp) step.timestamp = timestamp;
        if (content) step.message = content;
        steps.push(step);
      } else {
        // Later user messages become observations on the last agent step.
        addObservationToLastAgentStep(steps, content, timestamp);
      }
      continue;
    }

    if (role === 'tool') {
      // tool messages are tool results — attach to the last agent step
      const toolCallId =
        typeof msg['tool_call_id'] === 'string'
          ? msg['tool_call_id']
          : undefined;
      addToolResultToOwningStep(
        steps,
        callIdToStepIndex,
        content,
        toolCallId,
        timestamp,
      );
      continue;
    }

    if (role === 'assistant') {
      const usage = messageUsage(msg);
      const metrics = buildStepMetrics(usage);

      // Parse tool calls
      const rawToolCalls = Array.isArray(msg['tool_calls'])
        ? msg['tool_calls']
        : null;
      let toolCalls: AtifToolCall[] | undefined;
      let reasoningContent: string | undefined;

      if (rawToolCalls && rawToolCalls.length > 0) {
        toolCalls = [];
        for (let tcIdx = 0; tcIdx < rawToolCalls.length; tcIdx++) {
          const tc = rawToolCalls[tcIdx];
          if (!tc || typeof tc !== 'object' || Array.isArray(tc)) continue;
          const tcObj = tc as Record<string, unknown>;
          const tcId =
            typeof tcObj['id'] === 'string' && tcObj['id']
              ? tcObj['id']
              : `call_${stepId}_${tcIdx + 1}`;
          const func =
            tcObj['function'] &&
            typeof tcObj['function'] === 'object' &&
            !Array.isArray(tcObj['function'])
              ? (tcObj['function'] as Record<string, unknown>)
              : {};
          const funcName =
            typeof func['name'] === 'string' && func['name']
              ? func['name']
              : 'bash';
          const canonicalName = MINI_SWE_TOOL_MAP[funcName] ?? funcName;
          const args = parseToolArguments(func['arguments']);

          const atifCall: AtifToolCall = canonicalizeAgentPrompt({
            tool_call_id: tcId,
            function_name: canonicalName,
            arguments: args,
          });
          toolCalls.push(atifCall);
        }
        if (toolCalls.length === 0) toolCalls = undefined;
        // In tool-calling mode, the assistant content is reasoning/thinking
        reasoningContent = content || undefined;
      } else {
        // No tool calls: content is reasoning (Harbor's _parse_tool_calls: "no tool_calls → reasoning")
        reasoningContent = content || undefined;
      }

      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        model_name: modelName,
      };
      if (timestamp) step.timestamp = timestamp;
      if (toolCalls) step.tool_calls = toolCalls;
      if (reasoningContent) step.reasoning_content = reasoningContent;
      if (metrics) step.metrics = metrics;

      // Register tool call IDs for result pairing
      if (toolCalls) {
        const stepIdx = steps.length;
        for (const atifCall of toolCalls) {
          if (atifCall.tool_call_id) {
            callIdToStepIndex.set(atifCall.tool_call_id, stepIdx);
          }
        }
      }

      steps.push(step);
    }

    // role == 'exit' and any other roles: skip
  }

  // Ensure at least one step
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // Reassign sequential step_ids
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step) step.step_id = i + 1;
  }

  // Distribute instance_cost across agent steps as per-step cost_usd.
  // obol ignores final_metrics.total_cost_usd when per-step metrics are present
  // (it re-prices from tokens). To preserve the log's real cost we must place it
  // on step.metrics.cost_usd. Proportional to each step's completion_tokens;
  // if all completion tokens are 0, split evenly across agent steps.
  if (instanceCost > 0) {
    const agentSteps = steps.filter((s) => s.source === 'agent');
    if (agentSteps.length > 0) {
      const totalCompletion = agentSteps.reduce(
        (sum, s) => sum + (s.metrics?.completion_tokens ?? 0),
        0,
      );
      if (totalCompletion > 0) {
        for (const s of agentSteps) {
          const completion = s.metrics?.completion_tokens ?? 0;
          if (completion > 0) {
            const share = instanceCost * (completion / totalCompletion);
            s.metrics = s.metrics ?? {};
            s.metrics.cost_usd = share;
          }
        }
      } else {
        // All-zero completion: split evenly across agent steps
        const share = instanceCost / agentSteps.length;
        for (const s of agentSteps) {
          s.metrics = s.metrics ?? {};
          s.metrics.cost_usd = share;
        }
      }
    }
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: {
      name: 'mini-swe-agent',
      version: miniVersion,
      model_name: modelName,
      extra: {
        original_format: trajectoryFormat,
        agent_config: agentConfig,
      },
    },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeMiniSwe produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}

/**
 * Append an observation result to the last agent step's observation.
 * Mirrors Harbor's _add_observation_to_last_agent_step.
 */
function addObservationToLastAgentStep(
  steps: AtifStep[],
  content: string,
  timestamp: string | undefined,
): void {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step) continue;
    if (step.source !== 'agent') continue;

    if (timestamp && step.timestamp === undefined) {
      step.timestamp = timestamp;
    }

    const result: AtifObservationResult = { content };
    step.observation ??= { results: [] };
    step.observation.results.push(result);
    return;
  }
}

/**
 * Attach a tool result to the step that owns the matching tool_call_id.
 * If no matching step is found, falls back to the last agent step.
 * Mirrors Harbor's role=="tool" handling which calls _add_observation_to_last_agent_step.
 */
function addToolResultToOwningStep(
  steps: AtifStep[],
  callIdToStepIndex: Map<string, number>,
  content: string,
  toolCallId: string | undefined,
  timestamp: string | undefined,
): void {
  // Try to attach to the step that owns the tool_call_id (for source_call_id linkage)
  if (toolCallId) {
    const ownerIdx = callIdToStepIndex.get(toolCallId);
    if (ownerIdx !== undefined) {
      const owner = steps[ownerIdx];
      if (owner && owner.source === 'agent') {
        if (timestamp && owner.timestamp === undefined)
          owner.timestamp = timestamp;
        const result: AtifObservationResult = {
          source_call_id: toolCallId,
          content,
        };
        owner.observation ??= { results: [] };
        owner.observation.results.push(result);
        return;
      }
    }
  }

  // Fallback: append to last agent step (mirrors Harbor's behavior)
  addObservationToLastAgentStep(steps, content, timestamp);
}
