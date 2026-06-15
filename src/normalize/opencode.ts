import {
  ATIF_SCHEMA_VERSION,
  type AtifMetrics,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';

const OPENCODE_TOOL_MAP: Record<string, string> = {
  skill: 'Skill',
  task: 'Agent',
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  todowrite: 'TodoWrite',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
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

function getToolInput(part: Record<string, unknown>): unknown {
  const state = part['state'];
  if (!state || typeof state !== 'object') return {};
  return (state as Record<string, unknown>)['input'] ?? {};
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface MessageUsage {
  metrics: AtifMetrics;
  model: string | undefined;
  provider: string | undefined;
  cacheWrite: number;
}

/**
 * Extract per-message usage from an OpenCode assistant message `info` block.
 *
 * Field mapping (spec 2026-06-15-atif-usage-unification.md): input→prompt_tokens,
 * output + reasoning folded→completion_tokens, cache.read→cached_tokens, the
 * per-message `cost`→cost_usd (OpenCode logs cost, so we do NOT re-price).
 * modelID→model_name, providerID→extra.provider, cache.write→extra.cache_write.
 * Returns undefined when the message carries no `tokens` block.
 */
function extractOpencodeUsage(
  info: Record<string, unknown>,
): MessageUsage | undefined {
  const tok = info['tokens'];
  if (typeof tok !== 'object' || tok === null) return undefined;
  const t = tok as Record<string, unknown>;
  const cache =
    typeof t['cache'] === 'object' && t['cache'] !== null
      ? (t['cache'] as Record<string, unknown>)
      : {};

  const metrics: AtifMetrics = {
    prompt_tokens: num(t['input']),
    completion_tokens: num(t['output']) + num(t['reasoning']),
    cached_tokens: num(cache['read']),
  };
  if (typeof info['cost'] === 'number' && Number.isFinite(info['cost'])) {
    metrics.cost_usd = info['cost'];
  }

  return {
    metrics,
    model: typeof info['modelID'] === 'string' ? info['modelID'] : undefined,
    provider:
      typeof info['providerID'] === 'string' ? info['providerID'] : undefined,
    cacheWrite: num(cache['write']),
  };
}

function normalizeOpencodeArgs(
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

  if (['read', 'write', 'edit'].includes(name) && !('file_path' in args)) {
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

/**
 * Convert an OpenCode exported session JSON into an ATIF v1.7 trajectory.
 *
 * OpenCode exports a JSON object with a "messages" array; each message has a
 * "parts" array; tool parts have {"type": "tool", "tool": "<name>",
 * "state": {"input": {...}}}.
 */
export function normalizeOpencode(
  raw: string,
  version: string,
): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const messages = obj['messages'];
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const msg = message as Record<string, unknown>;
        const parts = msg['parts'];
        if (!Array.isArray(parts)) continue;

        const info =
          typeof msg['info'] === 'object' && msg['info'] !== null
            ? (msg['info'] as Record<string, unknown>)
            : msg;
        const usage = extractOpencodeUsage(info);

        const messageSteps: AtifStep[] = [];
        for (const part of parts) {
          if (!part || typeof part !== 'object') continue;
          const p = part as Record<string, unknown>;
          if (p['type'] !== 'tool') continue;
          const name = p['tool'];
          if (typeof name !== 'string' || !name) continue;

          const canonical = OPENCODE_TOOL_MAP[name] ?? name;
          const rawInput = getToolInput(p);
          const args = normalizeOpencodeArgs(name, rawInput);

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
          messageSteps.push(step);
          steps.push(step);
        }

        if (usage) {
          // Attach the message's usage to its first emitted tool-call step. An
          // assistant message that emits no tool step (text-only final answer)
          // gets a dedicated metrics-only agent step so its usage is not dropped.
          const carrier =
            messageSteps[0] ??
            (() => {
              const s: AtifStep = { step_id: stepId++, source: 'agent' };
              steps.push(s);
              return s;
            })();
          carrier.metrics = usage.metrics;
          if (usage.model) carrier.model_name = usage.model;
          const extra: Record<string, unknown> = { ...carrier.extra };
          if (usage.provider) extra['provider'] = usage.provider;
          extra['cache_write'] = usage.cacheWrite;
          carrier.extra = extra;
        }
      }
    }
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'opencode', version },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeOpencode produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
