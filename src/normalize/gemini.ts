import {
  ATIF_SCHEMA_VERSION,
  type AtifMetrics,
  type AtifObservation,
  type AtifObservationResult,
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
  invoke_agent: 'Agent',
};

interface GeminiThought {
  subject?: unknown;
  description?: unknown;
}

interface GeminiMessage {
  id?: unknown;
  type?: string;
  timestamp?: string | number;
  createdAt?: string | number;
  time?: string | number;
  content?: unknown;
  thoughts?: GeminiThought[];
  toolCalls?: GeminiToolCall[];
  tokens?: unknown;
  model?: unknown;
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
  result?: unknown;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Extract ATIF usage metrics from a Gemini turn's `tokens` block.
 *
 * Field mapping (spec 2026-06-15-atif-usage-unification.md): input→prompt_tokens,
 * output + thoughts (reasoning) + tool folded → completion_tokens,
 * cached→cached_tokens. Folding `tool` matches Harbor's gemini converter
 * (gemini_cli.py:371); dropping it undercounts completion. Gemini logs carry no
 * per-message cost, so cost_usd is left unset (priced downstream by obol's rate
 * table). Returns undefined when the row has no `tokens` block.
 */
function extractGeminiMetrics(message: GeminiMessage): AtifMetrics | undefined {
  const tok = message['tokens'];
  if (typeof tok !== 'object' || tok === null) return undefined;
  const t = tok as Record<string, unknown>;
  return {
    prompt_tokens: num(t['input']),
    completion_tokens: num(t['output']) + num(t['thoughts']) + num(t['tool']),
    cached_tokens: num(t['cached']),
  };
}

/**
 * Build the reasoning string from a gemini message's `thoughts` array.
 * Mirrors Harbor's gemini converter (gemini_cli.py:250-262): each thought is
 * rendered as "subject: description" when both are present, the description
 * alone when there is no subject, and joined with '\n'. Returns undefined when
 * there are no thoughts with a description.
 */
function extractReasoning(message: GeminiMessage): string | undefined {
  const thoughts = message['thoughts'];
  if (!Array.isArray(thoughts)) return undefined;
  const parts: string[] = [];
  for (const thought of thoughts) {
    if (typeof thought !== 'object' || thought === null) continue;
    const t = thought as GeminiThought;
    const subject = typeof t.subject === 'string' ? t.subject : '';
    const description = typeof t.description === 'string' ? t.description : '';
    if (subject && description) parts.push(`${subject}: ${description}`);
    else if (description) parts.push(description);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Extract the message text from a gemini `content` field. Mirrors Harbor's
 * `_extract_text` (gemini_cli.py:206-215): a string is passed through; a list
 * joins each part's `text` (or `str(part)` for non-dicts) with '\n'; anything
 * else is stringified. Returns undefined for empty/whitespace-only text so a
 * content-less turn does not fabricate an empty message.
 */
function extractContentText(content: unknown): string | undefined {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === 'object' && part !== null) {
          const p = part as { text?: unknown };
          return typeof p.text === 'string' ? p.text : '';
        }
        return String(part);
      })
      .join('\n');
  } else if (content === undefined || content === null || content === '') {
    return undefined;
  } else {
    text = String(content);
  }
  return text.length > 0 ? text : undefined;
}

/**
 * Extract the human-readable observation text from a gemini tool call's
 * `result` array. Mirrors Harbor's gemini converter
 * (gemini_cli.py:286-359, text path only): reads
 * `result[].functionResponse.response.output`. Returns undefined when there is
 * no textual output. (Inline image parts are not modeled here — quorum's
 * transcript checks operate on text observations and tool calls.)
 */
function extractObservationContent(result: unknown): string | undefined {
  if (!Array.isArray(result)) return undefined;
  for (const item of result) {
    if (typeof item !== 'object' || item === null) continue;
    const funcResp = (item as { functionResponse?: unknown }).functionResponse;
    if (typeof funcResp !== 'object' || funcResp === null) continue;
    const response = (funcResp as { response?: unknown }).response;
    if (typeof response !== 'object' || response === null) continue;
    const output = (response as { output?: unknown }).output;
    if (typeof output === 'string' && output) return output;
  }
  return undefined;
}

/**
 * Reconstruct the canonical gemini message list from a session log.
 *
 * Ported from Harbor's `_load_gemini_session` (gemini_cli.py:436-497). The real
 * gemini-cli log is an event log, NOT the legacy `{messages: [...]}` envelope:
 *   - `$rewindTo <id>`: truncate the accumulated set back to that id (drop it
 *     and everything after). A `$rewindTo` to an UNKNOWN id clears EVERYTHING.
 *   - `$set <obj>`: metadata updates (we keep `sessionId`; a `messages` array is
 *     a fallback source when no bare rows exist).
 *   - bare `{id, type, ...}` rows: last-write-wins by id, first-seen order.
 *   - a top-level `{sessionId, ...}` row: metadata (excluding `messages`).
 *
 * Returns the reconstructed `{sessionId, messages}` shape. When the input is
 * already the legacy single-JSON `{messages: [...]}` envelope, it is returned
 * as-is. Falls back to the last `$set.messages` when no bare rows are present.
 */
interface ReconstructedSession {
  sessionId?: string;
  messages: GeminiMessage[];
}

function reconstructGeminiSession(raw: string): ReconstructedSession {
  // Legacy single-JSON envelope: a top-level object with a `messages` key.
  // Returned unchanged (the converter runs on its `messages` directly).
  try {
    const data = JSON.parse(raw) as unknown;
    if (
      typeof data === 'object' &&
      data !== null &&
      !Array.isArray(data) &&
      'messages' in (data as Record<string, unknown>)
    ) {
      const obj = data as Record<string, unknown>;
      const inner = obj['messages'];
      const messages: GeminiMessage[] = Array.isArray(inner)
        ? inner.filter(
            (m): m is GeminiMessage => typeof m === 'object' && m !== null,
          )
        : [];
      const out: ReconstructedSession = { messages };
      if (typeof obj['sessionId'] === 'string')
        out.sessionId = obj['sessionId'] as string;
      return out;
    }
    if (Array.isArray(data)) {
      // Plain JSON array of messages.
      return {
        messages: data.filter(
          (m): m is GeminiMessage => typeof m === 'object' && m !== null,
        ),
      };
    }
  } catch {
    // Not a single JSON document — fall through to the event-log path.
  }

  const metadata: Record<string, unknown> = {};
  // Ordered slots in first-seen order. An id-bearing row updates its slot in
  // place (last-write-wins, collapsing gemini-cli's running snapshots); an
  // id-less row appends a fresh slot (it cannot be deduped). `$rewindTo`
  // truncates by an id slot's position.
  const slots: GeminiMessage[] = [];
  const slotIndexById = new Map<string, number>();
  let setMessages: GeminiMessage[] | undefined;

  const truncateFrom = (idx: number) => {
    for (const removed of slots.slice(idx)) {
      const rid = removed['id'];
      if (typeof rid === 'string') slotIndexById.delete(rid);
    }
    slots.length = idx;
  };

  for (const line of raw.split('\n')) {
    const stripped = line.trim();
    if (!stripped) continue;
    let record: unknown;
    try {
      record = JSON.parse(stripped);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const r = record as Record<string, unknown>;

    if ('$rewindTo' in r) {
      const rewindId = r['$rewindTo'];
      const idx =
        typeof rewindId === 'string' ? (slotIndexById.get(rewindId) ?? -1) : -1;
      if (idx >= 0) {
        truncateFrom(idx);
      } else {
        // Unknown rewind target → clear everything (Harbor :471-474).
        truncateFrom(0);
      }
    } else if (
      '$set' in r &&
      typeof r['$set'] === 'object' &&
      r['$set'] !== null
    ) {
      const set = r['$set'] as Record<string, unknown>;
      for (const [k, v] of Object.entries(set)) metadata[k] = v;
      // Defensive fallback: remember the last $set.messages array.
      if (Array.isArray(set['messages'])) {
        setMessages = (set['messages'] as unknown[]).filter(
          (m): m is GeminiMessage => typeof m === 'object' && m !== null,
        );
      }
    } else if ('type' in r) {
      // A message row. id-bearing rows dedup last-write-wins; id-less rows
      // (legacy JSONL fixtures, snapshot lines without an id) append.
      const mid = r['id'];
      if (typeof mid === 'string') {
        const existing = slotIndexById.get(mid);
        if (existing !== undefined) {
          slots[existing] = r as GeminiMessage;
        } else {
          slotIndexById.set(mid, slots.length);
          slots.push(r as GeminiMessage);
        }
      } else {
        slots.push(r as GeminiMessage);
      }
    } else if ('sessionId' in r) {
      for (const [k, v] of Object.entries(r)) {
        if (k !== 'messages') metadata[k] = v;
      }
    }
  }

  // Bare rows reconstruct the canonical list. When there are none, fall back to
  // the last $set.messages (defensive vs a log-shape change, brief requirement).
  const messages: GeminiMessage[] =
    slots.length > 0 ? slots : (setMessages ?? []);

  const out: ReconstructedSession = { messages };
  if (typeof metadata['sessionId'] === 'string')
    out.sessionId = metadata['sessionId'] as string;
  return out;
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
 * The real gemini-cli log is a `$set`/`$rewindTo`/bare-row event log; we first
 * reconstruct the canonical message list (honoring rewind) and then convert.
 * Legacy single-JSON `{messages: [...]}` envelopes and plain JSON arrays are
 * also accepted.
 *
 * Each "gemini" (agent) message may carry text, reasoning (`thoughts`), a
 * `toolCalls` array (each with a `result` observation), `tokens`, and `model`.
 * Each tool call becomes its own agent step (with its observation on that same
 * step); the turn's reasoning/message/usage attach to the turn's first emitted
 * step (or a dedicated step when the turn emits no tool call). Duplicate tool
 * call ids across messages are deduplicated; a turn's usage is counted once per
 * distinct row id.
 */
export function normalizeGemini(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  const seenIds = new Set<string>();
  // gemini-cli rewrites a running `messages[]` snapshot, so a turn (same row
  // `id`) recurs with identical `tokens`. After reconstruction last-write-wins
  // collapses these by id, but a JSONL fixture may still present the same id
  // twice; dedup token accounting by row id so each turn is counted once.
  const seenTokenIds = new Set<string>();
  let stepId = 1;

  const { sessionId, messages } = reconstructGeminiSession(raw);

  for (const message of messages) {
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

    const reasoning = extractReasoning(message);
    const messageText = extractContentText(message['content']);

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

        // Attach this tool's observation to its OWN step so the ATIF
        // same-step source_call_id invariant holds.
        const obsContent = extractObservationContent(gtc.result);
        if (obsContent !== undefined) {
          const result: AtifObservationResult = { content: obsContent };
          if (atifTc.tool_call_id) result.source_call_id = atifTc.tool_call_id;
          const observation: AtifObservation = { results: [result] };
          step.observation = observation;
        }

        turnSteps.push(step);
        steps.push(step);
      }
    }

    // The turn's reasoning/message/usage attach to its first emitted tool-call
    // step. A turn that emits no tool step (text-only / reasoning-only / final
    // answer) gets a dedicated agent step so none of that is dropped.
    let carrier = turnSteps[0];
    const needsCarrier =
      carrier === undefined &&
      (metrics !== undefined ||
        reasoning !== undefined ||
        messageText !== undefined);
    if (needsCarrier) {
      carrier = { step_id: stepId++, source: 'agent' };
      if (timestamp) carrier.timestamp = timestamp;
      steps.push(carrier);
    }

    if (carrier) {
      if (messageText !== undefined) carrier.message = messageText;
      if (reasoning !== undefined) carrier.reasoning_content = reasoning;
      if (metrics) {
        carrier.metrics = metrics;
        if (modelName) carrier.model_name = modelName;
        carrier.extra = { ...carrier.extra, provider: 'google' };
      }
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
  if (sessionId) traj.session_id = sessionId;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeGemini produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
