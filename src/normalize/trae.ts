// Ported from Harbor's src/harbor/agents/installed/trae_agent.py
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

// ---------------------------------------------------------------------------
// Tool name canonicalization
//
// Trae-agent ships with: bash, str_replace_based_edit_tool, sequentialthinking,
// task_done. Unknown names pass through unchanged. No subagent-dispatch tool
// is configured in trae's default tool set, so no Agent alias is needed.
// ---------------------------------------------------------------------------
const TRAE_TOOL_MAP: Record<string, string> = {
  bash: 'Bash',
  str_replace_based_edit_tool: 'Edit',
};

// ---------------------------------------------------------------------------
// Internal types for trae-agent trajectory JSON
// ---------------------------------------------------------------------------

interface TraeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface TraeToolCall {
  call_id?: string;
  name?: string;
  arguments?: unknown;
  id?: unknown;
}

interface TraeResponse {
  content?: string | null;
  usage?: TraeUsage;
  tool_calls?: TraeToolCall[] | null;
}

interface TraeInteraction {
  timestamp?: string;
  response?: TraeResponse;
}

interface TraeToolResult {
  call_id?: string;
  result?: unknown;
  error?: string;
  success?: boolean;
}

interface TraeAgentStep {
  timestamp?: string;
  tool_results?: TraeToolResult[] | null;
  error?: string | null;
}

interface TraeTrajectory {
  llm_interactions?: TraeInteraction[];
  agent_steps?: TraeAgentStep[];
  model?: string;
  session_id?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse tool call arguments into a dict (mirrors Harbor's _parse_tool_args).
// dict → pass through; JSON string → parse; plain string → {input: str};
// anything else → {}
// ---------------------------------------------------------------------------
function parseToolArgs(raw: unknown): Record<string, unknown> {
  const dict = asRecord(raw);
  if (dict !== null) return dict;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      const p = asRecord(parsed);
      if (p !== null) return p;
    } catch {
      // not valid JSON — fall through
    }
    return { input: raw };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Build per-step metrics from trae usage.
//
// Token bucket design (DISJOINT — our convention):
//   - prompt_tokens  = input_tokens as-is.
//     Trae's log (Anthropic SDK) reports input_tokens EXCLUSIVE of cache
//     (verified: cache_read_input_tokens is a separate field, not folded into
//     input_tokens). No subtraction is needed — the bucket is already uncached.
//   - cached_tokens  = cache_read_input_tokens (omit when 0).
//   - completion_tokens = output_tokens.
//     The log carries cache_creation_input_tokens but trae does not fold it
//     into input_tokens, so no extra.cache_write adjustment is required here
//     (we only set cache_write > 0 when the log carries it non-zero; trae's
//     fixture always shows 0 so we skip the field to stay parsimonious).
//
// Source choice: trae logs carry per-interaction usage → per-step metrics ONLY.
// We must NOT also emit final_metrics token totals (single-source rule: doing
// both would cause obol to double-count via the copilot-at-1k pattern).
// ---------------------------------------------------------------------------
function buildStepMetrics(usage: TraeUsage): AtifMetrics {
  const metrics: AtifMetrics = {};
  const inputTokens =
    typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens =
    typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === 'number'
      ? usage.cache_read_input_tokens
      : 0;

  metrics.prompt_tokens = inputTokens;
  metrics.completion_tokens = outputTokens;
  if (cacheRead > 0) {
    metrics.cached_tokens = cacheRead;
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// normalizeTrae
//
// Convert a trae-agent trajectory JSON string to an ATIF v1.7 trajectory.
//
// Log structure:
//   {
//     model: string,
//     session_id?: string,
//     llm_interactions: [
//       {
//         timestamp?: string,
//         response: {
//           content?: string,
//           usage: { input_tokens, output_tokens, cache_read_input_tokens, ... },
//           tool_calls?: [{ call_id, name, arguments }]
//         }
//       }
//     ],
//     agent_steps: [
//       {
//         tool_results?: [{ call_id, result, error, success }],
//         error?: string
//       }
//     ]
//   }
//
// Cross-array call_id join: tool CALLS live in llm_interactions[].response.tool_calls[],
// tool RESULTS live in agent_steps[].tool_results[]. The join key is `call_id`.
// We pre-build a Map<call_id, string> from all agent_steps before iterating
// interactions, then look up each tool call's result by its call_id.
//
// Token source: per-interaction → per-step metrics ONLY. No final_metrics
// token totals (single-source invariant; would double-count in obol).
// ---------------------------------------------------------------------------
export function normalizeTrae(raw: string, version: string): AtifTrajectory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('normalizeTrae: input is not valid JSON');
  }

  const data = asRecord(parsed);
  if (!data) {
    throw new Error('normalizeTrae: top-level value must be an object');
  }

  const traj = data as unknown as TraeTrajectory;
  const interactions: TraeInteraction[] = Array.isArray(traj.llm_interactions)
    ? (traj.llm_interactions as TraeInteraction[])
    : [];
  const agentSteps: TraeAgentStep[] = Array.isArray(traj.agent_steps)
    ? (traj.agent_steps as TraeAgentStep[])
    : [];

  // Require at least one interaction or at least one error agent_step.
  const hasInteractions = interactions.length > 0;
  const hasErrorSteps = agentSteps.some(
    (s) => typeof s.error === 'string' && s.error,
  );
  if (!hasInteractions && !hasErrorSteps) {
    throw new Error(
      'normalizeTrae: no llm_interactions and no error agent_steps — cannot produce a trajectory',
    );
  }

  // ── Step 1: Pre-build the cross-array call_id → result lookup ─────────────
  //
  // Iterate all agent_steps and collect every tool_results entry keyed by
  // call_id. When both error and result are present, error takes priority
  // (mirrors Harbor's Python: `error if error else str(result)`).
  const toolResultsByCallId = new Map<string, string>();
  for (const agentStep of agentSteps) {
    const results = agentStep.tool_results;
    if (!Array.isArray(results)) continue;
    for (const tr of results) {
      const callId = typeof tr.call_id === 'string' ? tr.call_id : '';
      if (!callId) continue;
      const errorStr = typeof tr.error === 'string' ? tr.error : '';
      const resultStr = errorStr ? errorStr : String(tr.result ?? '');
      toolResultsByCallId.set(callId, resultStr);
    }
  }

  // ── Step 2: Convert llm_interactions → ATIF steps ─────────────────────────
  const steps: AtifStep[] = [];
  let stepId = 1;

  const modelName =
    typeof traj.model === 'string' && traj.model ? traj.model : undefined;

  for (const interaction of interactions) {
    const response = interaction.response ?? {};
    const usage: TraeUsage = asRecord(response.usage) ?? {};
    const rawContent = response.content;
    const content: string = typeof rawContent === 'string' ? rawContent : '';
    const rawToolCalls = response.tool_calls;
    const toolCallsData: TraeToolCall[] = Array.isArray(rawToolCalls)
      ? rawToolCalls
      : [];
    const timestamp =
      typeof interaction.timestamp === 'string'
        ? interaction.timestamp
        : undefined;

    // Build ATIF tool calls and observations, joining results by call_id.
    const atifToolCalls: AtifToolCall[] = [];
    const observationResults: AtifObservationResult[] = [];

    for (const tc of toolCallsData) {
      const callId = typeof tc.call_id === 'string' ? tc.call_id : '';
      const nativeName = typeof tc.name === 'string' ? tc.name : 'unknown';
      const canonicalName = TRAE_TOOL_MAP[nativeName] ?? nativeName;
      const args = parseToolArgs(tc.arguments);

      const atifTc: AtifToolCall = canonicalizeAgentPrompt({
        tool_call_id: callId,
        function_name: canonicalName,
        arguments: args,
      });
      atifToolCalls.push(atifTc);

      // Look up the matching tool result via call_id (cross-array join).
      if (callId && toolResultsByCallId.has(callId)) {
        const resultContent = toolResultsByCallId.get(callId);
        const obsResult: AtifObservationResult = {
          source_call_id: callId,
        };
        if (resultContent !== undefined) {
          obsResult.content = resultContent;
        }
        observationResults.push(obsResult);
      }
    }

    // Build the step message (mirrors Harbor's message logic exactly):
    //   - non-empty content → use it
    //   - tool calls present → "[tool call: name1, name2]" (using canonical names)
    //   - else → "[empty response]"
    let message: string;
    if (content) {
      message = content;
    } else if (atifToolCalls.length > 0) {
      const names = atifToolCalls.map((tc) => tc.function_name).join(', ');
      message = `[tool call: ${names}]`;
    } else {
      message = '[empty response]';
    }

    // Build per-step metrics (per-interaction → per-step ONLY; no final_metrics
    // totals — single-source rule prevents double-counting in obol).
    const metrics = buildStepMetrics(usage);

    const step: AtifStep = {
      step_id: stepId++,
      source: 'agent',
      message,
      metrics,
    };

    if (timestamp) step.timestamp = timestamp;
    if (modelName) step.model_name = modelName;
    if (atifToolCalls.length > 0) step.tool_calls = atifToolCalls;
    if (observationResults.length > 0) {
      step.observation = { results: observationResults };
    }

    steps.push(step);
  }

  // ── Step 3: Capture error agent_steps that have no matching interaction ────
  //
  // This handles the case where llm_interactions is empty but an agent_step
  // carries an error (e.g. LLM response parse failures). Mirrors Harbor's
  // "Capture agent_steps that errored without a corresponding llm_interaction".
  if (!hasInteractions) {
    for (const agentStep of agentSteps) {
      const errorMsg =
        typeof agentStep.error === 'string' && agentStep.error
          ? agentStep.error
          : null;
      if (!errorMsg) continue;
      const timestamp =
        typeof agentStep.timestamp === 'string'
          ? agentStep.timestamp
          : undefined;
      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        message: `[error] ${errorMsg}`,
      };
      if (timestamp) step.timestamp = timestamp;
      if (modelName) step.model_name = modelName;
      steps.push(step);
    }
  }

  if (steps.length === 0) {
    throw new Error('normalizeTrae: produced no steps');
  }

  // Reassign sequential step_ids (1-based, contiguous).
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step) step.step_id = i + 1;
  }

  // ── Build trajectory ───────────────────────────────────────────────────────
  const trajectory: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: {
      name: 'trae-agent',
      version,
    },
    steps,
  };

  if (modelName) trajectory.agent.model_name = modelName;

  const sessionId =
    typeof traj.session_id === 'string' && traj.session_id
      ? traj.session_id
      : undefined;
  if (sessionId) trajectory.session_id = sessionId;

  // ── Validate ───────────────────────────────────────────────────────────────
  const result = validateTrajectory(trajectory);
  if (!result.ok) {
    throw new Error(
      `normalizeTrae produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return trajectory;
}
