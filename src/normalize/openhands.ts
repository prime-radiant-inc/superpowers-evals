// Ported from Harbor's src/harbor/agents/installed/openhands.py
//   repo:   https://github.com/laude-institute/harbor (Apache-2.0)
//   commit: 5352049de712613e58459cad41afcf0bf8645738 (v0.14.0)
// Log-parsing logic is derived from Harbor; token buckets, tool-name
// canonicalization, and message-id dedup follow OUR conventions
// (docs/superpowers/reference/atif-normalizers.md), NOT Harbor's.

import {
  ATIF_SCHEMA_VERSION,
  type AtifObservation,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// ---------------------------------------------------------------------------
// Tool-name canonicalization
// ---------------------------------------------------------------------------

// OpenHands uses CodeActAgent actions as tool names. Map the most common ones
// to our canonical set. Unknown names pass through unchanged.
const OPENHANDS_TOOL_MAP: Record<string, string> = {
  // Shell execution
  execute_bash: 'Bash',
  run: 'Bash',
  run_ipython: 'Bash',
  // File I/O
  read_file: 'Read',
  view_file: 'Read',
  open_file: 'Read',
  write_file: 'Write',
  create_file: 'Write',
  // Editing
  str_replace_editor: 'Edit',
  str_replace_in_file: 'Edit',
  edit_file_by_replace: 'Edit',
  // Search
  search_file: 'Grep',
  grep: 'Grep',
  find_file: 'Grep',
  web_search: 'WebSearch',
  // Web fetch / browser
  web_read: 'WebFetch',
  browser_action: 'WebFetch',
  // Subagent dispatch — no subagent tools reported in OpenHands events mode per manifest
  // (included for forward-safety per house pattern)
  invoke_agent: 'Agent',
  spawn_agent: 'Agent',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** System-message patterns from Harbor's _convert_event_to_step heuristic. */
const SYSTEM_MESSAGE_PATTERNS = [
  'Retrieving content for:',
  'Added workspace context',
  'Loading workspace',
  'Initializing',
];

/**
 * Map an OpenHands event source + action to an ATIF source.
 * Mirrors Harbor's _convert_event_to_step source-mapping logic.
 */
function mapSource(
  event: Record<string, unknown>,
): 'system' | 'user' | 'agent' {
  if (event['action'] === 'system') return 'system';

  const rawSource = event['source'];
  if (rawSource === 'environment') return 'system';
  if (rawSource === 'agent') return 'agent';

  // source == 'user' — check heuristic for system-generated messages
  if (rawSource === 'user') {
    const msg = typeof event['message'] === 'string' ? event['message'] : '';
    if (SYSTEM_MESSAGE_PATTERNS.some((p) => msg.startsWith(p))) return 'system';
    return 'user';
  }

  // Unknown source — treat as system to avoid ATIF agent-only field violations
  return 'system';
}

/**
 * Extract the tool call from tool_call_metadata if present.
 * Returns null when the event has no tool_call_metadata.
 */
function extractToolCall(event: Record<string, unknown>): AtifToolCall | null {
  const meta = event['tool_call_metadata'];
  if (!isObject(meta)) return null;

  const toolCallId =
    typeof meta['tool_call_id'] === 'string' ? meta['tool_call_id'] : '';
  const rawName =
    typeof meta['function_name'] === 'string' ? meta['function_name'] : '';

  // Parse arguments from model_response.choices[0].message.tool_calls[0].function.arguments
  let args: Record<string, unknown> = {};
  const modelResp = meta['model_response'];
  if (isObject(modelResp)) {
    const choices = modelResp['choices'];
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0];
      if (isObject(choice)) {
        const msg = choice['message'];
        if (isObject(msg)) {
          const tcList = msg['tool_calls'];
          if (Array.isArray(tcList) && tcList.length > 0) {
            const tc = tcList[0];
            if (isObject(tc)) {
              const fn = tc['function'];
              if (isObject(fn)) {
                const rawArgs = fn['arguments'];
                if (typeof rawArgs === 'string') {
                  try {
                    const parsed = JSON.parse(rawArgs);
                    if (isObject(parsed)) args = parsed;
                  } catch {
                    // ignore parse errors — empty args
                  }
                } else if (isObject(rawArgs)) {
                  args = rawArgs;
                }
              }
            }
          }
        }
      }
    }
  }

  const canonicalName = OPENHANDS_TOOL_MAP[rawName] ?? rawName;
  return canonicalizeAgentPrompt({
    tool_call_id: toolCallId,
    function_name: canonicalName,
    arguments: args,
  });
}

/**
 * Build an ATIF observation from an event that carries observation data.
 * An event has observation data when:
 *   - it has an `observation` key, AND
 *   - `cause` is not null/undefined, AND
 *   - source is 'agent'.
 * The source_call_id links to the tool_call_id from tool_call_metadata.
 */
function extractObservation(
  event: Record<string, unknown>,
  toolCallId: string | null,
): AtifObservation | null {
  if (event['observation'] === undefined) return null;
  if (event['cause'] === null || event['cause'] === undefined) return null;
  if (event['source'] !== 'agent') return null;

  const content = typeof event['content'] === 'string' ? event['content'] : '';
  const result: { source_call_id?: string; content?: string } = {};
  if (toolCallId) result.source_call_id = toolCallId;
  if (content) result.content = content;

  return { results: [result] };
}

interface AccumulatedUsage {
  prompt: number;
  completion: number;
  cacheRead: number;
  cost: number;
}

/**
 * Extract accumulated token usage from an event's llm_metrics.
 * Returns null when llm_metrics is absent or has no usage data.
 */
function extractAccumulatedUsage(
  event: Record<string, unknown>,
): AccumulatedUsage | null {
  const llmMetrics = event['llm_metrics'];
  if (!isObject(llmMetrics)) return null;

  const accUsage = llmMetrics['accumulated_token_usage'];
  if (!isObject(accUsage)) return null;

  const prompt =
    typeof accUsage['prompt_tokens'] === 'number'
      ? accUsage['prompt_tokens']
      : 0;
  const completion =
    typeof accUsage['completion_tokens'] === 'number'
      ? accUsage['completion_tokens']
      : 0;
  const cacheRead =
    typeof accUsage['cache_read_tokens'] === 'number'
      ? accUsage['cache_read_tokens']
      : 0;
  const cost =
    typeof llmMetrics['accumulated_cost'] === 'number'
      ? llmMetrics['accumulated_cost']
      : 0;

  return { prompt, completion, cacheRead, cost };
}

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

/**
 * Convert an OpenHands events-mode session log to an ATIF v1.7 trajectory.
 *
 * Input format: a JSON array of event objects, as produced by sorting
 * `sessions/{id}/events/*.json` by integer stem and concatenating them.
 * (Our capture layer reads the events directory and serializes them as a JSON
 * array before invoking this function.)
 *
 * Key behaviors:
 * - Source mapping: action=='system'→system; source=='environment'→system;
 *   source=='agent'→agent; source=='user'→user (with heuristic system patterns).
 * - Tool calls: from tool_call_metadata.function_name + parsed arguments.
 * - Step merging: two events with the same tool_call_id where the second has
 *   observation data are merged into a single step (Harbor convention).
 * - Token accounting: accumulated_token_usage is a RUNNING TOTAL across events.
 *   We compute per-step DELTAS to satisfy the ATIF disjoint single-source rule.
 *   Per-step metrics only — NO final_metrics (single-source invariant).
 * - prompt_tokens is already EXCLUSIVE of cache_read (OpenHands emits them as
 *   separate fields, not inclusive like Gemini/Qwen). No subtraction needed.
 * - cost_usd: the log carries accumulated_cost; we emit per-step cost deltas
 *   since the log itself records them.
 */
export function normalizeOpenhands(
  raw: string,
  version: string,
): AtifTrajectory {
  // Parse events array
  let events: Record<string, unknown>[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      events = [];
    } else {
      events = parsed.filter(isObject);
    }
  } catch {
    events = [];
  }

  // Extract version, session_id, and extra metadata from events
  let agentVersion = version;
  let agentExtra: Record<string, unknown> | undefined;
  let sessionId: string | undefined;

  for (const event of events) {
    // Check for session_id metadata (non-Harbor extension for our raw-array format)
    if (typeof event['_session_id'] === 'string' && !sessionId) {
      sessionId = event['_session_id'];
    }

    const args = event['args'];
    if (isObject(args)) {
      if (
        typeof args['openhands_version'] === 'string' &&
        args['openhands_version']
      ) {
        agentVersion = args['openhands_version'];
      }
      const extraData: Record<string, unknown> = {};
      if (typeof args['agent_class'] === 'string') {
        extraData['agent_class'] = args['agent_class'];
      }
      if (Object.keys(extraData).length > 0) {
        agentExtra = extraData;
      }
    }

    // Stop scanning once we have the version (Harbor breaks early too)
    if (agentVersion !== version) break;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Build steps from events — single pass that also computes token deltas.
  //
  // Harbor's _convert_events_to_trajectory:
  //   1. Skip events with no meaningful content (no message, tool_calls, or obs)
  //   2. Merge events: two events with the same tool_call_id where the second
  //      brings an observation but the previous step has none → merge into previous.
  //
  // Token accounting runs in the SAME pass:
  //   accumulated_token_usage is a running total; we take deltas per step.
  //   When an event merges into the previous step, the LAST accumulated usage
  //   seen for that step's events is the authoritative one (Harbor's comment:
  //   "OpenHands stores accumulated metrics in each event"). We track the
  //   'pending' accumulated usage for the step currently being built and convert
  //   it to a delta only when we commit (either on merge-finish or on a new step).
  //
  // SINGLE-SOURCE: we emit ONLY per-step metrics, NO final_metrics — this
  // prevents the double-count bug (obol skips final_metrics when any step
  // carries metrics). Harbor emits both; we deviate deliberately.
  //
  // prompt_tokens is EXCLUSIVE of cache_read in OpenHands (separate fields,
  // unlike Gemini's inclusive promptTokenCount). No subtraction needed.
  // ─────────────────────────────────────────────────────────────────────────
  const steps: AtifStep[] = [];
  let stepId = 1;

  // Running accumulated-usage baseline — updated each time we commit a step's usage
  let prevPrompt = 0;
  let prevCompletion = 0;
  let prevCacheRead = 0;
  let prevCost = 0;

  // Pending accumulated usage for the step currently being built (or last merged-into)
  // Maps step index → latest accumulated usage seen for events in that step
  const pendingUsage = new Map<number, AccumulatedUsage>();

  // Whether the step at index i has had its observation merged in yet
  // (used to decide whether a new event can merge into it)
  const stepHasObs = new Set<number>();

  for (const event of events) {
    const source = mapSource(event);
    const message =
      typeof event['message'] === 'string' ? event['message'] : undefined;
    const timestamp =
      typeof event['timestamp'] === 'string' ? event['timestamp'] : undefined;

    // Only agent steps have tool_call_metadata
    const toolCall = source === 'agent' ? extractToolCall(event) : null;
    const toolCallId = toolCall?.tool_call_id ?? null;

    // Only agent steps with cause != null have observation
    const observation =
      source === 'agent' ? extractObservation(event, toolCallId) : null;

    // Filter: skip events with no meaningful content
    const hasContent = !!(message || toolCall || observation);
    if (!hasContent) continue;

    // Extract accumulated usage for this event (may be null)
    const usage = extractAccumulatedUsage(event);

    // Step-merge logic (Harbor convention):
    // If this event brings an observation for the same tool_call_id as the
    // previous step's tool_call (and the previous step has no observation yet),
    // merge into the previous step instead of emitting a new one.
    let didMerge = false;
    const prevIdx = steps.length - 1;
    if (
      steps.length > 0 &&
      source === 'agent' &&
      observation !== null &&
      toolCall !== null &&
      !stepHasObs.has(prevIdx)
    ) {
      const prev = steps[prevIdx];
      if (prev && prev.source === 'agent' && prev.tool_calls !== undefined) {
        const prevCallId = prev.tool_calls[0]?.tool_call_id;
        const currCallId = toolCall.tool_call_id;
        if (prevCallId && currCallId && prevCallId === currCallId) {
          // Merge: attach observation to previous step
          prev.observation = observation;
          stepHasObs.add(prevIdx);
          // Carry message if previous step lacks one
          if (message && !prev.message) prev.message = message;
          // Update pending usage for the step being merged into (take latest)
          if (usage) pendingUsage.set(prevIdx, usage);
          didMerge = true;
        }
      }
    }

    if (!didMerge) {
      // Commit any pending usage for the PREVIOUS step as a delta now that we
      // know it's finished (a new event is starting a new step).
      // We commit the previous step's usage here because the step is complete.
      commitPendingUsage(steps, pendingUsage, prevIdx, {
        prevPrompt,
        prevCompletion,
        prevCacheRead,
        prevCost,
      });
      // After committing the previous step, update our running baseline
      const prevStep = steps[prevIdx];
      if (prevStep?.metrics) {
        prevPrompt += prevStep.metrics.prompt_tokens ?? 0;
        prevCompletion += prevStep.metrics.completion_tokens ?? 0;
        prevCacheRead += prevStep.metrics.cached_tokens ?? 0;
        prevCost += prevStep.metrics.cost_usd ?? 0;
      }
      pendingUsage.delete(prevIdx);

      const currIdx = steps.length;
      const step: AtifStep = { step_id: stepId++, source };
      if (timestamp) step.timestamp = timestamp;
      if (message) step.message = message;
      if (toolCall) step.tool_calls = [toolCall];
      if (observation) {
        step.observation = observation;
        stepHasObs.add(currIdx);
      }
      steps.push(step);
      if (usage) pendingUsage.set(currIdx, usage);
    }
  }

  // Commit pending usage for the last step
  const lastIdx = steps.length - 1;
  if (lastIdx >= 0) {
    commitPendingUsage(steps, pendingUsage, lastIdx, {
      prevPrompt,
      prevCompletion,
      prevCacheRead,
      prevCost,
    });
  }

  // ATIF requires at least one step.
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // Renumber step_ids sequentially from 1 (merge pass may have reduced count).
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step) step.step_id = i + 1;
  }

  // Build trajectory — SINGLE-SOURCE: no final_metrics (per-step only).
  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'openhands', version: agentVersion },
    steps,
  };
  if (sessionId) traj.session_id = sessionId;
  if (agentExtra) traj.agent.extra = agentExtra;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeOpenhands produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}

/**
 * Commit the pending accumulated usage for a step as a per-step delta.
 *
 * Computes delta = current accumulated - previous accumulated baseline.
 * Assigns step.metrics when the delta has any positive tokens.
 * This is called when a step is "finished" (a new step starts or it's the last one).
 */
function commitPendingUsage(
  steps: AtifStep[],
  pendingUsage: Map<number, AccumulatedUsage>,
  stepIdx: number,
  baseline: {
    prevPrompt: number;
    prevCompletion: number;
    prevCacheRead: number;
    prevCost: number;
  },
): void {
  const usage = pendingUsage.get(stepIdx);
  if (!usage) return;

  const step = steps[stepIdx];
  if (!step) return;

  const deltaPrompt = usage.prompt - baseline.prevPrompt;
  const deltaCompletion = usage.completion - baseline.prevCompletion;
  const deltaCacheRead = usage.cacheRead - baseline.prevCacheRead;
  const deltaCost = usage.cost - baseline.prevCost;

  const hasUsage = deltaPrompt > 0 || deltaCompletion > 0 || deltaCacheRead > 0;
  if (!hasUsage) return;

  step.metrics = {};
  if (deltaPrompt > 0) step.metrics.prompt_tokens = deltaPrompt;
  if (deltaCompletion > 0) step.metrics.completion_tokens = deltaCompletion;
  if (deltaCacheRead > 0) step.metrics.cached_tokens = deltaCacheRead;
  // Emit cost delta when the log carries it (log records accumulated_cost)
  if (deltaCost > 0) step.metrics.cost_usd = deltaCost;
}
