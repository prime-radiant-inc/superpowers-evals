// Ported from Harbor's src/harbor/agents/installed/cline/trajectory.py
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

// ---------------------------------------------------------------------------
// Native Cline tool name → canonical name.
// Sources: Harbor trajectory.py fixture test + Cline VS Code extension tool
// documentation. Unknown names pass through unchanged.
// ---------------------------------------------------------------------------
const CLINE_TOOL_MAP: Record<string, string> = {
  execute_command: 'Bash',
  run_commands: 'Bash',
  read_file: 'Read',
  write_to_file: 'Write',
  replace_in_file: 'Edit',
  apply_diff: 'Edit',
  search_files: 'Grep',
  list_files: 'Glob',
  list_directory: 'Glob',
  browser_action: 'WebFetch',
  web_search: 'WebSearch',
  new_task: 'Agent',
  spawn_agent: 'Agent',
};

// ---------------------------------------------------------------------------
// Native log types
// ---------------------------------------------------------------------------

interface ClineMessage {
  role?: string;
  content?: unknown;
  ts?: unknown;
  modelInfo?: { id?: string } | null;
  metrics?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cost?: number;
  } | null;
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  mediaType?: string;
  media_type?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert unix-milliseconds timestamp to ISO string, or undefined. */
function isoFromMs(ts: unknown): string | undefined {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined;
  return new Date(ts).toISOString();
}

/** Stringify a non-string value for embedding in text content. */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Split a message's content (string or block array) into its constituent parts.
 * Returns {textParts, toolUses, toolResults, reasoning}.
 */
function splitBlocks(content: unknown): {
  textParts: string[];
  toolUses: ContentBlock[];
  toolResults: ContentBlock[];
  reasoning: string;
} {
  const textParts: string[] = [];
  const toolUses: ContentBlock[] = [];
  const toolResults: ContentBlock[] = [];
  const reasoningParts: string[] = [];

  if (typeof content === 'string') {
    if (content) textParts.push(content);
    return { textParts, toolUses, toolResults, reasoning: '' };
  }

  if (!Array.isArray(content)) {
    return { textParts, toolUses, toolResults, reasoning: '' };
  }

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as ContentBlock;
    const btype = block.type;

    if (btype === 'text') {
      const t = block.text;
      if (typeof t === 'string' && t) textParts.push(t);
    } else if (btype === 'thinking') {
      // Harbor reads `text` key preferentially, then `thinking`
      const t = block.text !== undefined ? block.text : block.thinking;
      if (typeof t === 'string' && t) reasoningParts.push(t);
    } else if (btype === 'tool_use') {
      toolUses.push(block);
    } else if (btype === 'tool_result') {
      toolResults.push(block);
    } else if (btype === 'image') {
      const mediaType = block.mediaType ?? block.media_type ?? 'image';
      textParts.push(`[image: ${mediaType}]`);
    }
  }

  const reasoning = reasoningParts
    .map((p) => p.trim())
    .filter((p) => p)
    .join('\n')
    .trim();
  return { textParts, toolUses, toolResults, reasoning };
}

/** Join text parts: newline-separated, stripped. Empty parts dropped. */
function joinText(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p)
    .join('\n');
}

/** Normalize a tool_result content value to a string or undefined. */
function normalizeToolResultContent(content: unknown): string | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content === 'string') return content;
  return stringify(content);
}

/**
 * Build AtifMetrics from a Cline assistant message metrics object.
 *
 * Token bucket mapping (OUR disjoint convention):
 *   - inputTokens   → metrics.prompt_tokens   (EXCLUSIVE of cache — already disjoint)
 *   - outputTokens  → metrics.completion_tokens
 *   - cacheReadTokens → metrics.cached_tokens
 *   - cacheWriteTokens → step.extra.cache_write (> 0 only; returned separately)
 *   - cost → metrics.cost_usd (passthrough — log records a per-message cost)
 *
 * Harbor's Python passes inputTokens straight through without subtracting cache,
 * because Cline uses the Anthropic API where inputTokens is ALREADY EXCLUSIVE
 * of cache reads (same as the Claude normalizer — no subtraction needed).
 */
function buildMetrics(raw: ClineMessage['metrics']): {
  metrics: AtifMetrics | undefined;
  cacheWrite: number | undefined;
} {
  if (!raw) return { metrics: undefined, cacheWrite: undefined };

  const input = raw.inputTokens;
  const output = raw.outputTokens;
  const cacheRead = raw.cacheReadTokens;
  const cacheWrite = raw.cacheWriteTokens;
  const cost = raw.cost;

  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    cost === undefined
  ) {
    return { metrics: undefined, cacheWrite: undefined };
  }

  const metrics: AtifMetrics = {};
  if (typeof input === 'number') metrics.prompt_tokens = input;
  if (typeof output === 'number') metrics.completion_tokens = output;
  if (typeof cacheRead === 'number') metrics.cached_tokens = cacheRead;
  if (typeof cost === 'number' && Number.isFinite(cost))
    metrics.cost_usd = cost;

  const cw =
    typeof cacheWrite === 'number' && cacheWrite > 0 ? cacheWrite : undefined;

  return { metrics, cacheWrite: cw };
}

/**
 * Attach tool_results from a user message to their owning agent steps.
 * Returns the unmatched (orphan) results.
 *
 * ATIF requires observation.results[].source_call_id to match a tool_call_id
 * on the SAME step, so we search backwards through emitted steps.
 */
function attachToolResults(
  steps: AtifStep[],
  toolResults: ContentBlock[],
): ContentBlock[] {
  const orphans: ContentBlock[] = [];

  for (const result of toolResults) {
    const toolUseId = result.tool_use_id;
    let target: AtifStep | undefined;

    if (typeof toolUseId === 'string' && toolUseId) {
      // Search backwards for the agent step that issued this tool call
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if (step?.source !== 'agent' || !step.tool_calls) continue;
        if (step.tool_calls.some((tc) => tc.tool_call_id === toolUseId)) {
          target = step;
          break;
        }
      }
    }

    if (!target) {
      orphans.push(result);
      continue;
    }

    const obsResult: AtifObservationResult = {};
    if (typeof toolUseId === 'string') obsResult.source_call_id = toolUseId;
    const content = normalizeToolResultContent(result.content);
    if (content !== undefined) obsResult.content = content;

    target.observation ??= { results: [] };
    target.observation.results.push(obsResult);
  }

  return orphans;
}

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

/**
 * Convert a Cline `<sessionId>.messages.json` document into an ATIF v1.7
 * trajectory.
 *
 * Log format: a JSON object with `sessionId` (string) and `messages[]` (array).
 * Each message has `role` ("user"|"assistant"), `content` (string or block
 * array), optional `ts` (unix millis), `modelInfo` (assistant only), and
 * `metrics` (assistant only).
 *
 * No message-id dedup is needed: Cline's messages.json is a persisted final
 * history — it does not re-emit rows by id (unlike claude-code's streaming
 * JSONL). Each message is processed exactly once.
 *
 * Full-fidelity: session_id, model_name, message text, reasoning_content
 * (thinking blocks), observation (tool_results linked to tool_use by id),
 * per-step metrics (prompt/cached/completion/cost_usd, cache_write in extra).
 */
export function normalizeCline(raw: string, version: string): AtifTrajectory {
  // Parse the messages.json document
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    doc = parsed as Record<string, unknown>;
  } catch {
    // Unparseable input: return minimal valid trajectory
    const traj: AtifTrajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      agent: { name: 'cline', version },
      steps: [{ step_id: 1, source: 'user', message: '' }],
    };
    return traj;
  }

  const sessionId =
    typeof doc['sessionId'] === 'string' && doc['sessionId']
      ? doc['sessionId']
      : undefined;

  const rawMessages = doc['messages'];
  const messages = Array.isArray(rawMessages)
    ? (rawMessages as ClineMessage[])
    : [];

  // Find the default model from the first assistant message with modelInfo
  let defaultModel: string | undefined;
  for (const msg of messages) {
    if (msg?.role === 'assistant') {
      const mi = msg.modelInfo;
      if (mi && typeof mi === 'object' && typeof mi.id === 'string' && mi.id) {
        defaultModel = mi.id;
        break;
      }
    }
  }

  const steps: AtifStep[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    const role = msg.role;
    const content = msg.content;
    const tsIso = isoFromMs(msg.ts);
    const { textParts, toolUses, toolResults, reasoning } =
      splitBlocks(content);

    if (role === 'user') {
      // Attach any tool_results to their owning agent steps
      const orphans = attachToolResults(steps, toolResults);

      // Orphan tool_results (no matching tool_use) are folded into the text
      let orphanText: string | undefined;
      if (orphans.length > 0) {
        orphanText = JSON.stringify(
          orphans.map((o) => ({
            tool_use_id: o.tool_use_id,
            content: o.content,
          })),
        );
        textParts.push(orphanText);
      }

      const messageText = joinText(textParts);
      if (!messageText) continue; // skip tool_result-only user messages

      const step: AtifStep = {
        step_id: steps.length + 1,
        source: 'user',
        message: messageText,
      };
      if (tsIso) step.timestamp = tsIso;
      steps.push(step);
    } else if (role === 'assistant') {
      const { metrics, cacheWrite } = buildMetrics(msg.metrics ?? null);

      // Resolve model: from this message's modelInfo, or the session default
      const mi = msg.modelInfo;
      const modelName =
        mi && typeof mi === 'object' && typeof mi.id === 'string' && mi.id
          ? mi.id
          : defaultModel;

      // Build tool_calls from tool_use blocks
      let toolCallsList: AtifToolCall[] | undefined;
      if (toolUses.length > 0) {
        toolCallsList = [];
        for (let i = 0; i < toolUses.length; i++) {
          const tu = toolUses[i];
          if (!tu) continue;
          const rawId = tu.id;
          const toolCallId =
            typeof rawId === 'string' && rawId
              ? rawId
              : `tc_${steps.length + 1}_${i}`;
          const nativeName =
            typeof tu.name === 'string' && tu.name ? tu.name : 'unknown';
          const canonicalName = CLINE_TOOL_MAP[nativeName] ?? nativeName;
          const args =
            tu.input && typeof tu.input === 'object' && !Array.isArray(tu.input)
              ? (tu.input as Record<string, unknown>)
              : {};
          const tc: AtifToolCall = canonicalizeAgentPrompt({
            tool_call_id: toolCallId,
            function_name: canonicalName,
            arguments: args,
          });
          toolCallsList.push(tc);
        }
      }

      const step: AtifStep = {
        step_id: steps.length + 1,
        source: 'agent',
      };
      if (tsIso) step.timestamp = tsIso;
      if (modelName) step.model_name = modelName;

      const messageText = joinText(textParts);
      if (messageText) step.message = messageText;
      if (reasoning) step.reasoning_content = reasoning;
      if (toolCallsList) step.tool_calls = toolCallsList;
      if (metrics !== undefined) step.metrics = metrics;
      if (cacheWrite !== undefined) {
        step.extra = { ...step.extra, cache_write: cacheWrite };
      }

      steps.push(step);
    }
  }

  // ATIF requires at least one step
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // Reassign sequential step_ids (1-based, no gaps)
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step) step.step_id = i + 1;
  }

  // SINGLE-SOURCE metrics: Cline's log carries per-message usage, so usage lives
  // on per-step `metrics` ONLY (the claude/gemini/opencode pattern). We do NOT
  // also emit final_metrics token totals — obol prices whatever buckets it finds,
  // and emitting both per-step and final totals double-counts.
  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'cline', version },
    steps,
  };
  if (sessionId) traj.session_id = sessionId;
  if (defaultModel) traj.agent.model_name = defaultModel;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeCline produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
