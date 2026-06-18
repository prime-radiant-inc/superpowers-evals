// Ported from Harbor's src/harbor/agents/installed/goose.py
//   repo:   https://github.com/laude-institute/harbor (Apache-2.0)
//   commit: 5352049de712613e58459cad41afcf0bf8645738 (v0.14.0)
// Log-parsing logic is derived from Harbor; token buckets, tool-name
// canonicalization, and message-id dedup follow OUR conventions
// (docs/superpowers/reference/atif-normalizers.md), NOT Harbor's.

import {
  ATIF_SCHEMA_VERSION,
  type AtifFinalMetrics,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// Reverse mapping: Goose tool names → canonical names.
// Native tool names come from goose's developer extension and others.
// Unknown names pass through unchanged.
const GOOSE_TOOL_MAP: Record<string, string> = {
  shell: 'Bash',
  text_editor: 'Edit',
  read_file: 'Read',
  write_file: 'Write',
  list_files: 'Glob',
  list_directory: 'Glob',
  grep: 'Grep',
  search_files: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  browser: 'WebFetch',
  todo_write: 'TodoWrite',
  computer: 'Agent',
};

// Pattern that matches the goose plain-text tool separator line:
//   ─── tool_name | extension ──────────────────────────
const TOOL_SEP_PATTERN = /^─── (\S+) \| (\S+) ─+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalizeName(nativeName: string): string {
  return GOOSE_TOOL_MAP[nativeName] ?? nativeName;
}

/**
 * Detect whether the raw log is stream-JSON (JSONL) or plain text.
 *
 * Strategy: try to parse the FIRST non-empty line as JSON. If it succeeds
 * and the parsed value has a `type` field (the goose stream-json event
 * discriminant), treat the whole input as stream-JSON. Otherwise fall back
 * to the plain-text parser.
 *
 * The text format opens with prose lines like "Loading recipe: harbor-task"
 * and separator lines like "─── shell | developer ──────". These are not
 * valid JSON, so the heuristic is reliable.
 */
function isStreamJson(raw: string): boolean {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        'type' in (parsed as Record<string, unknown>)
      ) {
        return true;
      }
    } catch {
      // Not JSON → text path
    }
    break;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Plain-text path (legacy goose format, no tokens)
// ---------------------------------------------------------------------------

interface TextEvent {
  kind: 'agent_text' | 'tool_call';
  text?: string;
  tool_name?: string;
  extension?: string;
  arguments?: string;
  output?: string;
}

/**
 * Parse goose CLI text output into structured events.
 *
 * Ported from Harbor's Goose._parse_goose_log. The text format uses
 * separator lines like:
 *   ─── tool_name | extension ──────────────────────────
 * followed by key: value arguments (blank line terminates), then tool output
 * until the next separator.
 */
function parseGooseTextLog(logText: string): TextEvent[] {
  const events: TextEvent[] = [];
  const lines = logText.split('\n');
  let i = 0;
  const agentTextBuf: string[] = [];

  function flushAgentText(): void {
    const text = agentTextBuf.join('\n').trim();
    if (text) events.push({ kind: 'agent_text', text });
    agentTextBuf.length = 0;
  }

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = TOOL_SEP_PATTERN.exec(line);
    if (m) {
      flushAgentText();
      const toolName = m[1] ?? '';
      const extension = m[2] ?? '';
      i++;

      // Collect argument lines until blank line or next separator
      const argLines: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (l === '') {
          i++;
          break;
        }
        if (TOOL_SEP_PATTERN.exec(l)) break;
        argLines.push(l);
        i++;
      }

      // Collect output lines until next separator
      const outputLines: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (TOOL_SEP_PATTERN.exec(l)) break;
        outputLines.push(l);
        i++;
      }

      // Separate trailing agent text from tool output (Harbor's heuristic):
      // a blank line in the output signals the end of tool output; anything
      // after that is agent prose for the next turn.
      const toolOutputLines: string[] = [];
      const trailingTextLines: string[] = [];
      let foundGap = false;
      for (const ol of outputLines) {
        if (foundGap) {
          trailingTextLines.push(ol);
        } else {
          toolOutputLines.push(ol);
          if (ol === '' && toolOutputLines.length > 0) {
            foundGap = true;
          }
        }
      }

      events.push({
        kind: 'tool_call',
        tool_name: toolName,
        extension,
        arguments: argLines.join('\n').trim(),
        output: toolOutputLines.join('\n').trim(),
      });

      const trailingText = trailingTextLines.join('\n').trim();
      if (trailingText) agentTextBuf.push(trailingText);
    } else {
      agentTextBuf.push(line);
      i++;
    }
  }

  flushAgentText();
  return events;
}

/**
 * Convert goose CLI text log to ATIF trajectory (text/legacy path).
 *
 * No token data is available in this format, so no metrics are emitted.
 * Tool names come from the extension (e.g. "developer") and are canonicalized
 * via GOOSE_TOOL_MAP. Arguments are parsed from "key: value" lines.
 */
function normalizeGooseText(raw: string, version: string): AtifTrajectory {
  const events = parseGooseTextLog(raw);
  const steps: AtifStep[] = [];
  let stepId = 1;

  for (const event of events) {
    if (event.kind === 'agent_text') {
      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        message: event.text ?? '',
      };
      steps.push(step);
    } else if (event.kind === 'tool_call') {
      // Generate a deterministic-enough id per tool call
      const toolCallId = `tc-${stepId}`;
      const nativeName = event.tool_name ?? '';
      const canonical = canonicalizeName(nativeName);

      // Parse arguments from "key: value" lines
      const argsText = event.arguments ?? '';
      const argsDict: Record<string, string> = {};
      for (const argLine of argsText.split('\n')) {
        const colonIdx = argLine.indexOf(': ');
        if (colonIdx >= 0) {
          const key = argLine.slice(0, colonIdx).trim();
          const val = argLine.slice(colonIdx + 2).trim();
          if (key) argsDict[key] = val;
        } else if (argLine.trim()) {
          argsDict['input'] = argLine.trim();
        }
      }

      const tc: AtifToolCall = canonicalizeAgentPrompt({
        tool_call_id: toolCallId,
        function_name: canonical,
        arguments:
          Object.keys(argsDict).length > 0 ? argsDict : { raw: argsText },
      });

      const outputText = event.output;
      const obsResult: AtifObservationResult = { source_call_id: toolCallId };
      if (outputText) obsResult.content = outputText;

      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        message: `[tool call: ${nativeName}]`,
        tool_calls: [tc],
        observation: { results: [obsResult] },
      };
      steps.push(step);
    }
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    if (s) s.step_id = k + 1;
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'goose', version },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeGoose (text) produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }
  return traj;
}

// ---------------------------------------------------------------------------
// Stream-JSON path (current default goose format)
// ---------------------------------------------------------------------------

interface GooseStreamEntry {
  kind: 'agent_text' | 'tool_call' | 'aggregate';
  role: string;
  text_parts: string[];
  reasoning_parts: string[];
  tool_calls: AtifToolCall[];
  tool_responses: AtifObservationResult[];
}

/**
 * Extract goose usage from a `complete` event.
 *
 * goose >= 1.37 reports `input_tokens` and `output_tokens` flat on the event
 * alongside `total_tokens`. Older goose reports only `total_tokens`. Missing
 * fields come back as undefined.
 *
 * Ported from Harbor's Goose._extract_goose_usage.
 */
interface GooseUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function extractGooseUsage(completeEvent: Record<string, unknown>): GooseUsage {
  const result: GooseUsage = {};
  if (typeof completeEvent['input_tokens'] === 'number')
    result.inputTokens = completeEvent['input_tokens'];
  if (typeof completeEvent['output_tokens'] === 'number')
    result.outputTokens = completeEvent['output_tokens'];
  if (typeof completeEvent['total_tokens'] === 'number')
    result.totalTokens = completeEvent['total_tokens'];
  return result;
}

/**
 * Convert goose stream-JSON JSONL output to ATIF trajectory.
 *
 * Ported from Harbor's Goose._convert_goose_stream_json_to_atif.
 *
 * Goose stream-json emits incremental streaming chunks: multiple
 * {"type":"message"} events share the same message.id and each carries a
 * small content fragment. We aggregate all chunks with the same id into a
 * single logical message (preserving encounter order via orderedIds).
 *
 * Token data:
 *   - Only available on the session-level `complete` event → final_metrics.
 *   - No per-step metrics (SINGLE-SOURCE invariant).
 *   - goose >= 1.37: input_tokens + output_tokens → total_prompt_tokens +
 *     total_completion_tokens.
 *   - Older goose: total_tokens only → kept in final_metrics.extra.total_tokens
 *     (Harbor's convention for the "total only" case).
 *   - No cache split is reported by goose → no cached_tokens, no cache_write.
 *   - No per-message cost → priced downstream.
 */
function normalizeGooseStream(raw: string, version: string): AtifTrajectory {
  const orderedIds: string[] = [];
  const messages = new Map<string, GooseStreamEntry>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;

  // 1. Aggregate streaming chunks into logical messages keyed by id.
  let syntheticErrorIdx = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const eventType = event['type'];

    if (eventType === 'message') {
      const msg = event['message'];
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      const msgId =
        typeof m['id'] === 'string' && m['id']
          ? m['id']
          : `synthetic-${orderedIds.length}`;
      const role = typeof m['role'] === 'string' ? m['role'] : '';

      if (!messages.has(msgId)) {
        orderedIds.push(msgId);
        messages.set(msgId, {
          kind: 'aggregate',
          role,
          text_parts: [],
          reasoning_parts: [],
          tool_calls: [],
          tool_responses: [],
        });
      }

      const entry = messages.get(msgId);
      if (!entry) continue;

      const content = m['content'];
      if (!Array.isArray(content)) continue;

      for (const item of content) {
        if (typeof item !== 'object' || item === null) continue;
        const it = item as Record<string, unknown>;
        const itemType = it['type'];

        if (itemType === 'text') {
          const text = it['text'];
          if (typeof text === 'string') entry.text_parts.push(text);
        } else if (itemType === 'thinking') {
          const text = it['text'];
          if (typeof text === 'string') entry.reasoning_parts.push(text);
        } else if (itemType === 'toolRequest') {
          const tcData = it['toolCall'];
          if (!tcData || typeof tcData !== 'object') continue;
          const tcObj = tcData as Record<string, unknown>;
          const tcValue = tcObj['value'];
          if (!tcValue || typeof tcValue !== 'object') continue;
          const tcVal = tcValue as Record<string, unknown>;

          const nativeName =
            typeof tcVal['name'] === 'string' ? tcVal['name'] : 'unknown';
          const canonical = canonicalizeName(nativeName);
          const rawArgs = tcVal['arguments'];
          const args: Record<string, unknown> =
            rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};

          const tcId =
            typeof it['id'] === 'string' && it['id']
              ? it['id']
              : `tc-${entry.tool_calls.length}`;

          const tc = canonicalizeAgentPrompt({
            tool_call_id: tcId,
            function_name: canonical,
            arguments: args,
          });
          entry.tool_calls.push(tc);
        } else if (itemType === 'toolResponse') {
          const trData = it['toolResult'];
          if (!trData || typeof trData !== 'object') continue;
          const trObj = trData as Record<string, unknown>;
          const trValue = trObj['value'];
          const trVal =
            trValue && typeof trValue === 'object' && !Array.isArray(trValue)
              ? (trValue as Record<string, unknown>)
              : {};

          let obsText = '';
          const trContent = trVal['content'];
          if (Array.isArray(trContent)) {
            obsText = trContent
              .filter(
                (c): c is { type: string; text: string } =>
                  typeof c === 'object' &&
                  c !== null &&
                  (c as Record<string, unknown>)['type'] === 'text',
              )
              .map((c) => c.text)
              .join('\n');
          }

          const sourceId =
            typeof it['id'] === 'string' && it['id'] ? it['id'] : undefined;
          const obsResult: AtifObservationResult = {};
          if (sourceId) obsResult.source_call_id = sourceId;
          if (obsText) obsResult.content = obsText;
          entry.tool_responses.push(obsResult);
        }
      }
    } else if (eventType === 'complete') {
      const usage = extractGooseUsage(event);
      inputTokens = usage.inputTokens;
      outputTokens = usage.outputTokens;
      totalTokens = usage.totalTokens;
    } else if (eventType === 'error') {
      const errMsg =
        typeof event['error'] === 'string' ? event['error'] : 'Unknown error';
      const errId = `error-${syntheticErrorIdx++}`;
      orderedIds.push(errId);
      messages.set(errId, {
        kind: 'aggregate',
        role: 'error',
        text_parts: [`[error] ${errMsg}`],
        reasoning_parts: [],
        tool_calls: [],
        tool_responses: [],
      });
    }
  }

  // 2. Convert aggregated messages into ATIF steps.
  //    Tool-response user messages are attached as observations to the
  //    preceding assistant step rather than emitted as separate steps.
  const steps: AtifStep[] = [];
  let stepId = 1;

  for (const msgId of orderedIds) {
    const entry = messages.get(msgId);
    if (!entry) continue;

    const role = entry.role;
    const text = entry.text_parts.join('').trim();
    const reasoning = entry.reasoning_parts.join('').trim() || undefined;
    const toolCalls = entry.tool_calls;
    const toolResponses = entry.tool_responses;

    if (role === 'user') {
      // User messages that only carry toolResponses are observations for the
      // preceding assistant step — attach them there.
      if (toolResponses.length > 0) {
        const prev = steps[steps.length - 1];
        if (prev && prev.source === 'agent') {
          if (prev.observation) {
            prev.observation.results.push(...toolResponses);
          } else {
            prev.observation = { results: toolResponses };
          }
          continue;
        }
      }

      // Actual user text — skip if empty
      if (!text) continue;
      steps.push({ step_id: stepId++, source: 'user', message: text });
    } else if (role === 'assistant') {
      if (!text && !reasoning && toolCalls.length === 0) continue;

      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        message: text || '[tool call]',
      };
      if (reasoning) step.reasoning_content = reasoning;
      if (toolCalls.length > 0) step.tool_calls = toolCalls;
      if (toolResponses.length > 0)
        step.observation = { results: toolResponses };
      steps.push(step);
    } else if (role === 'error') {
      const errText = entry.text_parts.join('');
      steps.push({ step_id: stepId++, source: 'agent', message: errText });
    }
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    if (s) s.step_id = k + 1;
  }

  // Build final_metrics from the complete event.
  // SINGLE-SOURCE: all token data lives here, never in per-step metrics.
  // goose reports no cache split; no cost is logged.
  let finalMetrics: AtifFinalMetrics | undefined;
  if (
    totalTokens !== undefined ||
    inputTokens !== undefined ||
    outputTokens !== undefined
  ) {
    finalMetrics = {};
    // goose >= 1.37: use input_tokens as prompt (it is the uncached total — goose
    // does not split cache separately in this field). Older goose reports only
    // total_tokens which rides in extra.total_tokens (Harbor's convention).
    if (inputTokens !== undefined)
      finalMetrics.total_prompt_tokens = inputTokens;
    if (outputTokens !== undefined)
      finalMetrics.total_completion_tokens = outputTokens;
    if (totalTokens !== undefined)
      finalMetrics.extra = { total_tokens: totalTokens };
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'goose', version },
    steps,
  };
  if (finalMetrics) traj.final_metrics = finalMetrics;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeGoose (stream) produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }
  return traj;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Convert a Goose session log into an ATIF v1.7 trajectory.
 *
 * Goose writes one log file (goose.txt) that may be in one of two formats:
 *
 *   1. Stream-JSON (current default, --output-format stream-json): JSONL where
 *      each line is a JSON object with a `type` discriminant. Detected by
 *      attempting to JSON-parse the first non-empty line and checking for a
 *      `type` field.
 *
 *   2. Plain-text (legacy, older goose without --output-format): prose output
 *      with tool-call separator lines "─── tool_name | extension ───".
 *
 * Token data is only available in the stream-JSON path (from the `complete`
 * event) and maps to final_metrics — the log carries no per-message usage, so
 * all token data lives in final_metrics only (SINGLE-SOURCE). The text path
 * carries no tokens at all.
 */
export function normalizeGoose(raw: string, version: string): AtifTrajectory {
  if (isStreamJson(raw)) {
    return normalizeGooseStream(raw, version);
  }
  return normalizeGooseText(raw, version);
}
