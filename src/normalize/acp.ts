// Ported from Harbor's src/harbor/agents/installed/acp.py
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

// ---------------------------------------------------------------------------
// Tool name canonicalization
// ---------------------------------------------------------------------------

// Map ACP native tool names (from `kind` or `title`) to our canonical set.
// ACP's `kind` field is the primary source; `title` is the fallback.
// "other" is the generic ACP kind for tool calls that don't fit a category —
// in that case we use `title` verbatim, which may itself map to a canonical name.
const ACP_TOOL_MAP: Record<string, string> = {
  bash: 'Bash',
  shell: 'Bash',
  exec: 'Bash',
  execute: 'Bash',
  read: 'Read',
  read_file: 'Read',
  write: 'Write',
  write_file: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  patch: 'Edit',
  grep: 'Grep',
  search: 'Grep',
  glob: 'Glob',
  list: 'Glob',
  web_fetch: 'WebFetch',
  fetch: 'WebFetch',
  web_search: 'WebSearch',
  todo_write: 'TodoWrite',
  update_todo: 'TodoWrite',
  agent: 'Agent',
  spawn_agent: 'Agent',
  subagent: 'Agent',
};

/**
 * Resolve the canonical tool name from an ACP update event.
 * Ported from Harbor's `_resolve_tool_name` (acp.py:286-296):
 *   - Use `kind` when it's a non-empty string that is not "other".
 *   - Fall back to the first line of `title` (stripped), when present.
 *   - Otherwise return "tool".
 * Then apply ACP_TOOL_MAP to canonicalize.
 */
function resolveToolName(update: Record<string, unknown>): string {
  const kind = update['kind'];
  if (typeof kind === 'string' && kind && kind !== 'other') {
    return ACP_TOOL_MAP[kind] ?? kind;
  }

  const title = update['title'];
  if (typeof title === 'string' && title.trim()) {
    const firstLine = title.trim().split('\n')[0];
    const raw = firstLine !== undefined ? firstLine.trim() : title.trim();
    return ACP_TOOL_MAP[raw] ?? raw;
  }

  return 'tool';
}

// ---------------------------------------------------------------------------
// Content extraction helpers (ported from Harbor's acp.py)
// ---------------------------------------------------------------------------

/**
 * Extract text from a nested ACP content structure.
 * Ported from Harbor's `_extract_text_from_content` (acp.py:244-258):
 *   - string → pass through.
 *   - list → join each item recursively.
 *   - dict → read `text` key; fall back to `content` key recursively.
 */
function extractTextFromContent(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractTextFromContent).join('');
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    const text = obj['text'];
    if (typeof text === 'string') return text;
    const nested = obj['content'];
    if (nested !== undefined) return extractTextFromContent(nested);
  }
  return '';
}

/**
 * Stringify a tool output into a human-readable observation string.
 * Ported from Harbor's `_stringify_tool_output` (acp.py:261-275):
 *   - dict with `output`, `formatted_output`, or `aggregated_output` key → use that string value.
 *   - dict with stdout/stderr/exit_code/status keys → JSON-encode the whole dict.
 *   - non-null non-dict rawOutput → str(rawOutput).
 *   - fall back to extracting text from content.
 */
function stringifyToolOutput(
  rawOutput: unknown,
  content: unknown,
): string | undefined {
  if (
    rawOutput !== null &&
    rawOutput !== undefined &&
    typeof rawOutput === 'object' &&
    !Array.isArray(rawOutput)
  ) {
    const obj = rawOutput as Record<string, unknown>;
    for (const key of ['output', 'formatted_output', 'aggregated_output']) {
      const value = obj[key];
      if (typeof value === 'string' && value) return value;
    }
    if (
      'stdout' in obj ||
      'stderr' in obj ||
      'exit_code' in obj ||
      'status' in obj
    ) {
      return JSON.stringify(Object.fromEntries(Object.entries(obj).sort()));
    }
  } else if (rawOutput !== null && rawOutput !== undefined) {
    return String(rawOutput);
  }

  const text = extractTextFromContent(content);
  return text || undefined;
}

/**
 * Normalize raw tool input into a plain dict.
 * Ported from Harbor's `_normalize_tool_arguments` (acp.py:278-283):
 *   - dict → return as-is.
 *   - null/undefined → return {}.
 *   - anything else → wrap as { value: rawInput }.
 */
function normalizeToolArguments(rawInput: unknown): Record<string, unknown> {
  if (rawInput === null || rawInput === undefined) return {};
  if (typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    return rawInput as Record<string, unknown>;
  }
  return { value: rawInput };
}

// ---------------------------------------------------------------------------
// State structs (plain TS equivalents of Harbor's @dataclass types)
// ---------------------------------------------------------------------------

interface AcpToolCallState {
  toolCallId: string;
  functionName: string;
  arguments: Record<string, unknown>;
  observationChunks: string[];
}

interface AcpStepState {
  messageChunks: string[];
  reasoningChunks: string[];
  toolStates: Map<string, AcpToolCallState>;
  toolOrder: string[];
  permissionRequests: Record<string, unknown>[];
  usageUpdates: Record<string, unknown>[];
  rawEventCounts: Record<string, number>;
  hasCompletedToolCycle: boolean;
}

function newStepState(): AcpStepState {
  return {
    messageChunks: [],
    reasoningChunks: [],
    toolStates: new Map(),
    toolOrder: [],
    permissionRequests: [],
    usageUpdates: [],
    rawEventCounts: {},
    hasCompletedToolCycle: false,
  };
}

function stepHasContent(s: AcpStepState): boolean {
  return (
    s.messageChunks.length > 0 ||
    s.reasoningChunks.length > 0 ||
    s.toolOrder.length > 0 ||
    s.permissionRequests.length > 0
  );
}

function countEvent(s: AcpStepState, name: string): void {
  s.rawEventCounts[name] = (s.rawEventCounts[name] ?? 0) + 1;
}

function getOrCreateToolState(
  s: AcpStepState,
  toolCallId: string,
  functionName: string,
): AcpToolCallState {
  const existing = s.toolStates.get(toolCallId);
  if (existing !== undefined) return existing;
  const ts: AcpToolCallState = {
    toolCallId,
    functionName,
    arguments: {},
    observationChunks: [],
  };
  s.toolStates.set(toolCallId, ts);
  s.toolOrder.push(toolCallId);
  return ts;
}

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

/**
 * Convert an ACP events.jsonl log into an ATIF v1.7 trajectory.
 *
 * ACP writes two files per session: acp-events.jsonl (the event stream) and
 * acp-summary.json. Our normalizer accepts ONLY the events.jsonl content as
 * `raw`. Token usage from acp-summary.json (prompt_response.usage.inputTokens /
 * outputTokens) is NOT available in this interface — if usage_update events in
 * the stream carry inputTokens/outputTokens, those are used; otherwise no
 * metrics are emitted. This is a capture-layer follow-up: the summary should be
 * fed alongside the events for full token fidelity.
 *
 * Token bucket mapping (DISJOINT — no overlap):
 *   usage_update.inputTokens  → metrics.prompt_tokens  (uncached; ACP has no cache split)
 *   usage_update.outputTokens → metrics.completion_tokens
 *   No cache or cost data in the events stream.
 *
 * SINGLE-SOURCE: if any usage_update event carries token counts, we emit
 * per-step metrics ONLY and no final_metrics token totals.
 *
 * Step segmentation: each ACP step is bounded by usage_update events
 * (or tool-cycle completion + a new tool cycle beginning). Mirrors Harbor's
 * `_AcpStepState`/`_AcpToolCallState` state machine (acp.py:739-865).
 */
export function normalizeAcp(raw: string, version: string): AtifTrajectory {
  const stepStates: AcpStepState[] = [];
  // Wrapped in an object so TypeScript does not narrow the property through
  // closure calls — `let currentStep` would be reset to `never` by tsc's
  // control-flow analysis after any call to ensureStep/flushCurrentStep.
  const state = { currentStep: null as AcpStepState | null };
  const pendingPermissionRequests = new Map<string, Record<string, unknown>>();
  const orphanUsageUpdates: Record<string, unknown>[] = [];

  function ensureStep(): AcpStepState {
    if (state.currentStep === null) {
      state.currentStep = newStepState();
    }
    return state.currentStep;
  }

  function flushCurrentStep(): void {
    if (state.currentStep === null) return;
    if (stepHasContent(state.currentStep)) {
      stepStates.push(state.currentStep);
    }
    state.currentStep = null;
  }

  for (const line of raw.split('\n')) {
    const stripped = line.trim();
    if (!stripped) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;

    const eventType = event['event_type'];

    // ── request_permission: stash for later attachment to a tool step ────────
    if (eventType === 'request_permission') {
      const payload = event['payload'];
      if (typeof payload !== 'object' || payload === null) continue;
      const p = payload as Record<string, unknown>;
      const toolCall = p['tool_call'];
      if (typeof toolCall !== 'object' || toolCall === null) continue;
      const tc = toolCall as Record<string, unknown>;
      const toolCallId = tc['toolCallId'];
      if (typeof toolCallId !== 'string' || !toolCallId) continue;
      pendingPermissionRequests.set(toolCallId, p);
      continue;
    }

    if (eventType !== 'session_update') continue;

    const payload = event['payload'];
    if (typeof payload !== 'object' || payload === null) continue;
    const p = payload as Record<string, unknown>;
    const update = p['update'];
    if (typeof update !== 'object' || update === null) continue;
    const u = update as Record<string, unknown>;

    const sessionUpdate = u['sessionUpdate'];
    if (typeof sessionUpdate !== 'string') continue;

    // ── agent_thought_chunk → reasoning ──────────────────────────────────────
    if (sessionUpdate === 'agent_thought_chunk') {
      if (state.currentStep?.hasCompletedToolCycle) {
        flushCurrentStep();
      }
      const step = ensureStep();
      countEvent(step, sessionUpdate);
      const text = extractTextFromContent(u['content']);
      if (text) step.reasoningChunks.push(text);
      continue;
    }

    // ── agent_message_chunk → message ─────────────────────────────────────────
    if (sessionUpdate === 'agent_message_chunk') {
      if (state.currentStep?.hasCompletedToolCycle) {
        flushCurrentStep();
      }
      const step = ensureStep();
      countEvent(step, sessionUpdate);
      const text = extractTextFromContent(u['content']);
      if (text) step.messageChunks.push(text);
      continue;
    }

    // ── usage_update → flush current step ────────────────────────────────────
    if (sessionUpdate === 'usage_update') {
      if (state.currentStep === null || !stepHasContent(state.currentStep)) {
        orphanUsageUpdates.push(u);
        continue;
      }
      countEvent(state.currentStep, sessionUpdate);
      state.currentStep.usageUpdates.push(u);
      flushCurrentStep();
      continue;
    }

    // ── tool_call / tool_call_update ─────────────────────────────────────────
    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') {
      continue;
    }

    const toolCallId = u['toolCallId'];
    if (typeof toolCallId !== 'string' || !toolCallId) continue;

    // Start a new step if we're mid-cycle and this is a new tool
    if (
      state.currentStep?.hasCompletedToolCycle &&
      !state.currentStep.toolStates.has(toolCallId)
    ) {
      flushCurrentStep();
    }

    const step = ensureStep();
    countEvent(step, sessionUpdate);
    const toolState = getOrCreateToolState(
      step,
      toolCallId,
      resolveToolName(u),
    );

    // Attach any pending permission request for this tool call
    const pendingPerm = pendingPermissionRequests.get(toolCallId);
    if (pendingPerm !== undefined) {
      pendingPermissionRequests.delete(toolCallId);
      step.permissionRequests.push(pendingPerm);
      countEvent(step, 'request_permission');
    }

    // Accumulate arguments from rawInput (last write wins per Harbor)
    const rawInput = u['rawInput'];
    if (rawInput !== undefined) {
      toolState.arguments = normalizeToolArguments(rawInput);
    }

    // Accumulate observation from rawOutput / content
    const rawOutput = u['rawOutput'];
    const obsText = stringifyToolOutput(rawOutput, u['content']);
    if (obsText) {
      toolState.observationChunks.push(obsText);
    }

    if (u['status'] === 'completed') {
      step.hasCompletedToolCycle = true;
    }
  }

  flushCurrentStep();

  // ---------------------------------------------------------------------------
  // Build ATIF steps from collected step states
  // ---------------------------------------------------------------------------

  const steps: AtifStep[] = [];

  // Detect whether ANY usage_update in the collected states carries per-step
  // token counts. If so, we use per-step metrics (SINGLE-SOURCE invariant).
  let anyPerStepTokens = false;
  for (const ss of stepStates) {
    for (const uUpd of ss.usageUpdates) {
      if (
        typeof uUpd['inputTokens'] === 'number' ||
        typeof uUpd['outputTokens'] === 'number'
      ) {
        anyPerStepTokens = true;
        break;
      }
    }
    if (anyPerStepTokens) break;
  }
  // Also check orphan usage updates
  if (!anyPerStepTokens) {
    for (const uUpd of orphanUsageUpdates) {
      if (
        typeof uUpd['inputTokens'] === 'number' ||
        typeof uUpd['outputTokens'] === 'number'
      ) {
        anyPerStepTokens = true;
        break;
      }
    }
  }

  for (const ss of stepStates) {
    // Build tool_calls array preserving insertion order
    const toolCalls: AtifToolCall[] = [];
    for (const tcId of ss.toolOrder) {
      const ts = ss.toolStates.get(tcId);
      if (ts === undefined) continue;
      toolCalls.push({
        tool_call_id: ts.toolCallId,
        function_name: ts.functionName,
        arguments: ts.arguments,
      });
    }

    // Build observation results (one per tool that produced output)
    const obsResults: AtifObservationResult[] = [];
    for (const tcId of ss.toolOrder) {
      const ts = ss.toolStates.get(tcId);
      if (ts === undefined || ts.observationChunks.length === 0) continue;
      const result: AtifObservationResult = {
        source_call_id: ts.toolCallId,
        content: ts.observationChunks.join('\n\n'),
      };
      obsResults.push(result);
    }

    // Per-step metrics: use tokens from usage_update events when available
    // (SINGLE-SOURCE: only emit metrics here, never in final_metrics totals)
    let metrics: AtifMetrics | undefined;
    if (anyPerStepTokens) {
      // Sum all usage_updates for this step (typically one per step)
      let inputTokens = 0;
      let outputTokens = 0;
      let hasTokens = false;
      for (const uUpd of ss.usageUpdates) {
        if (typeof uUpd['inputTokens'] === 'number') {
          inputTokens += uUpd['inputTokens'];
          hasTokens = true;
        }
        if (typeof uUpd['outputTokens'] === 'number') {
          outputTokens += uUpd['outputTokens'];
          hasTokens = true;
        }
      }
      if (hasTokens) {
        metrics = {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
        };
      }
    }

    // Build step extra: session_update_counts always; permission_requests and
    // usage_updates when present (mirrors Harbor's extra construction).
    const extra: Record<string, unknown> = {
      session_update_counts: { ...ss.rawEventCounts },
    };
    if (ss.permissionRequests.length > 0) {
      extra['permission_requests'] = ss.permissionRequests;
    }
    if (ss.usageUpdates.length > 0) {
      extra['usage_updates'] = ss.usageUpdates;
    }

    const message = ss.messageChunks.join('');
    const reasoning = ss.reasoningChunks.join('') || undefined;

    const step: AtifStep = {
      step_id: steps.length + 1,
      source: 'agent',
      extra,
    };
    if (message) step.message = message;
    if (reasoning !== undefined) step.reasoning_content = reasoning;
    if (toolCalls.length > 0) step.tool_calls = toolCalls;
    if (obsResults.length > 0) step.observation = { results: obsResults };
    if (metrics !== undefined) step.metrics = metrics;

    steps.push(step);
  }

  // ATIF requires at least one step
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // Re-assign sequential step_ids (1-based, sequential)
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s !== undefined) s.step_id = i + 1;
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'acp', version },
    steps,
  };

  if (orphanUsageUpdates.length > 0) {
    traj.extra = { orphan_usage_updates: orphanUsageUpdates };
  }

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeAcp produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
