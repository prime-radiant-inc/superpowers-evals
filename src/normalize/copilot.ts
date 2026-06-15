import {
  ATIF_SCHEMA_VERSION,
  type AtifFinalMetrics,
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
  };
}

interface CopilotToolRequest {
  name?: string;
  arguments?: unknown;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Extract the session-total usage from a `session.shutdown` event into ATIF
 * `final_metrics` + the trajectory model name. Copilot logs the full INPUT
 * breakdown only at shutdown: `modelMetrics.<model>.usage` carries
 * `inputTokens` (which INCLUDES `cacheReadTokens`) and `cacheReadTokens`; the
 * non-cached prompt count is `tokenDetails.input`.
 *
 * Completion is intentionally NOT taken from the shutdown total: it is already
 * accounted per-step from each assistant.message's `outputTokens` (every
 * message carries it, including text-only turns). Carrying it here too would
 * double-count completion when downstream sums step.metrics + final_metrics.
 */
function shutdownFinalMetrics(data: Record<string, unknown>): {
  finalMetrics?: AtifFinalMetrics | undefined;
  model?: string | undefined;
} {
  const tokenDetails = data['tokenDetails'];
  if (!tokenDetails || typeof tokenDetails !== 'object') return {};
  const td = tokenDetails as Record<string, unknown>;

  const countOf = (key: string): number | undefined => {
    const slot = td[key];
    if (!slot || typeof slot !== 'object') return undefined;
    return numberOrUndefined((slot as Record<string, unknown>)['tokenCount']);
  };

  const prompt = countOf('input');
  const cached = countOf('cache_read');

  const finalMetrics: AtifFinalMetrics = {};
  if (prompt !== undefined) finalMetrics.total_prompt_tokens = prompt;
  if (cached !== undefined)
    finalMetrics.extra = { total_cached_tokens: cached };

  const model =
    typeof data['currentModel'] === 'string'
      ? (data['currentModel'] as string)
      : undefined;

  if (Object.keys(finalMetrics).length === 0) return { model };
  return { finalMetrics, model };
}

/**
 * Convert a Copilot CLI session-state JSONL log into an ATIF v1.7 trajectory.
 *
 * Copilot logs JSONL where assistant messages have:
 *   {"type": "assistant.message", "data": {"toolRequests": [{"name": "...", "arguments": {...}}]}}
 */
export function normalizeCopilot(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;
  let finalMetrics: AtifFinalMetrics | undefined;
  let agentModel: string | undefined;

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
        const { finalMetrics: fm, model } = shutdownFinalMetrics(
          data as Record<string, unknown>,
        );
        if (fm) finalMetrics = fm;
        if (model) agentModel = model;
      }
      continue;
    }

    if (entry['type'] !== 'assistant.message') continue;
    const data = entry['data'];
    if (!data || typeof data !== 'object') continue;
    const toolRequests = data['toolRequests'];
    if (!Array.isArray(toolRequests)) continue;

    // Per-message usage. Copilot logs only the completion count
    // (`outputTokens`) and `model` per assistant message; the full
    // input/cache breakdown lands at session.shutdown → final_metrics.
    // Attach the message metrics to the FIRST step it produces so a
    // multi-toolRequest message does not double-count its tokens.
    const d = data as Record<string, unknown>;
    const messageModel =
      typeof d['model'] === 'string' ? d['model'] : undefined;
    const completion = numberOrUndefined(d['outputTokens']);
    let messageUsageAttached = false;

    const attachUsage = (step: AtifStep): void => {
      if (messageUsageAttached) return;
      if (messageModel) step.model_name = messageModel;
      if (completion !== undefined) {
        step.metrics = { completion_tokens: completion };
      }
      if (messageModel || completion !== undefined) {
        messageUsageAttached = true;
      }
    };

    for (const request of toolRequests) {
      if (!request || typeof request !== 'object') continue;
      const req = request as CopilotToolRequest;
      const name = req['name'];
      if (typeof name !== 'string' || !name) continue;

      const canonical = COPILOT_TOOL_MAP[name] ?? name;
      // Match quorum/normalizers.py request.get("arguments", {}): default to {}
      // ONLY when the key is absent. A present-but-null `arguments` passes
      // through as null so raw_input preserves it (parity, not `?? {}`).
      const rawInput =
        req['arguments'] === undefined ? {} : (req['arguments'] as unknown);
      const args = normalizeCopilotArgs(name, rawInput);

      const tc: AtifToolCall = {
        tool_call_id: `${stepId}`,
        function_name: canonical,
        arguments: args,
      };

      const step: AtifStep = {
        step_id: stepId++,
        source: 'agent',
        tool_calls: [tc],
      };

      attachUsage(step);
      steps.push(step);
    }

    // A text-only assistant message (no tool requests) still carries its
    // outputTokens. Emit a dedicated metrics-only agent step so its completion
    // is not dropped — completion is sourced ONLY per-step (final_metrics
    // carries no completion), so dropping it here would lose those tokens.
    if (!messageUsageAttached && completion !== undefined) {
      const step: AtifStep = { step_id: stepId++, source: 'agent' };
      attachUsage(step);
      steps.push(step);
    }
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'copilot', version },
    steps,
  };

  if (agentModel) traj.agent.model_name = agentModel;
  if (finalMetrics) traj.final_metrics = finalMetrics;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeCopilot produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
