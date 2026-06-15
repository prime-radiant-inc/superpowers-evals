import {
  ATIF_SCHEMA_VERSION,
  type AtifMetrics,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';

// Reverse mapping: Gemini tool names → canonical names.
const GEMINI_TOOL_MAP: Record<string, string> = {
  run_shell_command: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  grep_search: 'Grep',
  glob: 'Glob',
  activate_skill: 'Skill',
  google_web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  write_todos: 'TodoWrite',
  list_directory: 'Glob',
  enter_plan_mode: 'EnterPlanMode',
  exit_plan_mode: 'ExitPlanMode',
};

interface GeminiMessage {
  type?: string;
  timestamp?: string | number;
  createdAt?: string | number;
  time?: string | number;
  toolCalls?: GeminiToolCall[];
  [key: string]: unknown;
}

/**
 * Extract an ISO-8601 step timestamp from a Gemini message.
 *
 * Accepts `timestamp`, `createdAt`, or `time` (in that priority order).
 * String values are used verbatim; numeric values (epoch milliseconds) are
 * converted to an ISO-8601 string so the merge in src/capture/ can order
 * steps from multiple logs by event time.
 */
function extractTimestamp(message: GeminiMessage): string | undefined {
  const raw = message['timestamp'] ?? message['createdAt'] ?? message['time'];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // A finite-but-out-of-range epoch (e.g. nanoseconds) makes toISOString()
    // throw RangeError; treat it as "no timestamp" rather than crash the
    // normalizer (which would drop this whole log from the merge).
    try {
      return new Date(raw).toISOString();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  status?: string;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Extract ATIF usage metrics from a Gemini turn's `tokens` block.
 *
 * Field mapping (spec 2026-06-15-atif-usage-unification.md): input→prompt_tokens,
 * output + thoughts (reasoning) folded → completion_tokens, cached→cached_tokens.
 * Gemini logs carry no per-message cost, so cost_usd is left unset (priced
 * downstream by obol's rate table). Returns undefined when the row has no
 * `tokens` block.
 */
function extractGeminiMetrics(message: GeminiMessage): AtifMetrics | undefined {
  const tok = message['tokens'];
  if (typeof tok !== 'object' || tok === null) return undefined;
  const t = tok as Record<string, unknown>;
  return {
    prompt_tokens: num(t['input']),
    completion_tokens: num(t['output']) + num(t['thoughts']),
    cached_tokens: num(t['cached']),
  };
}

function parseGeminiMessages(raw: string): GeminiMessage[] {
  const messages: GeminiMessage[] = [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if (!Array.isArray(data) && 'messages' in obj) {
        // When the envelope has a `messages` key, iterate ONLY that value
        // (filtering to dicts). A present-but-non-array `messages` yields no
        // messages — the envelope object itself is NOT treated as a single
        // message.
        const inner = obj['messages'];
        if (Array.isArray(inner)) {
          for (const m of inner) {
            if (typeof m === 'object' && m !== null)
              messages.push(m as GeminiMessage);
          }
        }
      } else if (Array.isArray(data)) {
        for (const m of data) {
          if (typeof m === 'object' && m !== null)
            messages.push(m as GeminiMessage);
        }
      } else {
        messages.push(obj as GeminiMessage);
      }
    }
  } catch {
    // JSONL fallback
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as unknown;
        if (typeof entry === 'object' && entry !== null) {
          messages.push(entry as GeminiMessage);
        }
      } catch {}
    }
  }
  return messages;
}

function normalizeGeminiToolCall(tc: GeminiToolCall): AtifToolCall {
  const geminiName = tc.name ?? '';
  const canonical = GEMINI_TOOL_MAP[geminiName] ?? geminiName;
  // A dict `args` is copied; any non-dict (string/number/array/null) is
  // wrapped as {raw_args: <value>}, preserving the raw payload.
  const rawArgs: unknown = tc.args ?? {};
  const isDict =
    typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs);
  const args: Record<string, unknown> = isDict
    ? { ...(rawArgs as Record<string, unknown>) }
    : { raw_args: rawArgs };

  if (canonical === 'Skill') {
    // Gemini passes skill via "skill" or "name" key; normalize to "skill" with namespace.
    const skillName =
      (typeof args['skill'] === 'string' ? args['skill'] : null) ??
      (typeof args['name'] === 'string' ? args['name'] : null) ??
      '';
    if (skillName) {
      args['skill'] = skillName.includes(':')
        ? skillName
        : `superpowers:${skillName}`;
    }
  }

  return {
    tool_call_id: tc.id ?? '',
    function_name: canonical,
    arguments: args,
  };
}

/**
 * Convert a Gemini CLI session log into an ATIF v1.7 trajectory.
 *
 * Gemini logs may be a single JSON object with a "messages" array, a plain
 * JSON array, or JSONL. Each "gemini"-type message may carry a toolCalls
 * array. Duplicate tool call ids (same id across messages) are deduplicated.
 * Each tool call becomes its own agent step.
 */
export function normalizeGemini(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  const seenIds = new Set<string>();
  // gemini-cli rewrites a running `messages[]` snapshot on each line, so a turn
  // (same row `id`) recurs with identical `tokens`. Dedup token accounting by
  // row id so each turn's usage is counted exactly once.
  const seenTokenIds = new Set<string>();
  let stepId = 1;

  for (const message of parseGeminiMessages(raw)) {
    if (message['type'] !== 'gemini') continue;
    const timestamp = extractTimestamp(message);

    // Compute this turn's usage once per distinct row id. A row with no `id`
    // (or a first-seen id) contributes; a repeat of a seen id contributes
    // nothing (it is the same turn re-snapshotted).
    const rowId = typeof message['id'] === 'string' ? message['id'] : null;
    let metrics: AtifMetrics | undefined;
    let modelName: string | undefined;
    if (rowId === null || !seenTokenIds.has(rowId)) {
      metrics = extractGeminiMetrics(message);
      if (metrics) {
        if (rowId !== null) seenTokenIds.add(rowId);
        modelName =
          typeof message['model'] === 'string' ? message['model'] : undefined;
      }
    }

    const toolCalls = message['toolCalls'];
    const turnSteps: AtifStep[] = [];
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (typeof tc !== 'object' || tc === null) continue;
        const gtc = tc as GeminiToolCall;
        const id = gtc.id;
        if (id) {
          if (seenIds.has(id)) continue;
          seenIds.add(id);
        }

        const atifTc = normalizeGeminiToolCall(gtc);
        const step: AtifStep = {
          step_id: stepId++,
          source: 'agent',
          tool_calls: [atifTc],
        };
        if (timestamp) step.timestamp = timestamp;
        turnSteps.push(step);
        steps.push(step);
      }
    }

    if (metrics) {
      // Attach the turn's usage to its first emitted tool-call step. A turn that
      // emits no tool step (text-only / final answer) gets a dedicated
      // metrics-only agent step so its tokens are not dropped.
      const carrier =
        turnSteps[0] ??
        (() => {
          const s: AtifStep = { step_id: stepId++, source: 'agent' };
          if (timestamp) s.timestamp = timestamp;
          steps.push(s);
          return s;
        })();
      carrier.metrics = metrics;
      if (modelName) carrier.model_name = modelName;
      carrier.extra = { ...carrier.extra, provider: 'google' };
    }
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'gemini', version },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeGemini produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
