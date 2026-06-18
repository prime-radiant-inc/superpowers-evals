// Ported from Harbor's src/harbor/agents/installed/cursor_cli.py
//   repo:   https://github.com/laude-institute/harbor (Apache-2.0)
//   commit: 5352049de712613e58459cad41afcf0bf8645738 (v0.14.0)
// Log-parsing logic is derived from Harbor; token buckets, tool-name
// canonicalization, and message-id dedup follow OUR conventions
// (docs/superpowers/reference/atif-normalizers.md), NOT Harbor's.

import {
  ATIF_SCHEMA_VERSION,
  type AtifStep,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// ---------------------------------------------------------------------------
// Cursor-native tool name → canonical name.
// Source: cursor-agent --output-format=stream-json tool_call events.
// See https://cursor.com/docs/cli/reference/output-format
// ---------------------------------------------------------------------------
const CURSOR_TOOL_MAP: Record<string, string> = {
  // Shell execution
  run_terminal_cmd: 'Bash',
  // File system
  read_file: 'Read',
  edit_file: 'Edit',
  write_file: 'Write',
  delete_file: 'Edit',
  // Directory / glob
  list_dir: 'Glob',
  // Search
  grep_search: 'Grep',
  codebase_search: 'Grep',
  file_search: 'Glob',
  // Web
  web_search: 'WebSearch',
  fetch_rules: 'WebFetch',
  // Subagent dispatch — none known in current Cursor CLI; kept for forward safety
};

// ---------------------------------------------------------------------------
// Accumulated usage from result events (disjoint buckets, session total).
// Cursor reports usage per result event (one per turn).
// We accumulate the LAST result event's usage (session-total, not incremental),
// and attach it to the terminal assistant step as per-step metrics.
//
// Harbor's formula (INCLUSIVE):
//   total_prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens
// OUR formula (DISJOINT):
//   prompt_tokens   = inputTokens           (exclusive of cache — already uncached)
//   cached_tokens   = cacheReadTokens
//   cache_write     = cacheWriteTokens      (step.extra.cache_write, only when > 0)
//   completion      = outputTokens
//   cost_usd        = totalCost or cost, if the log reports it (never fabricated)
// ---------------------------------------------------------------------------
interface CursorUsageAccum {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number | undefined;
}

function emptyAccum(): CursorUsageAccum {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCost: undefined,
  };
}

function accumulateUsage(
  accum: CursorUsageAccum,
  usage: Record<string, unknown>,
): void {
  if (typeof usage['inputTokens'] === 'number')
    accum.inputTokens += usage['inputTokens'];
  if (typeof usage['outputTokens'] === 'number')
    accum.outputTokens += usage['outputTokens'];
  if (typeof usage['cacheReadTokens'] === 'number')
    accum.cacheReadTokens += usage['cacheReadTokens'];
  if (typeof usage['cacheWriteTokens'] === 'number')
    accum.cacheWriteTokens += usage['cacheWriteTokens'];

  // Cost: prefer totalCost, fall back to cost. Accumulate if reported.
  const reportedCost =
    typeof usage['totalCost'] === 'number'
      ? usage['totalCost']
      : typeof usage['cost'] === 'number'
        ? usage['cost']
        : undefined;
  if (reportedCost !== undefined) {
    accum.totalCost = (accum.totalCost ?? 0) + reportedCost;
  }
}

// ---------------------------------------------------------------------------
// Tool call normalization.
// A cursor tool_call completed event carries:
//   { tool_call: { <toolName>: { args: {...}, result: <string|object|null> } } }
// Multiple entries in the tool_call dict each become a separate AtifToolCall
// on the same step. Completed events are the source of truth; started events
// are skipped (they carry no result).
// ---------------------------------------------------------------------------
function normalizeToolResult(result: unknown): string | null | undefined {
  if (result === null) return null;
  if (result === undefined) return undefined;
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// Main normalizer.
// ---------------------------------------------------------------------------

/**
 * Convert a cursor-cli stream-json log (cursor-cli.txt) into an ATIF v1.7
 * trajectory.
 *
 * Cursor logs use the following event types (discriminated by `type`):
 *   system       - init: session_id, model, cwd
 *   user         - user message
 *   assistant    - assistant message; model_call_id links it to tool_calls
 *   thinking     - thinking delta/completed; accumulated as reasoning_content
 *   tool_call    - subtype "started" (skip) or "completed" (parse args+result)
 *   result       - final result; carries usage (session-total per turn)
 *   interaction_query - permission-prompt request/response; silently skipped
 *
 * Token buckets follow OUR DISJOINT convention (not Harbor's inclusive).
 * Usage is attached as PER-STEP metrics on the terminal assistant step from
 * each turn's result event. cache_write lives in step.extra.cache_write
 * (obol ignores metrics.extra; step.extra is priced correctly).
 *
 * SINGLE-SOURCE: cursor reports usage in result events (session total per
 * turn). We attach usage to the last assistant step before each result event
 * as per-step metrics. No final_metrics token totals.
 *
 * model_name: captured from the system init event's `model` field and set
 * on traj.agent.model_name and on every metrics-bearing step as step.model_name.
 */
export function normalizeCursor(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  let sessionId: string | undefined;
  let agentModelName: string | undefined;

  // model_call_id → step index in steps[]; for attaching tool calls and
  // observations to the right assistant step.
  const callIdStepIndex = new Map<string, number>();

  // Accumulated thinking blocks (cleared after each assistant step).
  const pendingThinking: string[] = [];

  // Track the last assistant step index for usage attachment per turn.
  // When a result event fires, we attach its usage to the last agent step.
  let lastAgentStepIdx: number | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const evType = ev['type'];

    // ── system: capture session_id and model ──────────────────────────────
    if (evType === 'system') {
      if (typeof ev['session_id'] === 'string') sessionId = ev['session_id'];
      if (typeof ev['model'] === 'string' && ev['model']) {
        agentModelName = ev['model'] as string;
      }
      continue;
    }

    // ── user message ───────────────────────────────────────────────────────
    if (evType === 'user') {
      const message = ev['message'];
      let text = '';
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        const m = message as Record<string, unknown>;
        const content = m['content'];
        if (Array.isArray(content)) {
          text = content
            .filter(
              (block): block is Record<string, unknown> =>
                block !== null &&
                typeof block === 'object' &&
                !Array.isArray(block),
            )
            .filter((block) => block['type'] === 'text')
            .map((block) =>
              typeof block['text'] === 'string' ? block['text'] : '',
            )
            .join('')
            .trim();
        }
      }
      const step: AtifStep = { step_id: stepId++, source: 'user' };
      if (text) step.message = text;
      steps.push(step);
      continue;
    }

    // ── assistant message ──────────────────────────────────────────────────
    if (evType === 'assistant') {
      const message = ev['message'];
      let text = '';
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        const m = message as Record<string, unknown>;
        const content = m['content'];
        if (Array.isArray(content)) {
          text = content
            .filter(
              (block): block is Record<string, unknown> =>
                block !== null &&
                typeof block === 'object' &&
                !Array.isArray(block),
            )
            .filter((block) => block['type'] === 'text')
            .map((block) =>
              typeof block['text'] === 'string' ? block['text'] : '',
            )
            .join('')
            .trim();
        }
      }

      const step: AtifStep = { step_id: stepId++, source: 'agent' };
      if (text) step.message = text;

      // Attach accumulated thinking blocks as reasoning_content, then clear
      if (pendingThinking.length > 0) {
        step.reasoning_content = pendingThinking.join('');
        pendingThinking.length = 0;
      }

      // Register this step for tool-call attachment by model_call_id
      const modelCallId = ev['model_call_id'];
      if (typeof modelCallId === 'string' && modelCallId) {
        callIdStepIndex.set(modelCallId, steps.length);
      }

      lastAgentStepIdx = steps.length;
      steps.push(step);
      continue;
    }

    // ── thinking block ─────────────────────────────────────────────────────
    if (evType === 'thinking') {
      const text = ev['text'];
      if (typeof text === 'string' && text) {
        pendingThinking.push(text);
      }
      continue;
    }

    // ── tool_call ──────────────────────────────────────────────────────────
    if (evType === 'tool_call') {
      // Skip started events; only completed events carry args + result
      if (ev['subtype'] !== 'completed') continue;

      const callId = typeof ev['call_id'] === 'string' ? ev['call_id'] : '';
      const modelCallId =
        typeof ev['model_call_id'] === 'string' ? ev['model_call_id'] : '';
      const toolCallDict = ev['tool_call'];

      if (
        !toolCallDict ||
        typeof toolCallDict !== 'object' ||
        Array.isArray(toolCallDict)
      )
        continue;

      const toolDict = toolCallDict as Record<string, unknown>;

      // Find the owning assistant step by model_call_id
      let ownerIdx = callIdStepIndex.get(modelCallId);
      if (ownerIdx === undefined) {
        // No preceding assistant message — create an implicit agent step
        const implicitStep: AtifStep = { step_id: stepId++, source: 'agent' };
        steps.push(implicitStep);
        ownerIdx = steps.length - 1;
        lastAgentStepIdx = ownerIdx;
        if (modelCallId) callIdStepIndex.set(modelCallId, ownerIdx);
      }

      const ownerStep = steps[ownerIdx];
      if (!ownerStep) continue;

      // Iterate toolDict entries in order: each entry is one tool invocation.
      // Build the AtifToolCall and its observation result together so the
      // native tool name is unambiguous (avoids mis-matching when two entries
      // map to the same canonical name, e.g. list_dir and file_search → Glob).
      // I2 fix: for the 2nd+ entry in a single event, suffix the id to avoid
      // duplicate tool_call_id within a step (which validateTrajectory rejects).
      const entries = Object.entries(toolDict);
      for (let idx = 0; idx < entries.length; idx++) {
        const entry = entries[idx];
        if (!entry) continue;
        const [nativeToolName, toolEntry] = entry;
        if (
          !toolEntry ||
          typeof toolEntry !== 'object' ||
          Array.isArray(toolEntry)
        )
          continue;
        const toolData = toolEntry as Record<string, unknown>;
        const args =
          toolData['args'] &&
          typeof toolData['args'] === 'object' &&
          !Array.isArray(toolData['args'])
            ? (toolData['args'] as Record<string, unknown>)
            : {};

        // Disambiguate call_id for 2nd+ entries to prevent duplicate tool_call_id
        const disambiguatedCallId =
          idx === 0 ? callId : callId ? `${callId}#${idx}` : `#${idx}`;

        const canonicalName = CURSOR_TOOL_MAP[nativeToolName] ?? nativeToolName;
        const atifCall = canonicalizeAgentPrompt({
          tool_call_id: disambiguatedCallId,
          function_name: canonicalName,
          arguments: args,
        });

        if (!ownerStep.tool_calls) {
          ownerStep.tool_calls = [];
          ownerStep.observation = { results: [] };
        }
        ownerStep.tool_calls.push(atifCall);

        // Attach the observation result
        const resultContent = normalizeToolResult(toolData['result']);
        const obsResult: { source_call_id?: string; content?: string | null } =
          {};
        if (disambiguatedCallId) obsResult.source_call_id = disambiguatedCallId;
        if (resultContent !== undefined) obsResult.content = resultContent;
        ownerStep.observation?.results.push(obsResult);
      }
      continue;
    }

    // ── result: attach usage to the last agent step ────────────────────────
    if (evType === 'result') {
      const usage = ev['usage'];
      if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
        const u = usage as Record<string, unknown>;
        const accum = emptyAccum();
        accumulateUsage(accum, u);

        // Attach to the last agent step as per-step metrics (single-source rule)
        if (lastAgentStepIdx !== undefined) {
          const targetStep = steps[lastAgentStepIdx];
          if (targetStep && targetStep.source === 'agent') {
            const hasAnyUsage =
              accum.inputTokens > 0 ||
              accum.outputTokens > 0 ||
              accum.cacheReadTokens > 0 ||
              accum.cacheWriteTokens > 0 ||
              accum.totalCost !== undefined;

            if (hasAnyUsage) {
              const metrics: import('../atif/types.ts').AtifMetrics = {};
              if (accum.inputTokens > 0)
                metrics.prompt_tokens = accum.inputTokens;
              if (accum.outputTokens > 0)
                metrics.completion_tokens = accum.outputTokens;
              if (accum.cacheReadTokens > 0)
                metrics.cached_tokens = accum.cacheReadTokens;
              if (accum.totalCost !== undefined)
                metrics.cost_usd = accum.totalCost;
              targetStep.metrics = metrics;

              // cache_write goes on step.extra (NOT metrics.extra — obol ignores that)
              if (accum.cacheWriteTokens > 0) {
                targetStep.extra = {
                  ...targetStep.extra,
                  cache_write: accum.cacheWriteTokens,
                };
              }

              // Stamp model_name on the metrics-bearing step so obol can price it
              if (agentModelName) {
                targetStep.model_name = agentModelName;
              }
            }
          }
          // Reset so the next result event targets the next agent step
          lastAgentStepIdx = undefined;
        }
      }
    }

    // ── interaction_query: silently skipped ────────────────────────────────
    // ── unknown event types: silently skipped ─────────────────────────────
    // (both fall through here)
  }

  // ATIF requires at least one step
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // Reassign sequential step_ids (1-based)
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step) step.step_id = i + 1;
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'cursor', version },
    steps,
  };
  if (sessionId) traj.session_id = sessionId;
  if (agentModelName) traj.agent.model_name = agentModelName;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeCursor produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
