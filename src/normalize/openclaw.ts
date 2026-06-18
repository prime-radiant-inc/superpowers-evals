// Ported from Harbor's src/harbor/agents/installed/openclaw.py
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

// Reverse mapping: OpenClaw native tool names → canonical names.
// Unknown names pass through unchanged.
const OPENCLAW_TOOL_MAP: Record<string, string> = {
  exec: 'Bash',
  bash: 'Bash',
  run: 'Bash',
  shell: 'Bash',
  read_file: 'Read',
  read: 'Read',
  write_file: 'Write',
  write: 'Write',
  edit_file: 'Edit',
  edit: 'Edit',
  grep: 'Grep',
  search: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  agent: 'Agent',
  spawn_agent: 'Agent',
  todo_write: 'TodoWrite',
  todo: 'TodoWrite',
};

function canonicalName(native: string): string {
  return OPENCLAW_TOOL_MAP[native] ?? native;
}

// ---------------------------------------------------------------------------
// JSONL layout helpers — openclaw.session.jsonl
// ---------------------------------------------------------------------------

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (
      typeof p === 'object' &&
      p !== null &&
      !Array.isArray(p) &&
      (p as Record<string, unknown>)['type'] === 'text'
    ) {
      const t = (p as Record<string, unknown>)['text'];
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('');
}

function assistantParts(content: unknown): {
  text: string;
  toolCalls: AtifToolCall[];
} {
  if (!Array.isArray(content)) return { text: '', toolCalls: [] };
  const texts: string[] = [];
  const toolCalls: AtifToolCall[] = [];
  for (const p of content) {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) continue;
    const part = p as Record<string, unknown>;
    const ptype = part['type'];
    if (ptype === 'text' && typeof part['text'] === 'string') {
      texts.push(part['text']);
    } else if (ptype === 'toolCall' && typeof part['name'] === 'string') {
      const rawArgs = part['arguments'];
      let args: Record<string, unknown>;
      if (typeof rawArgs === 'string') {
        try {
          args = rawArgs.trim()
            ? (JSON.parse(rawArgs) as Record<string, unknown>)
            : {};
        } catch {
          args = { raw: rawArgs };
        }
      } else if (
        typeof rawArgs === 'object' &&
        rawArgs !== null &&
        !Array.isArray(rawArgs)
      ) {
        args = rawArgs as Record<string, unknown>;
      } else {
        args = {};
      }
      const cid = part['id'];
      const tc: AtifToolCall = {
        tool_call_id:
          cid !== null && cid !== undefined ? String(cid) : '',
        function_name: canonicalName(part['name'] as string),
        arguments: args,
      };
      toolCalls.push(canonicalizeAgentPrompt(tc));
    }
  }
  return { text: texts.join(''), toolCalls };
}

/**
 * Map JSONL per-message usage to ATIF disjoint buckets.
 *
 * Harbor's _usage_metrics emits prompt_tokens = input + cacheRead (INCLUSIVE).
 * We emit prompt_tokens = input (EXCLUSIVE / uncached only), cached_tokens = cacheRead.
 * The openclaw session log's `input` field is already exclusive of cache reads.
 */
function usageMetricsFromJsonl(usage: unknown): AtifMetrics | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const inp = Number(u['input'] ?? 0);
  const out = Number(u['output'] ?? 0);
  const cr = Number(u['cacheRead'] ?? 0);
  const cw = Number(u['cacheWrite'] ?? 0);
  if (!inp && !out && !cr) return undefined;
  const m: AtifMetrics = {};
  if (inp) m.prompt_tokens = inp;
  if (out) m.completion_tokens = out;
  if (cr) m.cached_tokens = cr;
  if (cw) m.extra = { cache_write: cw };
  return m;
}

interface JsonlRow {
  rec: Record<string, unknown>;
  msg: Record<string, unknown>;
}

/**
 * Parse openclaw.session.jsonl content into ATIF steps.
 * Returns undefined when there are no usable rows or fewer than 2 steps
 * (mirrors Harbor's None-return guard in openclaw_session_jsonl_to_atif_steps).
 */
function parseJsonlSteps(
  raw: string,
  instruction: string,
  modelName: string,
): AtifStep[] | undefined {
  const rows: JsonlRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec['type'] !== 'message') continue;
    const inner = rec['message'];
    if (
      typeof inner !== 'object' ||
      inner === null ||
      Array.isArray(inner)
    )
      continue;
    const msg = inner as Record<string, unknown>;
    const role = msg['role'];
    if (role === 'user' || role === 'assistant' || role === 'toolResult') {
      rows.push({ rec, msg });
    }
  }

  if (rows.length === 0) return undefined;

  const steps: AtifStep[] = [];
  let sid = 0;
  let firstUser = true;
  let i = 0;

  while (i < rows.length) {
    const row = rows[i];
    if (!row) break;
    const { rec, msg } = row;
    const ts =
      typeof rec['timestamp'] === 'string' ? rec['timestamp'] : undefined;
    const role = msg['role'];

    if (role === 'user') {
      const body = textFromContent(msg['content']);
      const userMsg =
        firstUser && instruction.trim() ? instruction.trim() : body;
      firstUser = false;
      sid += 1;
      const step: AtifStep = {
        step_id: sid,
        source: 'user',
        message: userMsg || '(empty user message)',
      };
      if (ts !== undefined) step.timestamp = ts;
      steps.push(step);
      i += 1;
      continue;
    }

    if (role === 'assistant') {
      const { text, toolCalls } = assistantParts(msg['content']);
      const err = msg['errorMessage'];
      let agentMsg: string;
      if (text.trim()) {
        agentMsg = text.trim();
      } else if (typeof err === 'string' && err.trim()) {
        agentMsg = `(error) ${err.trim()}`;
      } else {
        agentMsg = '(no assistant text)';
      }

      // Collect pending tool call ids to match toolResult rows
      const pending = new Set<string>();
      for (const tc of toolCalls) {
        if (tc.tool_call_id) pending.add(tc.tool_call_id);
      }

      // Gather immediately following toolResult rows
      const obsResults: AtifObservationResult[] = [];
      let j = i + 1;
      while (j < rows.length) {
        const nextRow = rows[j];
        if (!nextRow) break;
        if (nextRow.msg['role'] !== 'toolResult') break;
        const tr = nextRow.msg;
        const cid = String(tr['toolCallId'] ?? '');
        if (cid && !pending.has(cid)) break;

        // Extract body: prefer details.aggregated, then content
        let bodyT = '';
        const details = tr['details'];
        if (
          typeof details === 'object' &&
          details !== null &&
          !Array.isArray(details)
        ) {
          const agg = (details as Record<string, unknown>)['aggregated'];
          if (typeof agg === 'string' && agg.trim()) bodyT = agg;
        }
        if (!bodyT) bodyT = textFromContent(tr['content']);

        const obsResult: AtifObservationResult = {};
        if (cid) obsResult.source_call_id = cid;
        if (bodyT) obsResult.content = bodyT;
        obsResults.push(obsResult);

        if (cid) pending.delete(cid);
        j += 1;
        if (pending.size === 0) break;
      }

      sid += 1;
      const step: AtifStep = {
        step_id: sid,
        source: 'agent',
        message: agentMsg,
      };
      if (ts !== undefined) step.timestamp = ts;
      if (modelName) step.model_name = modelName;
      if (toolCalls.length > 0) step.tool_calls = toolCalls;
      if (obsResults.length > 0) step.observation = { results: obsResults };
      const m = usageMetricsFromJsonl(msg['usage']);
      if (m) step.metrics = m;

      steps.push(step);
      i = j;
      continue;
    }

    // Skip toolResult rows not consumed by the assistant loop above
    i += 1;
  }

  if (steps.length < 2) return undefined;
  return steps;
}

// ---------------------------------------------------------------------------
// Envelope layout helpers — openclaw.txt
// The file may contain prefix noise (log output). The envelope is the last
// top-level JSON object that consumes the remainder of the string.
// ---------------------------------------------------------------------------

/**
 * Find the last `{` in `text` such that the substring from there to the end
 * of `text` is a complete, valid JSON object. Returns the parsed object or
 * undefined. Mirrors Harbor's _openclaw_decode_last_json_dict_suffix.
 */
function decodeLastJsonDictSuffix(
  text: string,
): Record<string, unknown> | undefined {
  for (let start = text.length - 1; start >= 0; start--) {
    if (text[start] !== '{') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(text.slice(start));
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      continue;
    }
    return obj as Record<string, unknown>;
  }
  return undefined;
}

function loadJsonObject(
  raw: string,
): Record<string, unknown> | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  // Try direct parse first (clean JSON with no prefix noise)
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to suffix scan
  }
  return decodeLastJsonDictSuffix(text);
}

/**
 * Map envelope usage to ATIF disjoint buckets.
 * Same convention as JSONL: input is uncached-only, cacheRead → cached_tokens.
 */
function usageMetricsFromEnvelope(
  usage: Record<string, unknown>,
): AtifMetrics | undefined {
  const inp = Number(usage['input'] ?? 0);
  const out = Number(usage['output'] ?? 0);
  const cr = Number(usage['cacheRead'] ?? 0);
  const cw = Number(usage['cacheWrite'] ?? 0);
  if (!inp && !out && !cr) return undefined;
  const m: AtifMetrics = {};
  if (inp) m.prompt_tokens = inp;
  if (out) m.completion_tokens = out;
  if (cr) m.cached_tokens = cr;
  if (cw) m.extra = { cache_write: cw };
  return m;
}

/**
 * Parse an OpenClaw CLI envelope (openclaw.txt) into a minimal 2-step
 * trajectory: one user step (instruction) + one agent step.
 *
 * Uses per-step metrics only (no final_metrics) to satisfy the single-source rule.
 */
function parseEnvelope(
  envelope: Record<string, unknown>,
  instruction: string,
  modelName: string,
  version: string,
): AtifTrajectory {
  const rawMeta = envelope['meta'];
  const meta =
    typeof rawMeta === 'object' &&
    rawMeta !== null &&
    !Array.isArray(rawMeta)
      ? (rawMeta as Record<string, unknown>)
      : {};

  const rawAgentMeta = meta['agentMeta'];
  const agentMeta =
    typeof rawAgentMeta === 'object' &&
    rawAgentMeta !== null &&
    !Array.isArray(rawAgentMeta)
      ? (rawAgentMeta as Record<string, unknown>)
      : {};

  const sessionId =
    typeof agentMeta['sessionId'] === 'string' && agentMeta['sessionId']
      ? agentMeta['sessionId']
      : undefined;

  // Extract payloads: split text and reasoning
  const payloads = Array.isArray(envelope['payloads'])
    ? envelope['payloads']
    : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  for (const item of payloads) {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      continue;
    const p = item as Record<string, unknown>;
    const t = p['text'];
    if (typeof t !== 'string' || !t.trim()) continue;
    if (p['isReasoning'] === true) {
      reasoningParts.push(t.trim());
    } else {
      textParts.push(t.trim());
    }
  }

  let assistantText = textParts.join('\n\n');
  if (
    !assistantText &&
    typeof meta['finalAssistantVisibleText'] === 'string'
  ) {
    assistantText = (meta['finalAssistantVisibleText'] as string).trim();
  }

  // Pending tool calls from meta
  const toolCalls: AtifToolCall[] = [];
  const pendingRaw = meta['pendingToolCalls'];
  if (Array.isArray(pendingRaw)) {
    for (const c of pendingRaw) {
      if (typeof c !== 'object' || c === null || Array.isArray(c)) continue;
      const call = c as Record<string, unknown>;
      const name = call['name'];
      if (typeof name !== 'string') continue;
      const rawArgs = call['arguments'];
      let args: Record<string, unknown>;
      if (typeof rawArgs === 'string') {
        try {
          args = rawArgs.trim()
            ? (JSON.parse(rawArgs) as Record<string, unknown>)
            : {};
        } catch {
          args = { raw: rawArgs };
        }
      } else if (
        typeof rawArgs === 'object' &&
        rawArgs !== null &&
        !Array.isArray(rawArgs)
      ) {
        args = rawArgs as Record<string, unknown>;
      } else {
        args = {};
      }
      const cid = call['id'];
      const tc: AtifToolCall = {
        tool_call_id:
          cid !== null && cid !== undefined ? String(cid) : '',
        function_name: canonicalName(name),
        arguments: args,
      };
      toolCalls.push(canonicalizeAgentPrompt(tc));
    }
  }

  // Per-step usage only (no final_metrics — single-source rule)
  const rawUsage = agentMeta['usage'];
  const usageRaw =
    typeof rawUsage === 'object' &&
    rawUsage !== null &&
    !Array.isArray(rawUsage)
      ? (rawUsage as Record<string, unknown>)
      : null;
  const stepMetrics = usageRaw
    ? usageMetricsFromEnvelope(usageRaw)
    : undefined;

  const userStep: AtifStep = {
    step_id: 1,
    source: 'user',
    message: instruction,
  };

  const agentStep: AtifStep = {
    step_id: 2,
    source: 'agent',
    message: assistantText || '(no assistant text in JSON output)',
  };
  if (modelName) agentStep.model_name = modelName;
  if (reasoningParts.length > 0) {
    agentStep.reasoning_content = reasoningParts.join('\n\n');
  }
  if (toolCalls.length > 0) agentStep.tool_calls = toolCalls;
  if (stepMetrics) agentStep.metrics = stepMetrics;

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'openclaw', version },
    steps: [userStep, agentStep],
  };
  if (sessionId) traj.session_id = sessionId;
  if (modelName) traj.agent.model_name = modelName;
  return traj;
}

// ---------------------------------------------------------------------------
// Public normalizer — dual-mode entry point
// ---------------------------------------------------------------------------

/**
 * Normalize an OpenClaw session log to ATIF v1.7.
 *
 * Layout detection: if any non-empty line parses as JSON with
 * `type === "message"`, the input is JSONL (openclaw.session.jsonl).
 * Otherwise it is treated as the CLI envelope (openclaw.txt), which may
 * have prefix log noise before the trailing JSON object.
 *
 * Token buckets are disjoint in both modes:
 *   prompt_tokens  = uncached input (exclusive of cache reads)
 *   cached_tokens  = cacheRead
 *   extra.cache_write = cacheWrite (when > 0)
 *   completion_tokens = output
 *
 * Usage lives in per-step metrics only (no final_metrics). The openclaw log
 * carries per-message usage in JSONL mode and a single session total in the
 * envelope. In envelope mode that total is placed on the single agent step's
 * metrics, not in final_metrics, to satisfy the single-source rule.
 */
export function normalizeOpenclaw(raw: string, version: string): AtifTrajectory {
  // Detect JSONL layout: look for any "type: message" record
  const isJsonl = raw.split('\n').some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      return false;
    }
    return (
      typeof rec === 'object' &&
      rec !== null &&
      !Array.isArray(rec) &&
      (rec as Record<string, unknown>)['type'] === 'message'
    );
  });

  if (isJsonl) {
    const steps = parseJsonlSteps(raw, '', '');
    if (steps) {
      const traj: AtifTrajectory = {
        schema_version: ATIF_SCHEMA_VERSION,
        agent: { name: 'openclaw', version },
        steps,
      };
      const result = validateTrajectory(traj);
      if (!result.ok) {
        throw new Error(
          `normalizeOpenclaw (jsonl) produced invalid ATIF: ${result.errors.join('; ')}`,
        );
      }
      return traj;
    }
    // Fall through to envelope if JSONL produced nothing usable
  }

  // Envelope mode
  const envelope = loadJsonObject(raw);
  if (!envelope) {
    // Minimal valid trajectory for unparse-able input
    return {
      schema_version: ATIF_SCHEMA_VERSION,
      agent: { name: 'openclaw', version },
      steps: [
        {
          step_id: 1,
          source: 'user',
          message: '(unparseable openclaw log)',
        },
      ],
    };
  }

  const traj = parseEnvelope(envelope, '', '', version);
  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeOpenclaw (envelope) produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }
  return traj;
}

/**
 * Normalize OpenClaw logs using both the JSONL session log and the CLI
 * envelope, with an explicit instruction and model name.
 *
 * Prefers the JSONL for multi-turn step fidelity; falls back to the envelope
 * when the JSONL is absent or has fewer than 2 usable steps.
 * The session_id is always read from the envelope's agentMeta.sessionId.
 */
export function normalizeOpenclawJsonl(
  jsonlRaw: string,
  envelopeRaw: string,
  instruction: string,
  modelName: string,
  version: string,
): AtifTrajectory {
  const envelope = loadJsonObject(envelopeRaw);
  let sessionId: string | undefined;
  if (envelope) {
    const rawMeta = envelope['meta'];
    const meta =
      typeof rawMeta === 'object' &&
      rawMeta !== null &&
      !Array.isArray(rawMeta)
        ? (rawMeta as Record<string, unknown>)
        : {};
    const rawAgentMeta = meta['agentMeta'];
    const agentMeta =
      typeof rawAgentMeta === 'object' &&
      rawAgentMeta !== null &&
      !Array.isArray(rawAgentMeta)
        ? (rawAgentMeta as Record<string, unknown>)
        : {};
    if (
      typeof agentMeta['sessionId'] === 'string' &&
      agentMeta['sessionId']
    ) {
      sessionId = agentMeta['sessionId'];
    }
  }

  const steps = parseJsonlSteps(jsonlRaw, instruction, modelName);
  if (steps) {
    const traj: AtifTrajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      agent: {
        name: 'openclaw',
        version,
        ...(modelName ? { model_name: modelName } : {}),
      },
      steps,
    };
    if (sessionId) traj.session_id = sessionId;
    const result = validateTrajectory(traj);
    if (!result.ok) {
      throw new Error(
        `normalizeOpenclawJsonl produced invalid ATIF: ${result.errors.join('; ')}`,
      );
    }
    return traj;
  }

  // Fallback to envelope
  if (!envelope) {
    const fallback: AtifTrajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      agent: { name: 'openclaw', version },
      steps: [
        {
          step_id: 1,
          source: 'user',
          message: instruction || '(unparseable openclaw log)',
        },
      ],
    };
    if (sessionId) fallback.session_id = sessionId;
    return fallback;
  }

  const traj = parseEnvelope(envelope, instruction, modelName, version);
  if (sessionId) traj.session_id = sessionId;
  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeOpenclawJsonl (envelope fallback) produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }
  return traj;
}
