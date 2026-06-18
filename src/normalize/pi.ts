import {
  ATIF_SCHEMA_VERSION,
  type AtifAgent,
  type AtifMetrics,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// Reverse mapping: Pi tool names → canonical names.
const PI_TOOL_MAP: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  find: 'Glob',
  ls: 'Glob',
};

interface PiEntry {
  type?: string;
  id?: string;
  modelId?: string;
  provider?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    provider?: string;
    usage?: PiUsage;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    details?: unknown;
  };
}

interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
  id?: string;
}

interface PiUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** json.dumps-style stringify for a non-string; passthrough for a string. */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Map a pi `message.usage` block to ATIF step metrics + extra.
 *   input→prompt_tokens, output→completion_tokens, cacheRead→cached_tokens,
 *   cost.total→cost_usd; cacheWrite→extra.cache_write.
 * Buckets stay DISJOINT (input excludes cacheRead, verified against the log:
 * input+output+cacheRead == totalTokens). cost rides per-step `metrics.cost_usd`
 * and cache-write rides `step.extra.cache_write` — the two locations obol's atif
 * dialect actually reads (it ignores metrics.extra.cache_write + final_metrics).
 * Returns undefined when the message carries no usage fields at all.
 */
function piMessageUsage(
  usage: PiUsage | undefined,
  provider: string | undefined,
): {
  metrics?: AtifMetrics | undefined;
  extra?: Record<string, unknown> | undefined;
} {
  const metrics: AtifMetrics = {};
  if (usage && typeof usage === 'object') {
    const prompt = numberOrUndefined(usage.input);
    const completion = numberOrUndefined(usage.output);
    const cached = numberOrUndefined(usage.cacheRead);
    const cost = numberOrUndefined(usage.cost?.total);
    if (prompt !== undefined) metrics.prompt_tokens = prompt;
    if (completion !== undefined) metrics.completion_tokens = completion;
    if (cached !== undefined) metrics.cached_tokens = cached;
    if (cost !== undefined) metrics.cost_usd = cost;
  }

  const extra: Record<string, unknown> = {};
  if (provider) extra['provider'] = provider;
  const cacheWrite = numberOrUndefined(usage?.cacheWrite);
  if (cacheWrite !== undefined && cacheWrite !== 0)
    extra['cache_write'] = cacheWrite;

  return {
    metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

/** Coerce a content value (array of blocks, or a bare string) to blocks. */
function blocksOf(content: unknown): PiContentBlock[] {
  if (Array.isArray(content)) return content as PiContentBlock[];
  return [];
}

/**
 * Render a pi toolResult message's content into the observation string. pi's
 * toolResult content is an array of `{type:"text", text}` blocks; some results
 * also carry a sibling `details` object (e.g. subagent runId/artifacts) that we
 * fold in as a `[details]` chunk so the rich subagent metadata survives.
 */
function formatToolResult(
  content: unknown,
  details: unknown,
  isError: boolean,
): string | undefined {
  const parts: string[] = [];
  for (const block of blocksOf(content)) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  if (typeof content === 'string' && content.trim()) {
    parts.push(content.trim());
  }
  if (details !== undefined && details !== null) {
    parts.push(`[details] ${stringify(details)}`);
  }
  if (isError) {
    parts.push('[error] tool reported failure');
  }
  const text = parts.filter((p) => p).join('\n\n');
  return text || undefined;
}

/**
 * Convert a Pi JSONL session log into a full-fidelity ATIF v1.7 trajectory.
 *
 * Pi session files are JSONL. The header carries a `type:"session"` entry (its
 * `id` → `session_id`) and a `type:"model_change"` entry (`modelId`/`provider`,
 * tracked forward as the active model). The rest are `type:"message"` entries
 * with `message.role` of `assistant`, `user`, or `toolResult`.
 *
 * Assistant content blocks: `text` (→ step.message), `thinking` (→
 * step.reasoning_content), and `toolCall` (`{type,id,name,arguments}` →
 * step.tool_calls). Each toolCall becomes its own agent step; the message's
 * text/reasoning + per-message usage attach to the FIRST tool step (or a
 * dedicated metrics/content step for a tool-less assistant message). The
 * `subagent` tool is aliased to the canonical `Agent` for execution calls (no
 * `action` key — they carry `agent`+`task`) and kept verbatim for management
 * calls (with an `action` key, e.g. `list`); confirmed against the real log.
 *
 * toolResult messages (`role:"toolResult"`, `toolCallId`, `toolName`, `content`)
 * are linked back to the agent step holding the matching tool call, satisfying
 * ATIF's same-step observation invariant.
 *
 * Token/cost conventions (preserved): input→prompt, output→completion,
 * cacheRead→cached, cost.total→cost_usd (per-step metrics — pi carries cost),
 * cacheWrite→step.extra.cache_write, provider→step.extra.provider. Per-step
 * only; no final_metrics token totals (single-source invariant).
 */
export function normalizePi(raw: string, version: string): AtifTrajectory {
  const entries: PiEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PiEntry;
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // Tolerate blank / unparseable lines — skip them.
    }
  }

  const steps: AtifStep[] = [];
  let stepId = 1;
  // Maps a tool_call_id to the agent step holding that call, so a later
  // toolResult message can attach its observation to the owning step.
  const callIndex = new Map<string, AtifStep>();

  let sessionId: string | undefined;
  // The model_change entry sets the active model; track it forward so every
  // usage-bearing step has a model_name for obol to price against.
  let activeModel: string | undefined;

  for (const entry of entries) {
    const type = entry['type'];

    if (type === 'session') {
      const id = entry['id'];
      if (typeof id === 'string' && id) sessionId = id;
      continue;
    }

    if (type === 'model_change') {
      const id = entry['modelId'];
      if (typeof id === 'string' && id) activeModel = id;
      continue;
    }

    if (type !== 'message') continue;
    const message = entry['message'];
    if (!message || typeof message !== 'object') continue;
    const role = message['role'];

    if (role === 'user') {
      const texts: string[] = [];
      for (const block of blocksOf(message['content'])) {
        if (
          block &&
          typeof block === 'object' &&
          typeof block.text === 'string'
        )
          texts.push(block.text);
      }
      if (typeof message['content'] === 'string')
        texts.push(message['content'] as string);
      const textMessage = texts
        .map((p) => p.trim())
        .filter((p) => p)
        .join('\n\n');
      if (textMessage) {
        steps.push({ step_id: stepId++, source: 'user', message: textMessage });
      }
      continue;
    }

    if (role === 'toolResult') {
      const callId = message['toolCallId'];
      if (typeof callId !== 'string' || !callId) continue;
      const owner = callIndex.get(callId);
      if (!owner) continue;
      const formatted = formatToolResult(
        message['content'],
        message['details'],
        message['isError'] === true,
      );
      const result: AtifObservationResult = { source_call_id: callId };
      if (formatted !== undefined) result.content = formatted;
      owner.observation ??= { results: [] };
      owner.observation.results.push(result);
      continue;
    }

    if (role !== 'assistant') continue;

    // Per-message model + usage. pi logs `message.model` on the assistant
    // message; fall back to the tracked model_change when it is absent.
    const model =
      typeof message.model === 'string' && message.model
        ? message.model
        : activeModel;
    const { metrics, extra } = piMessageUsage(message.usage, message.provider);
    const applyUsage = (step: AtifStep): void => {
      if (model) step.model_name = model;
      if (metrics) step.metrics = metrics;
      if (extra) step.extra = { ...step.extra, ...extra };
    };

    // Split content into text, reasoning, and tool-call blocks.
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolBlocks: PiContentBlock[] = [];
    for (const block of blocksOf(message['content'])) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'toolCall') {
        toolBlocks.push(block);
      } else if (block.type === 'thinking') {
        const value = typeof block.thinking === 'string' ? block.thinking : '';
        reasoningParts.push(value);
      } else if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    const messageText = textParts
      .map((p) => p.trim())
      .filter((p) => p)
      .join('\n\n');
    const reasoningText = reasoningParts
      .map((p) => p.trim())
      .filter((p) => p)
      .join('\n\n');

    let usageAttached = false;
    let contentAttached = false;

    for (const block of toolBlocks) {
      const name = block.name ?? '';
      const args = (
        typeof block.arguments === 'object' && block.arguments !== null
          ? block.arguments
          : {}
      ) as Record<string, unknown>;

      let canonical = PI_TOOL_MAP[name] ?? name;
      // pi-subagents: execution calls (no "action" key — they carry agent+task)
      // alias to Agent; management calls (with "action") stay "subagent".
      // Verified against the real log: 20 execution calls (agent+task, no
      // action) vs 1 management call (action:"list", no agent).
      if (name === 'subagent') {
        canonical = 'action' in args ? 'subagent' : 'Agent';
      }

      const callId = block.id ?? `${stepId}`;
      const tc: AtifToolCall = canonicalizeAgentPrompt({
        tool_call_id: callId,
        function_name: canonical,
        arguments: args,
      });

      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        tool_calls: [tc],
      };

      // Attach this message's text/reasoning to its FIRST tool step.
      if (!contentAttached) {
        if (messageText) step.message = messageText;
        if (reasoningText) step.reasoning_content = reasoningText;
        contentAttached = true;
      }
      // Attach this message's usage to its FIRST tool step (no double-count).
      if (!usageAttached && (model || metrics || extra)) {
        applyUsage(step);
        usageAttached = true;
      }

      steps.push(step);
      callIndex.set(tc.tool_call_id, step);
    }

    // A tool-less assistant message (final answer, or pure reasoning) that
    // still carries content or usage gets a dedicated metrics/content step so
    // nothing is dropped.
    if (
      !contentAttached &&
      (messageText || reasoningText || metrics || extra)
    ) {
      const step: AtifStep = { step_id: stepId++, source: 'agent' };
      if (messageText) step.message = messageText;
      if (reasoningText) step.reasoning_content = reasoningText;
      applyUsage(step);
      steps.push(step);
    }
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  const agent: AtifAgent = { name: 'pi', version };
  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent,
    steps,
  };
  if (sessionId) traj.session_id = sessionId;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizePi produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
