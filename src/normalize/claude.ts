import {
  ATIF_SCHEMA_VERSION,
  type AtifMetrics,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Populate an agent step's ATIF usage from a Claude assistant message's
 * `usage` block (and `model`). Mapping per the ATIF usage contract:
 *   input_tokens               → metrics.prompt_tokens
 *   output_tokens              → metrics.completion_tokens
 *   cache_read_input_tokens    → metrics.cached_tokens
 *   cache_creation_input_tokens→ extra.cache_write
 * No per-message cost is logged by Claude; cost is priced downstream by obol.
 */
function applyClaudeUsage(step: AtifStep, message: Record<string, unknown>) {
  const model = message['model'];
  if (typeof model === 'string' && model) step.model_name = model;

  const usage = message['usage'];
  if (!usage || typeof usage !== 'object') return;
  const u = usage as ClaudeUsage;

  const metrics: AtifMetrics = {};
  if (typeof u.input_tokens === 'number')
    metrics.prompt_tokens = u.input_tokens;
  if (typeof u.output_tokens === 'number')
    metrics.completion_tokens = u.output_tokens;
  if (typeof u.cache_read_input_tokens === 'number')
    metrics.cached_tokens = u.cache_read_input_tokens;
  if (Object.keys(metrics).length > 0) step.metrics = metrics;

  if (typeof u.cache_creation_input_tokens === 'number') {
    step.extra = { ...step.extra, cache_write: u.cache_creation_input_tokens };
  }
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

function blocksOf(entry: Record<string, unknown>): Block[] {
  const message = entry['message'];
  if (
    message &&
    typeof message === 'object' &&
    Array.isArray((message as { content?: unknown }).content)
  ) {
    return (message as { content: Block[] }).content;
  }
  return [];
}

/**
 * Convert a legacy Claude-Code session log (the `~/.claude/projects/.../*.jsonl`
 * layout, as produced by claude 2.1.175) into an ATIF v1.7 trajectory.
 */
export function normalizeClaudeLegacy(
  raw: string,
  version: string,
): AtifTrajectory {
  const steps: AtifStep[] = [];
  const callIndex = new Map<string, AtifStep>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = entry['type'];
    const blocks = blocksOf(entry);

    if (type === 'assistant') {
      const texts: string[] = [];
      const thinking: string[] = [];
      const toolCalls: AtifToolCall[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        else if (b.type === 'thinking' && typeof b.thinking === 'string')
          thinking.push(b.thinking);
        else if (b.type === 'tool_use') {
          toolCalls.push({
            tool_call_id: b.id ?? '',
            function_name: b.name ?? '',
            arguments: b.input ?? {},
          });
        }
      }
      const step: AtifStep = { step_id: steps.length + 1, source: 'agent' };
      if (typeof entry['timestamp'] === 'string')
        step.timestamp = entry['timestamp'];
      if (texts.length) step.message = texts.join('\n');
      if (thinking.length) step.reasoning_content = thinking.join('\n');
      if (toolCalls.length) {
        step.tool_calls = toolCalls;
        for (const c of toolCalls) callIndex.set(c.tool_call_id, step);
      }
      const message = entry['message'];
      if (message && typeof message === 'object')
        applyClaudeUsage(step, message as Record<string, unknown>);
      steps.push(step);
      continue;
    }

    if (type === 'tool_use') {
      // A flat top-level entry that is itself a tool_use block. Mirrors the
      // assistant-nested tool_use mapping.
      const step: AtifStep = { step_id: steps.length + 1, source: 'agent' };
      if (typeof entry['timestamp'] === 'string')
        step.timestamp = entry['timestamp'];
      const call: AtifToolCall = {
        tool_call_id: (entry['id'] as string | undefined) ?? '',
        function_name: (entry['name'] as string | undefined) ?? '',
        arguments:
          (entry['input'] as Record<string, unknown> | undefined) ?? {},
      };
      step.tool_calls = [call];
      callIndex.set(call.tool_call_id, step);
      steps.push(step);
      continue;
    }

    if (type === 'user') {
      // String-form content: the initial human prompt in 2.1.177+ logs.
      const ts =
        typeof entry['timestamp'] === 'string' ? entry['timestamp'] : undefined;
      const message = (entry['message'] as { content?: unknown } | undefined)
        ?.content;
      if (typeof message === 'string' && message.length > 0) {
        const userStep: AtifStep = {
          step_id: steps.length + 1,
          source: 'user',
          message,
        };
        if (ts) userStep.timestamp = ts;
        steps.push(userStep);
        continue;
      }

      const results: AtifObservationResult[] = [];
      const texts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const result: AtifObservationResult = {};
          if (b.tool_use_id) result.source_call_id = b.tool_use_id;
          if (b.content !== undefined) {
            result.content = b.content as Exclude<
              AtifObservationResult['content'],
              undefined
            >;
          }
          results.push(result);
        } else if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        }
      }
      // Always attach tool_results to their owning agent step, regardless of
      // whether there is also a text block in this user turn.
      for (const r of results) {
        const owner = r.source_call_id
          ? callIndex.get(r.source_call_id)
          : undefined;
        if (owner) {
          owner.observation ??= { results: [] };
          owner.observation.results.push(r);
        }
      }
      if (texts.length) {
        const userStep: AtifStep = {
          step_id: steps.length + 1,
          source: 'user',
          message: texts.join('\n'),
        };
        if (ts) userStep.timestamp = ts;
        steps.push(userStep);
      } else if (!results.length) {
        // Pure empty user turn — skip.
      }
    }
  }

  return {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'claude-code', version },
    steps,
  };
}
