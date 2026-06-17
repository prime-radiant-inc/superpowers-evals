import { readFileSync } from 'node:fs';
import {
  ATIF_SCHEMA_VERSION,
  type AtifMetrics,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';

interface KimiUsage {
  inputOther?: unknown;
  output?: unknown;
  inputCacheRead?: unknown;
  inputCacheCreation?: unknown;
}

interface KimiToolResult {
  output?: unknown;
  isError?: unknown;
}

interface KimiEvent {
  type?: string;
  name?: string;
  args?: unknown;
  // tool.call fields
  toolCallId?: string;
  stepUuid?: string;
  // tool.result fields
  parentUuid?: string;
  result?: KimiToolResult;
  // content.part fields
  part?: {
    type?: string;
    think?: string;
    text?: string;
  };
}

interface KimiEntry {
  type?: string;
  model?: unknown;
  usage?: KimiUsage;
  usageScope?: unknown;
  event?: KimiEvent;
}

// A non-negative integer token count, else 0. Kimi rows carry plain integers;
// anything non-numeric is treated as absent.
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

interface KimiUsageRow {
  scope: 'turn' | 'session';
  model: string | undefined;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWrite: number;
}

// Parse a kimi `usage.record` row into a normalized usage descriptor, or null
// when it is not a usage row or carries no tokens. Field mapping (verified
// against real wire.jsonl, 2026-06-15):
//   inputOther         → prompt_tokens
//   output             → completion_tokens
//   inputCacheRead     → cached_tokens
//   inputCacheCreation → extra.cache_write
//   model              → model_name (preserved verbatim, e.g.
//                        "kimi-code/kimi-for-coding")
function parseKimiUsage(entry: KimiEntry): KimiUsageRow | null {
  if (entry['type'] !== 'usage.record') return null;
  const usage = entry['usage'];
  if (!usage || typeof usage !== 'object') return null;

  const promptTokens = tokenCount(usage['inputOther']);
  const completionTokens = tokenCount(usage['output']);
  const cachedTokens = tokenCount(usage['inputCacheRead']);
  const cacheWrite = tokenCount(usage['inputCacheCreation']);

  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    cachedTokens === 0 &&
    cacheWrite === 0
  ) {
    return null;
  }

  const rawScope = entry['usageScope'];
  const scope = rawScope === 'session' ? 'session' : 'turn';
  const model = typeof entry['model'] === 'string' ? entry['model'] : undefined;

  return {
    scope,
    model,
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheWrite,
  };
}

/**
 * Convert a Kimi Code wire.jsonl session log into an ATIF v1.7 trajectory.
 *
 * Kimi records tool invocations as context loop events:
 *   {"type":"context.append_loop_event",
 *    "event":{"type":"tool.call","name":"Read","args":{...}}}
 *
 * Tool names are already in Claude-Code canonical form; the only rewrite is
 * canonicalizing bare superpowers skill names (e.g. "brainstorming" →
 * "superpowers:brainstorming") on Skill calls.
 *
 * Full-fidelity extras (verified against real wire.jsonl, 2026-06-17):
 *   - tool.result rows carry event.toolCallId (links to the call) +
 *     event.result.output (string) + event.result.isError (bool). They are
 *     linked back to their call step and stored as an observation.
 *   - content.part rows carry a stepUuid that groups them with the tool.call
 *     in the same step. part.type="think" → reasoning_content; "text" → message.
 *   - Kimi's subagent tool is named "Agent" (same as Claude) with description/
 *     subagent_type/prompt args — already canonical; no alias needed.
 */
export function normalizeKimi(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  // Usage scope is split: kimi may emit per-`turn` rows and/or a `session`
  // total. Counting both double-counts, so we collect each scope separately and
  // pick exactly one downstream (per-turn preferred; session total only when no
  // per-turn rows exist).
  const turnUsage: KimiUsageRow[] = [];
  const sessionUsage: KimiUsageRow[] = [];

  // Index: toolCallId → step (for linking tool.result observations)
  const callIndex = new Map<string, AtifStep>();

  // Steps keyed by stepUuid for content.part attachment
  const stepByStepUuid = new Map<string, AtifStep>();

  // Deferred: content.parts whose step hasn't been created yet (part arrives
  // before tool.call in the same step). Stored by stepUuid.
  const pendingThink = new Map<string, string[]>();
  const pendingText = new Map<string, string[]>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: KimiEntry;
    try {
      entry = JSON.parse(line) as KimiEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    const usage = parseKimiUsage(entry);
    if (usage) {
      (usage.scope === 'session' ? sessionUsage : turnUsage).push(usage);
      continue;
    }

    if (entry['type'] !== 'context.append_loop_event') continue;

    const event = entry['event'];
    if (!event || typeof event !== 'object') continue;
    const eventType = event['type'];

    // ---- content.part: collect think/text keyed by stepUuid ----
    if (eventType === 'content.part') {
      const stepUuid =
        typeof event['stepUuid'] === 'string' ? event['stepUuid'] : null;
      if (!stepUuid) continue;
      const part = event['part'];
      if (!part || typeof part !== 'object') continue;
      const partType = part['type'];

      if (
        partType === 'think' &&
        typeof part['think'] === 'string' &&
        part['think']
      ) {
        const existing = stepByStepUuid.get(stepUuid);
        if (existing) {
          // Step already created — attach directly
          existing.reasoning_content = existing.reasoning_content
            ? `${existing.reasoning_content}\n\n${part['think']}`
            : part['think'];
        } else {
          const arr = pendingThink.get(stepUuid) ?? [];
          arr.push(part['think']);
          pendingThink.set(stepUuid, arr);
        }
      } else if (
        partType === 'text' &&
        typeof part['text'] === 'string' &&
        part['text']
      ) {
        const existing = stepByStepUuid.get(stepUuid);
        if (existing) {
          existing.message = existing.message
            ? `${existing.message}\n\n${part['text']}`
            : part['text'];
        } else {
          const arr = pendingText.get(stepUuid) ?? [];
          arr.push(part['text']);
          pendingText.set(stepUuid, arr);
        }
      }
      continue;
    }

    // ---- tool.result: link to call step as observation ----
    if (eventType === 'tool.result') {
      const callId =
        typeof event['toolCallId'] === 'string' ? event['toolCallId'] : null;
      if (!callId) continue;
      const callStep = callIndex.get(callId);
      if (!callStep) continue; // orphan — no matching call

      const result = event['result'];
      const output =
        result && typeof result === 'object' ? result['output'] : undefined;
      const isError =
        result && typeof result === 'object' ? result['isError'] : undefined;

      const obsResult: AtifObservationResult = { source_call_id: callId };
      if (typeof output === 'string') obsResult.content = output;
      if (isError === true) obsResult.extra = { is_error: true };

      callStep.observation ??= { results: [] };
      callStep.observation.results.push(obsResult);
      continue;
    }

    // ---- tool.call: emit a step ----
    if (eventType !== 'tool.call') continue;

    const name = event['name'];
    if (typeof name !== 'string' || !name) continue;

    const rawArgs = event['args'];
    const args: Record<string, unknown> =
      typeof rawArgs === 'object' && rawArgs !== null
        ? { ...(rawArgs as Record<string, unknown>) }
        : { raw_args: rawArgs };

    if (name === 'Skill') {
      const skill = args['skill'];
      if (typeof skill === 'string' && skill && !skill.includes(':')) {
        args['skill'] = `superpowers:${skill}`;
      }
    }

    const callId =
      typeof event['toolCallId'] === 'string'
        ? event['toolCallId']
        : `${stepId}`;
    const tc: AtifToolCall = {
      tool_call_id: callId,
      function_name: name,
      arguments: args,
    };

    const step: AtifStep = {
      step_id: stepId++,
      source: 'agent',
      tool_calls: [tc],
    };
    callIndex.set(callId, step);

    // Attach any pending content.parts for this step's stepUuid
    const stepUuid =
      typeof event['stepUuid'] === 'string' ? event['stepUuid'] : null;
    if (stepUuid) {
      stepByStepUuid.set(stepUuid, step);
      const thinkParts = pendingThink.get(stepUuid);
      if (thinkParts?.length) {
        step.reasoning_content = thinkParts.join('\n\n');
        pendingThink.delete(stepUuid);
      }
      const textParts = pendingText.get(stepUuid);
      if (textParts?.length) {
        step.message = textParts.join('\n\n');
        pendingText.delete(stepUuid);
      }
    }

    steps.push(step);
  }

  // Any content.parts whose stepUuid never matched a tool.call (e.g. final
  // text-only answer step) get their own agent step.
  for (const [stepUuid, textParts] of pendingText) {
    if (!textParts.length) continue;
    const step: AtifStep = {
      step_id: stepId++,
      source: 'agent',
      message: textParts.join('\n\n'),
    };
    const thinkParts = pendingThink.get(stepUuid);
    if (thinkParts?.length) {
      step.reasoning_content = thinkParts.join('\n\n');
      pendingThink.delete(stepUuid);
    }
    steps.push(step);
  }
  // Any remaining think-only stepUuids (no text, no tool.call) — attach to a
  // new step so reasoning is not silently dropped.
  for (const [, thinkParts] of pendingThink) {
    if (!thinkParts.length) continue;
    steps.push({
      step_id: stepId++,
      source: 'agent',
      reasoning_content: thinkParts.join('\n\n'),
    });
  }

  // Per-turn usage wins: emit one agent step per turn-scope row carrying its
  // metrics. metrics/model_name are ATIF agent-only fields, so usage always
  // rides an `agent` step. Cache-creation goes to extra.cache_write per the
  // contract; cost is omitted (kimi-for-coding is priced downstream).
  for (const usage of turnUsage) {
    const metrics: AtifMetrics = {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      cached_tokens: usage.cachedTokens,
    };
    const step: AtifStep = {
      step_id: stepId++,
      source: 'agent',
      metrics,
    };
    if (usage.model !== undefined) {
      step.model_name = usage.model;
    }
    if (usage.cacheWrite > 0) {
      step.extra = { cache_write: usage.cacheWrite };
    }
    steps.push(step);
  }

  // Session-total-only logs (no per-turn rows) fold into final_metrics so the
  // total is still captured without double-counting.
  let finalMetrics: AtifTrajectory['final_metrics'];
  let agentModel: string | undefined;
  if (turnUsage.length === 0 && sessionUsage.length > 0) {
    let totalPrompt = 0;
    let totalCompletion = 0;
    for (const usage of sessionUsage) {
      totalPrompt += usage.promptTokens;
      totalCompletion += usage.completionTokens;
      agentModel = usage.model ?? agentModel;
    }
    finalMetrics = {
      total_prompt_tokens: totalPrompt,
      total_completion_tokens: totalCompletion,
    };
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: agentModel
      ? { name: 'kimi', version, model_name: agentModel }
      : { name: 'kimi', version },
    steps,
    ...(finalMetrics ? { final_metrics: finalMetrics } : {}),
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeKimi produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The injection origin of a kimi row: a top-level `origin`, else the message's
// `origin`.
function kimiInjectionOrigin(row: Record<string, unknown>): unknown {
  const origin = row['origin'];
  if (origin !== undefined && origin !== null) {
    return origin;
  }
  const message = row['message'];
  return isRecord(message) ? message['origin'] : null;
}

// Flatten a kimi message's content (string, or an array of strings / {text}
// parts) into one string.
function kimiMessageText(row: Record<string, unknown>): string {
  const message = row['message'];
  if (!isRecord(message)) {
    return '';
  }
  const content = message['content'];
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (isRecord(part) && typeof part['text'] === 'string') {
      parts.push(part['text']);
    }
  }
  return parts.join('\n');
}

/**
 * Whether any kimi wire log proves the Superpowers `plugin_session_start`
 * injection fired. Accepts either a direct `event.type == plugin_session_start`
 * row carrying plugin=superpowers + skill=using-superpowers, OR an
 * injection-origin variant
 * whose message text contains `<plugin_session_start` + superpowers +
 * using-superpowers. Unreadable files and blank/non-JSON/non-object lines are
 * skipped without throwing. This is the core proof Superpowers loaded for a kimi
 * run; its absence flags the capture as indeterminate.
 */
export function kimiLogsHaveSuperpowersSessionStart(
  paths: readonly string[],
): boolean {
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(row)) {
        continue;
      }
      const event = row['event'];
      if (
        isRecord(event) &&
        event['type'] === 'plugin_session_start' &&
        event['plugin'] === 'superpowers' &&
        event['skill'] === 'using-superpowers'
      ) {
        return true;
      }
      const origin = kimiInjectionOrigin(row);
      if (
        !(
          isRecord(origin) &&
          origin['kind'] === 'injection' &&
          origin['variant'] === 'plugin_session_start'
        )
      ) {
        continue;
      }
      const messageText = kimiMessageText(row);
      const lower = messageText.toLowerCase();
      if (
        messageText.includes('<plugin_session_start') &&
        lower.includes('superpowers') &&
        lower.includes('using-superpowers')
      ) {
        return true;
      }
    }
  }
  return false;
}
