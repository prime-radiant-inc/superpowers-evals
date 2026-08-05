import {
  ATIF_SCHEMA_VERSION,
  type AtifMetrics,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';

const COPILOT_TOOL_MAP: Record<string, string> = {
  skill: 'Skill',
  bash: 'Bash',
  apply_patch: 'Edit',
  edit: 'Edit',
  create: 'Write',
  write: 'Write',
  view: 'Read',
  rg: 'Grep',
  glob: 'Glob',
  task: 'Agent',
  read_agent: 'Agent',
  list_agents: 'Agent',
  write_agent: 'Agent',
  update_todo: 'TodoWrite',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
};

function applyPatchPaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string') return [];
  const paths: string[] = [];
  const prefixes = ['*** Add File: ', '*** Update File: ', '*** Delete File: '];
  for (const line of patchText.split('\n')) {
    for (const prefix of prefixes) {
      if (line.startsWith(prefix)) {
        const path = line.slice(prefix.length).trim();
        if (path) paths.push(path);
        break;
      }
    }
  }
  return paths;
}

function normalizeCopilotArgs(
  name: string,
  rawInput: unknown,
): Record<string, unknown> {
  const args: Record<string, unknown> =
    typeof rawInput === 'object' && rawInput !== null
      ? { ...(rawInput as Record<string, unknown>) }
      : {};
  args['raw_input'] = rawInput;

  if (name === 'skill') {
    let skillName = '';
    if (typeof rawInput === 'object' && rawInput !== null) {
      const ri = rawInput as Record<string, unknown>;
      const candidate = ri['skill'] ?? ri['name'];
      if (typeof candidate === 'string') skillName = candidate;
    }
    if (skillName) {
      args['name'] = skillName.split(':').slice(-1)[0] ?? skillName;
      args['skill'] = skillName.includes(':')
        ? skillName
        : `superpowers:${skillName}`;
    }
  }

  if (name === 'bash' && !('command' in args)) {
    const cmd = args['cmd'];
    if (typeof cmd === 'string') args['command'] = cmd;
  }

  if (
    ['view', 'edit', 'create', 'write'].includes(name) &&
    !('file_path' in args)
  ) {
    for (const key of ['file_path', 'filePath', 'path', 'file']) {
      const val = args[key];
      if (typeof val === 'string') {
        args['file_path'] = val;
        break;
      }
    }
  }

  if (name === 'apply_patch' && !('file_path' in args)) {
    let patchText = args['patch'];
    if (typeof patchText !== 'string' && typeof rawInput === 'string') {
      patchText = rawInput;
    }
    const paths = applyPatchPaths(patchText);
    if (paths.length > 0) {
      args['file_path'] = paths[0];
      args['file_paths'] = paths;
    }
  }

  return args;
}

interface CopilotEntry {
  type?: string;
  data?: {
    toolRequests?: unknown[];
    content?: unknown;
    toolCallId?: unknown;
    result?: unknown;
  };
}

interface CopilotToolRequest {
  name?: string;
  arguments?: unknown;
  toolCallId?: unknown;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Extract the session-total usage from a `session.shutdown` event. Copilot logs
 * the full INPUT breakdown only at shutdown: `tokenDetails` carries the
 * non-cached prompt count (`input`), `cache_read`, `cache_write`, and `output`
 * (which equals the sum of per-message `outputTokens`, so nothing is lost).
 *
 * The totals ride a single SUMMARY STEP (metrics + extra.cache_write), not
 * `final_metrics`: the obol `atif` dialect reads cache_write only from
 * step.extra — final_metrics has no cache-write slot it honors — and it skips
 * final_metrics entirely whenever any step has metrics, so a hybrid would
 * silently drop buckets. One metrics-bearing step keeps copilot single-source
 * and prices all four buckets.
 */
function shutdownUsage(data: Record<string, unknown>): {
  metrics?: AtifMetrics | undefined;
  cacheWrite?: number | undefined;
  model?: string | undefined;
} {
  const model =
    typeof data['currentModel'] === 'string'
      ? (data['currentModel'] as string)
      : undefined;

  const tokenDetails = data['tokenDetails'];
  if (!tokenDetails || typeof tokenDetails !== 'object') return { model };
  const td = tokenDetails as Record<string, unknown>;

  const countOf = (key: string): number | undefined => {
    const slot = td[key];
    if (!slot || typeof slot !== 'object') return undefined;
    return numberOrUndefined((slot as Record<string, unknown>)['tokenCount']);
  };

  const prompt = countOf('input');
  const cached = countOf('cache_read');
  const cacheWrite = countOf('cache_write');
  const completion = countOf('output');

  const metrics: AtifMetrics = {};
  if (prompt !== undefined) metrics.prompt_tokens = prompt;
  if (completion !== undefined) metrics.completion_tokens = completion;
  if (cached !== undefined) metrics.cached_tokens = cached;

  if (Object.keys(metrics).length === 0) return { model };
  return { metrics, cacheWrite, model };
}

/**
 * Convert a Copilot CLI session-state JSONL log into an ATIF v1.7 trajectory.
 *
 * Copilot logs JSONL where assistant messages have:
 *   {"type": "assistant.message", "data": {"content": "...", "toolRequests": [{"toolCallId": "...", "name": "...", "arguments": {...}}]}}
 * Tool results arrive in separate events:
 *   {"type": "tool.execution_complete", "data": {"toolCallId": "...", "result": {"content": "..."}}}
 *
 * Content fidelity:
 *   - assistant.message.content (when non-empty) → step.message on the first
 *     step of that message block. Most messages have empty content (the real
 *     text is encrypted in encryptedContent which we cannot decode).
 *   - tool.execution_complete.data.result.content → step.observation with
 *     source_call_id matching the toolCallId, on the step that made the call.
 */
export function normalizeCopilot(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;
  let usageMetrics: AtifMetrics | undefined;
  let usageCacheWrite: number | undefined;
  let agentModel: string | undefined;

  // Index tool results by toolCallId for observation attachment.
  // Key: toolCallId string → result content string.
  const toolResults = new Map<string, string>();

  // First pass: collect tool.execution_complete results.
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: CopilotEntry;
    try {
      entry = JSON.parse(line) as CopilotEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry['type'] !== 'tool.execution_complete') continue;

    const data = entry['data'];
    if (!data || typeof data !== 'object') continue;
    const toolCallId = (data as Record<string, unknown>)['toolCallId'];
    if (typeof toolCallId !== 'string' || !toolCallId) continue;
    const result = (data as Record<string, unknown>)['result'];
    if (!result || typeof result !== 'object') continue;
    const content = (result as Record<string, unknown>)['content'];
    if (typeof content === 'string' && content) {
      toolResults.set(toolCallId, content);
    }
  }

  // Second pass: build ATIF steps from assistant.message and session.shutdown events.
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: CopilotEntry;
    try {
      entry = JSON.parse(line) as CopilotEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    if (entry['type'] === 'session.shutdown') {
      const data = entry['data'];
      if (data && typeof data === 'object') {
        const usage = shutdownUsage(data as Record<string, unknown>);
        if (usage.metrics) {
          usageMetrics = usage.metrics;
          usageCacheWrite = usage.cacheWrite;
        }
        if (usage.model) agentModel = usage.model;
      }
      continue;
    }

    if (entry['type'] !== 'assistant.message') continue;
    const data = entry['data'];
    if (!data || typeof data !== 'object') continue;
    const toolRequests = data['toolRequests'];
    if (!Array.isArray(toolRequests)) continue;

    // Extract non-empty message text — attach to the first step of this block.
    const rawContent = (data as Record<string, unknown>)['content'];
    const messageText =
      typeof rawContent === 'string' && rawContent ? rawContent : undefined;

    // Usage is NOT taken per-message: copilot reports the full prompt/completion/
    // cached/cache-write totals at session.shutdown → one summary step (single
    // source; see shutdownUsage). Per-message `outputTokens` summed to the same
    // total, but mixing it into tool steps' metrics made copilot a hybrid the
    // obol atif dialect mishandles. Tool steps here carry only tool calls.
    let isFirstStepOfMessage = true;
    for (const request of toolRequests) {
      if (!request || typeof request !== 'object') continue;
      const req = request as CopilotToolRequest;
      const name = req['name'];
      if (typeof name !== 'string' || !name) continue;

      const canonical = COPILOT_TOOL_MAP[name] ?? name;
      // Default to {} ONLY when the `arguments` key is absent. A present-but-null
      // `arguments` passes through as null so raw_input preserves it — hence the
      // explicit `=== undefined` test rather than `?? {}`.
      const rawInput =
        req['arguments'] === undefined ? {} : (req['arguments'] as unknown);
      const args = normalizeCopilotArgs(name, rawInput);

      // Use the native toolCallId from the log when present; fall back to the
      // sequential counter so existing tests that don't provide toolCallId still work.
      const nativeId = req['toolCallId'];
      const toolCallId =
        typeof nativeId === 'string' && nativeId ? nativeId : `${stepId}`;

      const tc: AtifToolCall = {
        tool_call_id: toolCallId,
        function_name: canonical,
        arguments: args,
      };

      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        tool_calls: [tc],
      };

      // Attach message text to the first step of each assistant.message block.
      if (isFirstStepOfMessage && messageText !== undefined) {
        step.message = messageText;
        isFirstStepOfMessage = false;
      }

      // Attach tool result as observation if we have one for this call.
      const resultContent = toolResults.get(toolCallId);
      if (resultContent !== undefined) {
        step.observation = {
          results: [{ source_call_id: toolCallId, content: resultContent }],
        };
      }

      steps.push(step);
    }
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
    stepId = 2;
  }

  // Session-total usage rides one summary step (see shutdownUsage).
  if (usageMetrics) {
    const summary: (typeof steps)[number] = {
      step_id: stepId++,
      source: 'agent',
      metrics: usageMetrics,
    };
    if (usageCacheWrite) summary.extra = { cache_write: usageCacheWrite };
    steps.push(summary);
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'copilot', version },
    steps,
  };

  if (agentModel) traj.agent.model_name = agentModel;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeCopilot produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
