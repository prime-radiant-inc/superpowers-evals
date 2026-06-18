// Ported from Harbor's src/harbor/agents/installed/rovodev_cli.py
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
// Tool name map: RovoDev native names → our canonical names.
// Unknown names pass through unchanged.
// ---------------------------------------------------------------------------

const ROVODEV_TOOL_MAP: Record<string, string> = {
  // Shell / execution
  Shell: 'Bash',
  shell: 'Bash',
  bash: 'Bash',
  exec: 'Bash',
  run_command: 'Bash',
  // File reading
  ReadFile: 'Read',
  read_file: 'Read',
  view_file: 'Read',
  // File writing
  WriteFile: 'Write',
  write_file: 'Write',
  create_file: 'Write',
  // File editing
  EditFile: 'Edit',
  edit_file: 'Edit',
  patch_file: 'Edit',
  apply_patch: 'Edit',
  // Search
  grep: 'Grep',
  search_files: 'Grep',
  // Glob
  glob: 'Glob',
  list_files: 'Glob',
  // Web
  web_fetch: 'WebFetch',
  fetch_url: 'WebFetch',
  web_search: 'WebSearch',
  search_web: 'WebSearch',
  // Todos
  update_todo: 'TodoWrite',
  // Subagent dispatch — map to Agent, canonicalize prompt via agent-prompt.ts
  spawn_agent: 'Agent',
  invoke_agent: 'Agent',
  subagent: 'Agent',
  task: 'Agent',
};

// ---------------------------------------------------------------------------
// System message patterns to filter out internal rovodev messages.
// Ported from RovodevCli.SYSTEM_MESSAGE_PATTERNS.
// ---------------------------------------------------------------------------

const SYSTEM_MESSAGE_PATTERNS: RegExp[] = [
  /^Based on these messages, generate a 2-4 word title that captures the main task:[\s\S]*?Respond with ONLY the title, nothing else\. Do not include quotes or formatting\.$/,
  /^You are a helpful assistant that generates short, descriptive titles\.$/,
  /^Before you start working on the next task, please take a look at the workspace\.$/,
  /^You have used \d+ iterations\.$/,
  /^<system_reminder>[\s\S]*?<\/system_reminder>$/,
];

function isSystemMessage(content: string): boolean {
  for (const pattern of SYSTEM_MESSAGE_PATTERNS) {
    if (pattern.test(content)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Type aliases for the rovodev session JSON shape.
// ---------------------------------------------------------------------------

type RovodevPart = Record<string, unknown>;
type RovodevMessage = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Token bucket helpers
// ---------------------------------------------------------------------------

/**
 * Build per-step ATIF metrics from a RovoDev response message's usage block.
 *
 * RovoDev log buckets (from the Python converter analysis):
 *   input_tokens:       uncached input (EXCLUSIVE of cache — already disjoint)
 *   cache_read_tokens:  cache-read
 *   cache_write_tokens: cache-creation
 *   output_tokens:      output
 *
 * OUR disjoint contract:
 *   metrics.prompt_tokens    = input_tokens           (uncached, no addition)
 *   metrics.cached_tokens    = cache_read_tokens
 *   step.extra.cache_write   = cache_write_tokens     (only when > 0)
 *   metrics.completion_tokens = output_tokens
 *
 * Harbor's Python adds cache_read to input to get an inclusive prompt_tokens;
 * we do NOT replicate that. We keep the buckets disjoint.
 *
 * Returns { metrics, cacheWrite } where cacheWrite is > 0 only when present.
 */
function buildMetrics(
  usage: Record<string, unknown>,
): { metrics: AtifMetrics; cacheWrite: number } | undefined {
  const inputTokens = usage['input_tokens'];
  const outputTokens = usage['output_tokens'];
  const cacheReadTokens = usage['cache_read_tokens'];
  const cacheWriteTokens = usage['cache_write_tokens'];

  const hasAny =
    typeof inputTokens === 'number' ||
    typeof outputTokens === 'number' ||
    typeof cacheReadTokens === 'number';

  if (!hasAny) return undefined;

  const metrics: AtifMetrics = {};
  if (typeof inputTokens === 'number') metrics.prompt_tokens = inputTokens;
  if (typeof outputTokens === 'number')
    metrics.completion_tokens = outputTokens;
  if (typeof cacheReadTokens === 'number')
    metrics.cached_tokens = cacheReadTokens;

  const cacheWrite =
    typeof cacheWriteTokens === 'number' && cacheWriteTokens > 0
      ? cacheWriteTokens
      : 0;

  return { metrics, cacheWrite };
}

// ---------------------------------------------------------------------------
// Tool argument parsing
// ---------------------------------------------------------------------------

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
      return { raw_args: raw };
    } catch {
      return { raw_args: raw };
    }
  }
  return { raw_args: String(raw) };
}

// ---------------------------------------------------------------------------
// Tool-call builder
// ---------------------------------------------------------------------------

function buildToolCall(part: RovodevPart): AtifToolCall | null {
  const toolName = part['tool_name'];
  const toolCallId = part['tool_call_id'];

  if (typeof toolName !== 'string' || typeof toolCallId !== 'string') {
    return null;
  }

  const args = parseToolArgs(part['args']);
  const canonical = ROVODEV_TOOL_MAP[toolName] ?? toolName;

  return canonicalizeAgentPrompt({
    tool_call_id: toolCallId,
    function_name: canonical,
    arguments: args,
  });
}

// ---------------------------------------------------------------------------
// Collect all tool-returns from request messages, indexed by tool_call_id.
// These are the observations matching tool-calls from response messages.
// ---------------------------------------------------------------------------

function collectToolReturns(
  messageHistory: RovodevMessage[],
): Map<string, string> {
  const toolReturns = new Map<string, string>();
  for (const msg of messageHistory) {
    if (msg['kind'] !== 'request') continue;
    const parts = msg['parts'];
    if (!Array.isArray(parts)) continue;
    for (const part of parts as RovodevPart[]) {
      if (part['part_kind'] !== 'tool-return') continue;
      const toolCallId = part['tool_call_id'];
      if (typeof toolCallId !== 'string') continue;
      const content = part['content'];
      const contentStr =
        typeof content === 'string'
          ? content
          : content === null || content === undefined
            ? '[Empty response]'
            : JSON.stringify(content);
      toolReturns.set(toolCallId, contentStr);
    }
  }
  return toolReturns;
}

// ---------------------------------------------------------------------------
// Process a request message into system and/or user steps.
// System prompt is only extracted from the first request (step_id === 1).
// ---------------------------------------------------------------------------

function processRequestMessage(
  msg: RovodevMessage,
  isFirst: boolean,
  stepId: number,
): AtifStep[] {
  const steps: AtifStep[] = [];
  const parts = msg['parts'];
  if (!Array.isArray(parts)) return steps;

  const timestamp =
    typeof msg['timestamp'] === 'string' ? msg['timestamp'] : undefined;

  // System prompt — first request only
  if (isFirst) {
    const systemParts = (parts as RovodevPart[]).filter(
      (p) => p['part_kind'] === 'system-prompt',
    );
    if (systemParts.length > 0) {
      const contentParts: string[] = [];
      for (const sp of systemParts) {
        const content =
          typeof sp['content'] === 'string' ? sp['content'].trim() : '';
        if (!content) continue;
        const dynamicRef = sp['dynamic_ref'];
        if (typeof dynamicRef === 'string' && dynamicRef) {
          contentParts.push(`[${dynamicRef}] ${content}`);
        } else {
          contentParts.push(content);
        }
      }
      if (contentParts.length > 0) {
        const firstSp = systemParts[0];
        const ts =
          firstSp && typeof firstSp['timestamp'] === 'string'
            ? firstSp['timestamp']
            : timestamp;
        const sysStep: AtifStep = {
          step_id: stepId + steps.length,
          source: 'system',
          message: contentParts.join('\n\n'),
        };
        if (ts) sysStep.timestamp = ts;
        steps.push(sysStep);
      }
    }
  }

  // User prompts (filtering system/internal messages)
  const userParts = (parts as RovodevPart[]).filter(
    (p) => p['part_kind'] === 'user-prompt',
  );
  for (const up of userParts) {
    const content = typeof up['content'] === 'string' ? up['content'] : '';
    if (!content.trim()) continue;
    if (isSystemMessage(content.trim())) continue;
    const ts =
      typeof up['timestamp'] === 'string' ? up['timestamp'] : timestamp;
    const userStep: AtifStep = {
      step_id: stepId + steps.length,
      source: 'user',
      message: content.trim(),
    };
    if (ts) userStep.timestamp = ts;
    steps.push(userStep);
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Process a response message into an agent step.
// ---------------------------------------------------------------------------

function processResponseMessage(
  msg: RovodevMessage,
  stepId: number,
  toolReturns: Map<string, string>,
): AtifStep | null {
  const parts = msg['parts'];
  if (!Array.isArray(parts)) return null;

  const timestamp =
    typeof msg['timestamp'] === 'string' ? msg['timestamp'] : undefined;

  // Extract text, thinking, and tool-call parts
  let textContent = '';
  let thinkingContent = '';
  const toolCallParts: RovodevPart[] = [];

  for (const part of parts as RovodevPart[]) {
    const partKind = part['part_kind'];
    const content = typeof part['content'] === 'string' ? part['content'] : '';

    if (partKind === 'thinking') {
      thinkingContent += content;
    } else if (partKind === 'text') {
      textContent += content;
    } else if (partKind === 'tool-call') {
      toolCallParts.push(part);
    }
  }

  textContent = textContent.trim();
  thinkingContent = thinkingContent.trim();

  // Build tool calls and paired observations
  const toolCalls: AtifToolCall[] = [];
  const obsResults: AtifObservationResult[] = [];

  for (const tcPart of toolCallParts) {
    const tc = buildToolCall(tcPart);
    if (!tc) continue;
    toolCalls.push(tc);

    const toolCallId = tc.tool_call_id;
    if (toolCallId && toolReturns.has(toolCallId)) {
      const content = toolReturns.get(toolCallId);
      const obsResult: AtifObservationResult = {
        source_call_id: toolCallId,
      };
      if (content !== undefined) obsResult.content = content;
      obsResults.push(obsResult);
    }
  }

  // Determine message content — mirror Harbor's _create_agent_message_content
  let message: string | undefined;
  if (textContent) {
    message = textContent;
  } else if (toolCalls.length > 0) {
    if (toolCalls.length === 1) {
      const tc = toolCalls[0];
      message = tc ? `Calling ${tc.function_name}` : 'Agent response';
    } else {
      const names = toolCalls.map((tc) => tc.function_name);
      message = `Calling tools: ${names.join(', ')}`;
    }
  } else {
    message = 'Agent response';
  }

  // Extract model name
  const modelName =
    typeof msg['model_name'] === 'string' && msg['model_name']
      ? msg['model_name']
      : undefined;

  // Build metrics from usage
  const usageRaw = msg['usage'];
  let stepMetrics: AtifMetrics | undefined;
  let cacheWrite = 0;
  if (usageRaw && typeof usageRaw === 'object' && !Array.isArray(usageRaw)) {
    const result = buildMetrics(usageRaw as Record<string, unknown>);
    if (result) {
      stepMetrics = result.metrics;
      cacheWrite = result.cacheWrite;
    }
  }

  const step: AtifStep = {
    step_id: stepId,
    source: 'agent',
  };
  if (timestamp) step.timestamp = timestamp;
  if (message) step.message = message;
  if (thinkingContent) step.reasoning_content = thinkingContent;
  if (toolCalls.length > 0) step.tool_calls = toolCalls;
  if (obsResults.length > 0) step.observation = { results: obsResults };
  if (modelName) step.model_name = modelName;
  if (stepMetrics) step.metrics = stepMetrics;
  if (cacheWrite > 0) step.extra = { cache_write: cacheWrite };

  return step;
}

// ---------------------------------------------------------------------------
// Main normalizer export
// ---------------------------------------------------------------------------

/**
 * Convert a RovoDev CLI session context JSON into an ATIF v1.7 trajectory.
 *
 * The RovoDev session file (`~/.rovodev/sessions/<id>/session_context.json`)
 * is a pydantic-ai message_history with alternating request/response messages.
 * Request messages carry user-prompt and tool-return parts; response messages
 * carry text, thinking, and tool-call parts plus per-message usage.
 *
 * Token bucket mapping (DISJOINT — OUR convention, NOT Harbor's inclusive):
 *   input_tokens      → metrics.prompt_tokens    (already uncached)
 *   cache_read_tokens → metrics.cached_tokens
 *   cache_write_tokens→ step.extra.cache_write    (only when > 0)
 *   output_tokens     → metrics.completion_tokens
 *
 * Usage source: per-response-message only (SINGLE-SOURCE invariant).
 * No final_metrics emitted; obol sums per-step metrics across all steps.
 */
export function normalizeRovodev(raw: string, version: string): AtifTrajectory {
  let session: Record<string, unknown>;
  try {
    session = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Malformed JSON → emit minimal trajectory
    const fallback: AtifTrajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      agent: { name: 'rovodev', version },
      steps: [{ step_id: 1, source: 'user', message: '' }],
    };
    return fallback;
  }

  const sessionId =
    typeof session['id'] === 'string' && session['id']
      ? session['id']
      : undefined;

  const messageHistory = session['message_history'];
  const msgs: RovodevMessage[] = Array.isArray(messageHistory)
    ? (messageHistory as RovodevMessage[])
    : [];

  // Collect all tool-returns first (they appear in request messages AFTER the
  // response that made the call — pydantic-ai request/response interleaving)
  const toolReturns = collectToolReturns(msgs);

  const steps: AtifStep[] = [];
  let stepId = 1;
  let isFirstRequest = true;

  for (const msg of msgs) {
    const kind = msg['kind'];

    if (kind === 'request') {
      const newSteps = processRequestMessage(msg, isFirstRequest, stepId);
      isFirstRequest = false;
      for (const s of newSteps) {
        s.step_id = stepId++;
        steps.push(s);
      }
    } else if (kind === 'response') {
      const agentStep = processResponseMessage(msg, stepId, toolReturns);
      if (agentStep) {
        agentStep.step_id = stepId++;
        steps.push(agentStep);
      }
    }
  }

  // ATIF requires at least one step.
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // Reassign sequential step_ids (1-based sequential as required by validate.ts)
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s) s.step_id = i + 1;
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'rovodev', version },
    steps,
  };
  if (sessionId) traj.session_id = sessionId;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeRovodev produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
