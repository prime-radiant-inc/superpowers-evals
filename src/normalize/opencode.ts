import {
  ATIF_SCHEMA_VERSION,
  type AtifMetrics,
  type AtifObservation,
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

/**
 * Extract a part-level timestamp from the part's `time` field.
 *
 * OpenCode parts carry `time: { start: <epochMs>, end: <epochMs> }`.
 * We use `start` and convert epoch ms → ISO-8601 string.
 */
function extractPartTimestamp(
  part: Record<string, unknown>,
): string | undefined {
  const time = part['time'];
  if (!time || typeof time !== 'object') return undefined;
  const t = time as Record<string, unknown>;
  const start = t['start'];
  if (typeof start === 'number' && Number.isFinite(start)) {
    try {
      return new Date(start).toISOString();
    } catch {
      return undefined;
    }
  }
  return undefined;
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
 * output + reasoning folded→completion_tokens, cache.read→cached_tokens,
 * modelID→model_name, providerID→extra.provider, cache.write→extra.cache_write.
 * The per-message `cost` is intentionally NOT mapped: OpenCode computes it from
 * its own provider rates (0/meaningless for the custom 'quorum' endpoints the
 * credential axis routes through), so obol prices from the token buckets instead.
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
  // OpenCode's per-message `cost` is intentionally NOT mapped to cost_usd. It is
  // computed from OpenCode's own provider rates, which are 0/meaningless for the
  // custom 'quorum' endpoints the credential axis routes through — so obol prices
  // from the token buckets instead (one pricing authority across all agents).

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
 * OpenCode exports a JSON object with a top-level "info" (containing the
 * session id) and a "messages" array; each message has a "parts" array.
 * Parts can be "text", "reasoning", "tool", "step-start", or "step-finish".
 *
 * Per-message extraction:
 *   - text parts → joined and carried as step.message on the first tool step
 *   - reasoning parts → joined '\n\n' as step.reasoning_content on first tool step
 *   - tool parts → one AtifStep each, with:
 *       - real callID → tool_call_id (falls back to synthetic id if absent)
 *       - state.output → observation.results[0].content (with source_call_id)
 *       - time.start → step.timestamp (epoch ms → ISO-8601)
 *   - usage → step.metrics on first tool step (or a dedicated metrics-only step)
 *   - session_id → from top-level info.id
 */
export function normalizeOpencode(
  raw: string,
  version: string,
): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;
  let sessionId: string | undefined;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    // Extract session_id from top-level info.id
    if (typeof obj['info'] === 'object' && obj['info'] !== null) {
      const topInfo = obj['info'] as Record<string, unknown>;
      if (typeof topInfo['id'] === 'string' && topInfo['id']) {
        sessionId = topInfo['id'];
      }
    }

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

        // Collect text and reasoning content from this message's parts
        const textParts: string[] = [];
        const reasoningParts: string[] = [];
        for (const part of parts) {
          if (!part || typeof part !== 'object') continue;
          const p = part as Record<string, unknown>;
          if (
            p['type'] === 'text' &&
            typeof p['text'] === 'string' &&
            p['text']
          ) {
            textParts.push(p['text']);
          } else if (
            p['type'] === 'reasoning' &&
            typeof p['text'] === 'string' &&
            p['text']
          ) {
            reasoningParts.push(p['text']);
          }
        }
        const messageText =
          textParts.length > 0 ? textParts.join('\n\n') : undefined;
        const reasoningText =
          reasoningParts.length > 0 ? reasoningParts.join('\n\n') : undefined;

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

          // Use the real callID when present; fall back to synthetic id
          const callID =
            typeof p['callID'] === 'string' && p['callID']
              ? p['callID']
              : `${stepId}`;

          const tc: AtifToolCall = {
            tool_call_id: callID,
            function_name: canonical,
            arguments: args,
          };

          const step: AtifStep = {
            step_id: stepId++,
            source: 'agent',
            tool_calls: [tc],
          };

          // Timestamp from the part's time.start (epoch ms → ISO-8601)
          const ts = extractPartTimestamp(p);
          if (ts) step.timestamp = ts;

          // Observation from state.output
          const state = p['state'];
          if (typeof state === 'object' && state !== null) {
            const output = (state as Record<string, unknown>)['output'];
            if (output !== undefined && output !== null) {
              const obs: AtifObservation = {
                results: [
                  {
                    source_call_id: callID,
                    content:
                      typeof output === 'string'
                        ? output
                        : JSON.stringify(output),
                  },
                ],
              };
              step.observation = obs;
            }
          }

          messageSteps.push(step);
          steps.push(step);
        }

        // Carry text/reasoning onto the first tool step of this message.
        // If no tool step, they'll go on the metrics-only carrier below.
        const firstToolStep = messageSteps[0];
        if (firstToolStep) {
          if (messageText) firstToolStep.message = messageText;
          if (reasoningText) firstToolStep.reasoning_content = reasoningText;
        }

        if (usage) {
          // Attach the message's usage to its first emitted tool-call step. An
          // assistant message that emits no tool step (text-only final answer)
          // gets a dedicated metrics-only agent step so its usage is not dropped.
          const carrier =
            messageSteps[0] ??
            (() => {
              const s: AtifStep = { step_id: stepId++, source: 'agent' };
              // Carry text/reasoning onto the metrics-only step when no tool step
              if (messageText) s.message = messageText;
              if (reasoningText) s.reasoning_content = reasoningText;
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

  if (sessionId) traj.session_id = sessionId;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeOpencode produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
