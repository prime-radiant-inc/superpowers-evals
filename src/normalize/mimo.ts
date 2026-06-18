// Ported from Harbor's src/harbor/agents/installed/mimo.py
//   repo:   https://github.com/laude-institute/harbor (Apache-2.0)
//   commit: 5352049de712613e58459cad41afcf0bf8645738 (v0.14.0)
// Log-parsing logic is derived from Harbor; token buckets, tool-name
// canonicalization, and message-id dedup follow OUR conventions
// (docs/superpowers/reference/atif-normalizers.md), NOT Harbor's.

import {
  ATIF_SCHEMA_VERSION,
  type AtifMetrics,
  type AtifObservation,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// ---------------------------------------------------------------------------
// Tool name map — mimo native names → canonical names.
//
// mimo is a Xiaomi fork of opencode and shares its tool-name vocabulary.
// Unknown names pass through unchanged per the house convention.
// ---------------------------------------------------------------------------

const MIMO_TOOL_MAP: Record<string, string> = {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a millisecond epoch timestamp to an ISO-8601 string. */
function millisToIso(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-turn accumulator type (mirrors harbor's turn dict)
// ---------------------------------------------------------------------------

interface MimoTurn {
  parts: Record<string, unknown>[];
  finish: Record<string, unknown>;
  timestamp: unknown;
}

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

/**
 * Convert a mimo JSONL log into an ATIF v1.7 trajectory.
 *
 * mimo emits one JSON object per line from `mimo run --format=json`:
 *   step_start   — marks start of an agent turn (carries sessionID, timestamp)
 *   text         — agent text output (part.type == "text", part.text)
 *   reasoning    — explicit reasoning block (part.type == "reasoning", part.text)
 *   tool_use     — a tool call + result (part.type == "tool")
 *   step_finish  — end of turn, carries token usage + cost in part.tokens/part.cost
 *   error        — error event (ignored in the parse path)
 *
 * Events are grouped into turns by step_start / step_finish boundaries.
 *
 * Token mapping (per-step metrics only — SINGLE-SOURCE, no final_metrics):
 *   part.tokens.input              → metrics.prompt_tokens   (exclusive of cache)
 *   part.tokens.cache.read         → metrics.cached_tokens
 *   part.tokens.cache.write        → step.extra.cache_write  (only when > 0)
 *   part.tokens.output + .reasoning → metrics.completion_tokens (folded)
 *   part.cost                      → metrics.cost_usd        (only when > 0)
 *
 * Harbor emits BOTH per-step metrics AND final_metrics; we emit per-step only
 * to honour the SINGLE-SOURCE invariant and avoid double-counting in obol.
 */
export function normalizeMimo(raw: string, version: string): AtifTrajectory {
  // Parse the JSONL, skipping blank lines and malformed JSON.
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const stripped = line.trim();
    if (!stripped) continue;
    try {
      const parsed = JSON.parse(stripped) as unknown;
      const rec = asRecord(parsed);
      if (rec) events.push(rec);
    } catch {
      // Skip malformed lines
    }
  }

  // Extract session_id from the first event that carries one.
  let sessionId: string | undefined;
  for (const event of events) {
    const sid = event['sessionID'];
    if (typeof sid === 'string' && sid) {
      sessionId = sid;
      break;
    }
  }

  // Group events into turns delimited by step_start / step_finish.
  const turns: MimoTurn[] = [];
  let currentTurn: MimoTurn | null = null;

  for (const event of events) {
    const etype = event['type'];

    if (etype === 'step_start') {
      currentTurn = {
        parts: [],
        finish: {},
        timestamp: event['timestamp'],
      };
      continue;
    }

    if (etype === 'step_finish') {
      if (currentTurn !== null) {
        const finishPart = asRecord(event['part']) ?? {};
        currentTurn.finish = finishPart;
        turns.push(currentTurn);
        currentTurn = null;
      }
      continue;
    }

    // Collect text / reasoning / tool_use parts into the current turn.
    if (
      currentTurn !== null &&
      (etype === 'text' || etype === 'reasoning' || etype === 'tool_use')
    ) {
      const part = asRecord(event['part']) ?? {};
      currentTurn.parts.push(part);
    }
    // error events and any other types are ignored.
  }

  // Convert turns to ATIF steps.
  const steps: AtifStep[] = [];
  let stepId = 1;

  for (const turn of turns) {
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: AtifToolCall[] = [];
    const observations: { callId: string; content: string }[] = [];

    const timestamp = millisToIso(turn.timestamp);

    for (const part of turn.parts) {
      const ptype = part['type'];

      if (ptype === 'text') {
        const text = part['text'];
        if (typeof text === 'string' && text) textParts.push(text);
      } else if (ptype === 'reasoning') {
        const text = part['text'];
        if (typeof text === 'string' && text) reasoningParts.push(text);
      } else if (ptype === 'tool') {
        const toolName = typeof part['tool'] === 'string' ? part['tool'] : '';
        const callId = (
          typeof part['callID'] === 'string' && part['callID']
            ? part['callID']
            : typeof part['id'] === 'string' && part['id']
              ? part['id']
              : ''
        ) as string;

        const state = asRecord(part['state']) ?? {};
        const rawInput = state['input'];

        // Normalize tool input to a dict; non-dict values are wrapped as {value: ...}.
        let toolInput: Record<string, unknown>;
        if (rawInput !== undefined && rawInput !== null) {
          const rec = asRecord(rawInput);
          if (rec) {
            toolInput = rec;
          } else {
            toolInput = { value: rawInput };
          }
        } else {
          toolInput = {};
        }

        const canonical = MIMO_TOOL_MAP[toolName] ?? toolName;
        const tc: AtifToolCall = canonicalizeAgentPrompt({
          tool_call_id: callId,
          function_name: canonical,
          arguments: toolInput,
        });
        toolCalls.push(tc);

        // Capture output for the observation.
        const toolOutput = state['output'];
        if (toolOutput !== null && toolOutput !== undefined) {
          observations.push({
            callId,
            content: String(toolOutput),
          });
        }
      }
    }

    // Build metrics from step_finish.part.tokens.
    const finish = turn.finish;
    const tokensRaw = asRecord(finish['tokens']);
    const cacheRaw = tokensRaw ? asRecord(tokensRaw['cache']) : undefined;

    const inputTok = tokensRaw ? num(tokensRaw['input']) : 0;
    const outputTok = tokensRaw ? num(tokensRaw['output']) : 0;
    const reasoningTok = tokensRaw ? num(tokensRaw['reasoning']) : 0;
    const cacheRead = cacheRaw ? num(cacheRaw['read']) : 0;
    const cacheWrite = cacheRaw ? num(cacheRaw['write']) : 0;
    const cost = num(finish['cost']);

    // Only emit metrics when there is actual token data.
    // Harbor's condition: `if input_tok or output_tok or cache_read`
    let metrics: AtifMetrics | undefined;
    let cacheWriteExtra: number | undefined;

    if (inputTok > 0 || outputTok > 0 || reasoningTok > 0 || cacheRead > 0) {
      metrics = {
        // prompt_tokens = input_tok (already EXCLUSIVE of cache — Harbor's
        // running total adds input_tok + cache_read separately, confirming
        // input_tok is the uncached portion; no subtraction needed here).
        prompt_tokens: inputTok,
        // completion = output + reasoning folded in (per ATIF disjoint contract)
        completion_tokens: outputTok + reasoningTok,
        cached_tokens: cacheRead,
      };
      if (cost > 0) metrics.cost_usd = cost;
    }

    // cache_write rides in step.extra.cache_write only when > 0.
    if (cacheWrite > 0) {
      cacheWriteExtra = cacheWrite;
    }

    // Build the step.
    const step: AtifStep = {
      step_id: stepId++,
      source: 'agent',
    };

    if (timestamp) step.timestamp = timestamp;

    const messageText = textParts.join('\n');
    if (messageText) step.message = messageText;

    if (reasoningParts.length > 0) {
      step.reasoning_content = reasoningParts.join('\n\n');
    }

    if (toolCalls.length > 0) step.tool_calls = toolCalls;

    if (metrics) step.metrics = metrics;

    if (cacheWriteExtra !== undefined) {
      step.extra = { ...step.extra, cache_write: cacheWriteExtra };
    }

    // Build observation: each tool output maps to a result with source_call_id.
    if (observations.length > 0) {
      const obsResults: { source_call_id?: string; content?: string }[] = [];
      for (const obs of observations) {
        const result: { source_call_id?: string; content?: string } = {
          content: obs.content,
        };
        if (obs.callId) result.source_call_id = obs.callId;
        obsResults.push(result);
      }
      const observation: AtifObservation = { results: obsResults };
      step.observation = observation;
    }

    steps.push(step);
  }

  // ATIF requires at least one step. Emit a minimal user step if the log was
  // empty or produced no turns.
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // Reassign sequential step_ids (1-based, no gaps).
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step) step.step_id = i + 1;
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'mimo', version },
    steps,
  };

  if (sessionId) traj.session_id = sessionId;

  // SINGLE-SOURCE: mimo carries per-turn token data, so usage lives in
  // per-step metrics ONLY. No final_metrics totals — that would double-count.

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeMimo produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
