// Ported from Harbor's src/harbor/agents/installed/qwen_code.py
//   repo:   https://github.com/laude-institute/harbor (Apache-2.0)
//   commit: 5352049de712613e58459cad41afcf0bf8645738 (v0.14.0)
// Log-parsing logic is derived from Harbor; token buckets, tool-name
// canonicalization, and message-id dedup follow OUR conventions
// (docs/superpowers/reference/atif-normalizers.md), NOT Harbor's.

import {
  ATIF_SCHEMA_VERSION,
  type AtifMetrics,
  type AtifObservation,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// Reverse mapping: qwen-code (Gemini-fork) native tool names → canonical names.
// qwen-code is a fork of gemini-cli, so it uses the same Gemini tool names.
// Mirror GEMINI_TOOL_MAP — unknown names pass through unchanged.
const QWEN_TOOL_MAP: Record<string, string> = {
  run_shell_command: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  grep_search: 'Grep',
  glob: 'Glob',
  activate_skill: 'Skill',
  google_web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  write_todos: 'TodoWrite',
  list_directory: 'Glob',
  enter_plan_mode: 'EnterPlanMode',
  exit_plan_mode: 'ExitPlanMode',
  invoke_agent: 'Agent',
};

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Extract ATIF usage metrics from a qwen-code event's `usageMetadata` block.
 *
 * qwen-code (Gemini fork) Gemini API fields:
 *   promptTokenCount        — INCLUSIVE of cached content
 *   candidatesTokenCount    — output tokens
 *   cachedContentTokenCount — cache-read tokens (subset of promptTokenCount)
 *   thoughtsTokenCount      — reasoning tokens (fold into completion)
 *
 * Our disjoint-bucket convention:
 *   prompt_tokens     = promptTokenCount − cachedContentTokenCount  (uncached input only)
 *   cached_tokens     = cachedContentTokenCount
 *   completion_tokens = candidatesTokenCount + thoughtsTokenCount  (thoughts folded in)
 *
 * No per-event cost in qwen-code logs → cost_usd is never set (priced downstream).
 * Returns undefined when the event carries no usageMetadata or all counts are 0.
 */
function extractQwenMetrics(
  usageMetadata: Record<string, unknown>,
): AtifMetrics | undefined {
  const promptInclusive = num(usageMetadata['promptTokenCount']);
  const candidatesTok = num(usageMetadata['candidatesTokenCount']);
  const cachedTok = num(usageMetadata['cachedContentTokenCount']);
  const thoughtsTok = num(usageMetadata['thoughtsTokenCount']);

  if (promptInclusive === 0 && candidatesTok === 0) return undefined;

  // promptTokenCount is inclusive of cached; subtract to get uncached input.
  const promptUncached = promptInclusive - cachedTok;

  return {
    prompt_tokens: promptUncached >= 0 ? promptUncached : 0,
    completion_tokens: candidatesTok + thoughtsTok,
    cached_tokens: cachedTok,
  };
}

/**
 * Convert a qwen-code session JSONL log into an ATIF v1.7 trajectory.
 *
 * Log location (Harbor discovery): ~/.qwen/projects/**\/*.jsonl (latest by mtime),
 * copied to /logs/agent/qwen-sessions/ by the Harbor run wrapper.
 * The log is JSONL: one JSON object per line.
 *
 * Event types (Gemini-style, since qwen-code is a Gemini-cli fork):
 *   "user"        — user turn; message.parts[].text holds the user message.
 *   "assistant"   — agent turn; message.parts[] may contain {text} and/or
 *                   {functionCall: {id, name, args}} entries;
 *                   usageMetadata (top-level on the event) carries token counts.
 *   "tool_result" — tool outputs; message.parts[].functionResponse carries
 *                   {id, response: {output}} for each tool call. Harbor attaches
 *                   these to the most recent assistant step with a matching
 *                   tool_call_id (backward search).
 *
 * Top-level metadata fields (sessionId, version, model) are extracted from the
 * first event that carries each — Harbor takes last-seen; we match that.
 *
 * qwen-code has no re-emitting / running-snapshot pattern (unlike gemini-cli),
 * so no message-id dedup is needed — each event is a distinct event.
 */
export function normalizeQwen(raw: string, version: string): AtifTrajectory {
  // -------------------------------------------------------------------------
  // Phase 1: parse JSONL
  // -------------------------------------------------------------------------
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const stripped = line.trim();
    if (!stripped) continue;
    let record: unknown;
    try {
      record = JSON.parse(stripped);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    events.push(record as Record<string, unknown>);
  }

  // -------------------------------------------------------------------------
  // Phase 2: extract session-level metadata (last-seen wins, per Harbor)
  // -------------------------------------------------------------------------
  let sessionId: string | undefined;
  let logVersion: string | undefined;
  let modelName: string | undefined;

  for (const event of events) {
    if (typeof event['sessionId'] === 'string') sessionId = event['sessionId'];
    if (typeof event['version'] === 'string') logVersion = event['version'];
    if (typeof event['model'] === 'string') modelName = event['model'];
  }

  // -------------------------------------------------------------------------
  // Phase 3: convert events to ATIF steps
  // -------------------------------------------------------------------------
  const steps: AtifStep[] = [];
  let stepId = 1;

  for (const event of events) {
    const eventType = event['type'];
    const timestamp =
      typeof event['timestamp'] === 'string' ? event['timestamp'] : undefined;
    const message = event['message'];

    if (
      typeof message !== 'object' ||
      message === null ||
      Array.isArray(message)
    )
      continue;

    const msg = message as Record<string, unknown>;
    const parts = msg['parts'];
    if (!Array.isArray(parts)) continue;

    // ------------------------------------------------------------------
    // User turn
    // ------------------------------------------------------------------
    if (eventType === 'user') {
      const textParts: string[] = [];
      for (const part of parts) {
        if (typeof part !== 'object' || part === null) continue;
        const p = part as Record<string, unknown>;
        if (typeof p['text'] === 'string' && p['text']) {
          textParts.push(p['text']);
        }
      }
      const text = textParts.join('\n');
      if (!text) continue;
      const step: AtifStep = {
        step_id: stepId++,
        source: 'user',
        message: text,
      };
      if (timestamp) step.timestamp = timestamp;
      steps.push(step);
      continue;
    }

    // ------------------------------------------------------------------
    // Assistant turn
    // ------------------------------------------------------------------
    if (eventType === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: AtifToolCall[] = [];

      for (const part of parts) {
        if (typeof part !== 'object' || part === null) continue;
        const p = part as Record<string, unknown>;

        if (typeof p['text'] === 'string' && p['text']) {
          textParts.push(p['text']);
        }

        const fc = p['functionCall'];
        if (typeof fc === 'object' && fc !== null) {
          const fcObj = fc as Record<string, unknown>;
          const nativeName =
            typeof fcObj['name'] === 'string' ? fcObj['name'] : '';
          const canonical = QWEN_TOOL_MAP[nativeName] ?? nativeName;

          const rawArgs = fcObj['args'] ?? {};
          const isDict =
            typeof rawArgs === 'object' &&
            rawArgs !== null &&
            !Array.isArray(rawArgs);
          const args: Record<string, unknown> = isDict
            ? { ...(rawArgs as Record<string, unknown>) }
            : { raw_args: rawArgs };

          const tc: AtifToolCall = canonicalizeAgentPrompt({
            tool_call_id:
              typeof fcObj['id'] === 'string' ? fcObj['id'] : '',
            function_name: canonical,
            arguments: args,
          });
          toolCalls.push(tc);
        }
      }

      // usageMetadata is top-level on the event (not inside message).
      const usageMetadata = event['usageMetadata'];
      let metrics: AtifMetrics | undefined;
      let stepModelName: string | undefined;
      if (typeof usageMetadata === 'object' && usageMetadata !== null) {
        metrics = extractQwenMetrics(usageMetadata as Record<string, unknown>);
        if (metrics) {
          stepModelName = modelName;
        }
      }

      const messageText = textParts.length > 0 ? textParts.join('\n') : undefined;

      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        // Mirror Harbor: use text if present, else "(tool use)" placeholder
        message: messageText ?? '(tool use)',
      };
      if (timestamp) step.timestamp = timestamp;
      if (toolCalls.length > 0) step.tool_calls = toolCalls;
      if (metrics) {
        step.metrics = metrics;
        if (stepModelName) step.model_name = stepModelName;
      }
      steps.push(step);
      continue;
    }

    // ------------------------------------------------------------------
    // Tool result turn
    // Harbor: for each functionResponse, walk backward through steps to find
    // the most recent assistant step whose tool_calls contains a matching
    // tool_call_id, then append the ObservationResult to that step.
    // ------------------------------------------------------------------
    if (eventType === 'tool_result') {
      for (const part of parts) {
        if (typeof part !== 'object' || part === null) continue;
        const p = part as Record<string, unknown>;
        const fr = p['functionResponse'];
        if (typeof fr !== 'object' || fr === null) continue;
        const frObj = fr as Record<string, unknown>;

        const callId =
          typeof frObj['id'] === 'string' ? frObj['id'] : '';
        const responseObj = frObj['response'];
        const output =
          typeof responseObj === 'object' &&
          responseObj !== null &&
          typeof (responseObj as Record<string, unknown>)['output'] === 'string'
            ? ((responseObj as Record<string, unknown>)['output'] as string)
            : '';

        // Walk backward to find the most recent agent step with matching tool_call_id
        for (let i = steps.length - 1; i >= 0; i--) {
          const candidate = steps[i]!;
          if (candidate.source !== 'agent' || !candidate.tool_calls) continue;
          const matched = candidate.tool_calls.some(
            (tc) => tc.tool_call_id === callId,
          );
          if (!matched) continue;

          const result: AtifObservationResult = { content: output };
          if (callId) result.source_call_id = callId;

          if (!candidate.observation) {
            const obs: AtifObservation = { results: [result] };
            candidate.observation = obs;
          } else {
            candidate.observation.results.push(result);
          }
          break;
        }
      }
      continue;
    }
  }

  // -------------------------------------------------------------------------
  // Phase 4: ensure at least one step (ATIF requires steps.length >= 1)
  // -------------------------------------------------------------------------
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // -------------------------------------------------------------------------
  // Phase 5: build and validate trajectory
  // -------------------------------------------------------------------------
  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'qwen-code', version },
    steps,
  };

  if (sessionId !== undefined) traj.session_id = sessionId;

  // Log version metadata stashed in extra when it differs from the passed arg.
  if (logVersion !== undefined && logVersion !== version) {
    traj.agent.extra = { log_version: logVersion };
  }

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeQwen produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
