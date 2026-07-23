// Ported from Harbor's src/harbor/agents/installed/hermes.py
//   repo:   https://github.com/laude-institute/harbor (Apache-2.0)
//   commit: 5352049de712613e58459cad41afcf0bf8645738 (v0.14.0)
// Log-parsing logic is derived from Harbor; token buckets, tool-name
// canonicalization, and message-id dedup follow OUR conventions
// (docs/superpowers/reference/atif-normalizers.md), NOT Harbor's.

import {
  ATIF_SCHEMA_VERSION,
  type AtifFinalMetrics,
  type AtifMetrics,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// Reverse mapping: Hermes native tool names → our canonical names.
// Hermes uses OpenAI-compatible tool names derived from hermes-cli toolsets.
// Unknown names pass through unchanged.
const HERMES_TOOL_MAP: Record<string, string> = {
  // Shell / filesystem
  terminal: 'Bash',
  bash: 'Bash',
  shell: 'Bash',
  exec: 'Bash',
  run_command: 'Bash',
  // File reading
  read_file: 'Read',
  view_file: 'Read',
  // File writing
  write_file: 'Write',
  create_file: 'Write',
  // File editing
  str_replace_based_edit_tool: 'Edit',
  str_replace: 'Edit',
  edit_file: 'Edit',
  replace_in_file: 'Edit',
  // Search
  grep: 'Grep',
  search_files: 'Grep',
  ripgrep: 'Grep',
  glob: 'Glob',
  find_files: 'Glob',
  // Web
  web_fetch: 'WebFetch',
  fetch_url: 'WebFetch',
  web_search: 'WebSearch',
  search_web: 'WebSearch',
  // Subagent dispatch — alias to Agent and canonicalize prompt arg
  spawn_agent: 'Agent',
  invoke_agent: 'Agent',
  delegate: 'Agent',
  // Skill invocation — hermes calls skill_view with {name: "<value>"} for
  // both Superpowers-registered skills (namespaced, e.g.
  // "superpowers:brainstorming") and Hermes' own bundled skills (bare, e.g.
  // "computer-use"). The name is carried into args.skill verbatim below —
  // NOT namespace-prefixed like OpenCode's `skill` tool does for bare names,
  // since a bare hermes name may refer to a bundled skill, not Superpowers.
  skill_view: 'Skill',
};

/** Parse tool arguments: accepts either a JSON string or an already-parsed object. */
function parseArgs(
  raw: string | Record<string, unknown> | unknown,
): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw))
    return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
      return { raw };
    } catch {
      return { raw };
    }
  }
  return {};
}

/**
 * Translate a skill_view call's arguments so `args.skill` carries the raw
 * `name` value verbatim (no namespace prefixing — a bare name may refer to
 * one of Hermes' own bundled skills, not a Superpowers one). No-op for any
 * other native tool name.
 */
function normalizeHermesArgs(
  nativeName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (nativeName !== 'skill_view') return args;
  const name = args['name'];
  if (typeof name !== 'string') return args;
  return { ...args, skill: name };
}

/** Extract text from a content field that may be a string or a list of blocks. */
function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p && typeof p === 'object') {
          const block = p as Record<string, unknown>;
          if (block['type'] === 'text' && typeof block['text'] === 'string')
            return block['text'];
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** A finite number, else undefined (real hermes sessions carry `null` for
 *  unset numeric fields like actual_cost_usd — never coerce that to 0). */
function numOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Fold a hermes session object's top-level token/cost fields into ATIF
 * final_metrics. Field mapping (obol's atif dialect reads these exact
 * final_metrics paths — verified against the obol native lib's embedded
 * string table):
 *   input_tokens                     -> total_prompt_tokens
 *   output_tokens + reasoning_tokens  -> total_completion_tokens (folded,
 *                                        matching normalize/opencode.ts's
 *                                        output+reasoning fold convention)
 *   cache_read_tokens                 -> extra.total_cached_tokens (the
 *                                        literal key obol's atif dialect
 *                                        looks up)
 *   cache_write_tokens                -> extra.cache_write (matches the
 *                                        per-step extra.cache_write key
 *                                        convention used elsewhere)
 *   actual_cost_usd                   -> total_cost_usd, only when it is a
 *                                        real number. estimated_cost_usd is
 *                                        NEVER used: it is an estimate, not a
 *                                        committed charge.
 * Returns undefined when the session carries no input_tokens/output_tokens
 * at all (nothing to fold).
 */
function buildSessionFinalMetrics(
  session: Record<string, unknown>,
): AtifFinalMetrics | undefined {
  const inputTokens = numOrUndefined(session['input_tokens']);
  const outputTokens = numOrUndefined(session['output_tokens']);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  const reasoningTokens = numOrUndefined(session['reasoning_tokens']);
  const cacheReadTokens = numOrUndefined(session['cache_read_tokens']);
  const cacheWriteTokens = numOrUndefined(session['cache_write_tokens']);
  const actualCostUsd = numOrUndefined(session['actual_cost_usd']);

  const finalMetrics: AtifFinalMetrics = {};
  if (inputTokens !== undefined) {
    finalMetrics.total_prompt_tokens = inputTokens;
  }
  if (outputTokens !== undefined || reasoningTokens !== undefined) {
    finalMetrics.total_completion_tokens =
      (outputTokens ?? 0) + (reasoningTokens ?? 0);
  }
  if (actualCostUsd !== undefined) {
    finalMetrics.total_cost_usd = actualCostUsd;
  }
  const extra: Record<string, unknown> = {};
  if (cacheReadTokens !== undefined) {
    extra['total_cached_tokens'] = cacheReadTokens;
  }
  if (cacheWriteTokens !== undefined) {
    extra['cache_write'] = cacheWriteTokens;
  }
  if (Object.keys(extra).length > 0) {
    finalMetrics.extra = extra;
  }
  return finalMetrics;
}

/**
 * Convert a Hermes session log (JSONL or single JSON {messages:[...]}) into
 * an ATIF v1.7 trajectory.
 *
 * Hermes log formats (both handled):
 *   - JSONL: each line is a message object {role, content, [tool_calls], [usage]}
 *   - Single JSON: {id?, messages: [...message objects...]}
 *
 * Tool calls are OpenAI-style:
 *   {id, function: {name, arguments: "<json-string>"}}
 * Tool results follow as role:"tool" messages with tool_call_id.
 *
 * Token usage: `usage.prompt_tokens` / `usage.completion_tokens` on assistant
 * messages. No cache-split fields are present → prompt_tokens is treated as
 * the uncached input (DISJOINT buckets, no cached_tokens emitted). Usage is
 * per-message, so we emit per-step metrics (SINGLE-SOURCE: no final_metrics
 * token totals from per-message usage — Harbor accumulates to final_metrics
 * but our convention is per-step for per-message logs).
 *
 * Session-level totals: a real `hermes sessions export` session object also
 * carries top-level input_tokens/output_tokens/cache_read_tokens/
 * cache_write_tokens/reasoning_tokens/actual_cost_usd fields (verified live —
 * real hermes messages carry no per-message usage at all, token_count is
 * always null). When present, and only when no per-step usage was already
 * extracted (single-source: never double-count), these fold into
 * trajectory-level final_metrics — see the field mapping above
 * buildSessionFinalMetrics.
 */
export function normalizeHermes(raw: string, version: string): AtifTrajectory {
  const messages: Record<string, unknown>[] = [];
  let sessionId: string | undefined;
  let sessionTokenFields: Record<string, unknown> | undefined;

  // Parse: handle both single-object and JSONL formats.
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      // Single-object session export: has a `messages` array
      if (Array.isArray(obj['messages'])) {
        if (typeof obj['id'] === 'string') sessionId = obj['id'];
        sessionTokenFields = obj;
        for (const msg of obj['messages']) {
          if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
            messages.push(msg as Record<string, unknown>);
          }
        }
      } else {
        // JSONL: each line is a message
        messages.push(obj);
      }
    }
  }

  const steps: AtifStep[] = [];
  let stepId = 1;

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (!msg) {
      i++;
      continue;
    }
    const role = typeof msg['role'] === 'string' ? msg['role'] : '';

    if (role === 'user') {
      const text = extractContent(msg['content']);
      if (text) {
        steps.push({ step_id: stepId++, source: 'user', message: text });
      }
      i++;
      continue;
    }

    if (role === 'assistant') {
      const text = extractContent(msg['content']);

      const rawToolCalls = msg['tool_calls'];
      if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
        // Build tool calls
        const toolCalls: AtifToolCall[] = [];
        for (const tc of rawToolCalls) {
          if (!tc || typeof tc !== 'object') continue;
          const tcObj = tc as Record<string, unknown>;
          const tcId =
            typeof tcObj['id'] === 'string' ? tcObj['id'] : String(stepId);
          const func =
            tcObj['function'] &&
            typeof tcObj['function'] === 'object' &&
            !Array.isArray(tcObj['function'])
              ? (tcObj['function'] as Record<string, unknown>)
              : {};
          const nativeName =
            typeof func['name'] === 'string' ? func['name'] : 'unknown';
          const canonicalName = HERMES_TOOL_MAP[nativeName] ?? nativeName;
          const args = normalizeHermesArgs(
            nativeName,
            parseArgs(func['arguments']),
          );
          const atifTc: AtifToolCall = canonicalizeAgentPrompt({
            tool_call_id: tcId,
            function_name: canonicalName,
            arguments: args,
          });
          toolCalls.push(atifTc);
        }

        // Collect subsequent tool response messages
        const obsResults: AtifObservationResult[] = [];
        while (
          i + 1 < messages.length &&
          messages[i + 1] !== undefined &&
          (messages[i + 1] as Record<string, unknown>)['role'] === 'tool'
        ) {
          i++;
          const toolMsg = messages[i] as Record<string, unknown>;
          const toolContent = extractContent(toolMsg['content']);
          const sourceCallId =
            typeof toolMsg['tool_call_id'] === 'string'
              ? toolMsg['tool_call_id']
              : undefined;
          const result: AtifObservationResult = {};
          if (sourceCallId !== undefined) result.source_call_id = sourceCallId;
          if (toolContent) result.content = toolContent;
          obsResults.push(result);
        }

        // Extract usage from this assistant message
        const usage = msg['usage'];
        let metrics: AtifMetrics | undefined;
        if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
          const u = usage as Record<string, unknown>;
          const promptTokens =
            typeof u['prompt_tokens'] === 'number'
              ? u['prompt_tokens']
              : undefined;
          const completionTokens =
            typeof u['completion_tokens'] === 'number'
              ? u['completion_tokens']
              : undefined;
          if (promptTokens !== undefined || completionTokens !== undefined) {
            metrics = {};
            // prompt_tokens → disjoint uncached input (hermes logs carry no
            // cache-split fields, so the full value is the uncached prompt).
            if (promptTokens !== undefined)
              metrics.prompt_tokens = promptTokens;
            if (completionTokens !== undefined)
              metrics.completion_tokens = completionTokens;
          }
        }

        const step: AtifStep = {
          step_id: stepId++,
          source: 'agent',
          tool_calls: toolCalls,
        };
        if (text) step.message = text;
        if (obsResults.length > 0) step.observation = { results: obsResults };
        if (metrics !== undefined) step.metrics = metrics;
        steps.push(step);
      } else if (text) {
        // Text-only assistant message
        const step: AtifStep = {
          step_id: stepId++,
          source: 'agent',
          message: text,
        };

        // Extract usage from this assistant message
        const usage = msg['usage'];
        if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
          const u = usage as Record<string, unknown>;
          const promptTokens =
            typeof u['prompt_tokens'] === 'number'
              ? u['prompt_tokens']
              : undefined;
          const completionTokens =
            typeof u['completion_tokens'] === 'number'
              ? u['completion_tokens']
              : undefined;
          if (promptTokens !== undefined || completionTokens !== undefined) {
            const metrics: AtifMetrics = {};
            if (promptTokens !== undefined)
              metrics.prompt_tokens = promptTokens;
            if (completionTokens !== undefined)
              metrics.completion_tokens = completionTokens;
            step.metrics = metrics;
          }
        }

        steps.push(step);
      }
      i++;
      continue;
    }

    // Skip role:"tool" messages that weren't consumed above (orphan results)
    i++;
  }

  // ATIF requires at least one step
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // Reassign sequential step_ids (1-based, sequential)
  for (let j = 0; j < steps.length; j++) {
    const step = steps[j];
    if (step) step.step_id = j + 1;
  }

  // Session-level totals only fold into final_metrics when no per-step usage
  // was already extracted (single-source: never double-count a total that a
  // per-message usage field already covered).
  const hasPerStepMetrics = steps.some((s) => s.metrics !== undefined);
  const finalMetrics =
    !hasPerStepMetrics && sessionTokenFields !== undefined
      ? buildSessionFinalMetrics(sessionTokenFields)
      : undefined;

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'hermes', version },
    steps,
    ...(finalMetrics ? { final_metrics: finalMetrics } : {}),
  };
  if (sessionId !== undefined) traj.session_id = sessionId;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeHermes produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
