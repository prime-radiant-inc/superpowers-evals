import {
  appendNativeLine,
  type NativeBoundary,
  type NativeChildEvidence,
  type NativeToolResultEvidence,
  nativeRecordBytes,
  nativeTextBytes,
  withNativeEvidence,
} from '../atif/provenance.ts';
import {
  ATIF_SCHEMA_VERSION,
  type AtifAgent,
  type AtifMetrics,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Populate an agent step's ATIF usage from a Claude assistant message's
 * `usage` block (and `model`). Mapping per the ATIF usage contract:
 *   input_tokens               → metrics.prompt_tokens
 *   output_tokens              → metrics.completion_tokens
 *   cache_read_input_tokens    → metrics.cached_tokens
 *   cache_creation_input_tokens→ extra.cache_write
 * No per-message cost is logged by Claude; cost is priced downstream by obol.
 *
 * Buckets stay DISJOINT (no overlap): prompt_tokens is the uncached input
 * only, NOT Harbor's inclusive `input + cache_read + cache_creation` sum.
 *
 * `usage` is the resolved usage block to charge (which may differ from
 * `message.usage` when a message.id is re-emitted across rows — the caller
 * supplies the last-seen snapshot). Pass `undefined` to record the model only
 * and skip usage entirely (used to suppress double-counting on a repeat row).
 */
function applyClaudeUsage(
  step: AtifStep,
  message: Record<string, unknown>,
  usage: ClaudeUsage | undefined,
  evidence?: { line: number; timestamp?: string },
) {
  const model = message['model'];
  if (typeof model === 'string' && model) step.model_name = model;

  if (!usage) return;
  const u = usage;

  const metrics: AtifMetrics = {};
  if (typeof u.input_tokens === 'number')
    metrics.prompt_tokens = u.input_tokens;
  if (typeof u.output_tokens === 'number')
    metrics.completion_tokens = u.output_tokens;
  if (typeof u.cache_read_input_tokens === 'number')
    metrics.cached_tokens = u.cache_read_input_tokens;
  if (Object.keys(metrics).length > 0) {
    if (evidence) {
      metrics.extra = withNativeEvidence(undefined, {
        lines: [evidence.line],
        ...(evidence.timestamp ? { timestamp: evidence.timestamp } : {}),
      });
    }
    step.metrics = metrics;
  }

  if (typeof u.cache_creation_input_tokens === 'number') {
    step.extra = { ...step.extra, cache_write: u.cache_creation_input_tokens };
  }
}

/**
 * claude-code re-emits a running snapshot of an in-flight assistant turn: the
 * same `message.id` recurs across several session-log rows, each carrying the
 * turn's `usage`. Summing every row triple-counts tokens. Build a map of the
 * LAST usage seen per message.id (the most-complete streaming snapshot — the
 * Harbor oracle's rule) so each turn's usage is charged exactly once.
 */
interface LocatedEntry {
  entry: Entry;
  line: number;
  recordBytes: number;
}

interface LocatedUsage {
  usage: ClaudeUsage;
  line: number;
  timestamp?: string;
}

function lastUsageByMessageId(
  entries: LocatedEntry[],
): Map<string, LocatedUsage> {
  const lastUsage = new Map<string, LocatedUsage>();
  for (const located of entries) {
    const { entry } = located;
    if (entry['type'] !== 'assistant') continue;
    const message = entry['message'];
    if (!message || typeof message !== 'object') continue;
    const m = message as Record<string, unknown>;
    const id = m['id'];
    const usage = m['usage'];
    if (typeof id === 'string' && id && usage && typeof usage === 'object') {
      const timestamp = entry['timestamp'];
      lastUsage.set(id, {
        usage: usage as ClaudeUsage,
        line: located.line,
        ...(typeof timestamp === 'string' ? { timestamp } : {}),
      });
    }
  }
  return lastUsage;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

type Entry = Record<string, unknown>;

function userOrigin(entry: Entry): 'human' | 'injected' | 'parent' | 'unknown' {
  if (entry['isSidechain'] === true) return 'parent';

  const nativeOrigin = entry['origin'];
  const kind =
    nativeOrigin && typeof nativeOrigin === 'object'
      ? (nativeOrigin as Record<string, unknown>)['kind']
      : undefined;
  const human =
    kind === 'human' ||
    (entry['promptSource'] === 'typed' && entry['userType'] === 'external');
  const injected =
    kind === 'injected' ||
    (entry['isMeta'] === true &&
      typeof entry['sourceToolUseID'] === 'string' &&
      entry['sourceToolUseID'].length > 0);

  if (human === injected) return 'unknown';
  return human ? 'human' : 'injected';
}

function blocksOf(entry: Entry): Block[] {
  const message = entry['message'];
  if (
    message &&
    typeof message === 'object' &&
    Array.isArray((message as { content?: unknown }).content)
  ) {
    return (message as { content: Block[] }).content;
  }
  return [];
}

/** json.dumps(value, ensure_ascii=False) for a non-string; passthrough for a
 *  string. Mirrors Harbor's `_stringify`. */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Split an assistant message's content blocks into the joined text, the joined
 * reasoning, and the raw tool_use blocks. Mirrors Harbor's
 * `_extract_text_reasoning_tool_uses` (claude_code.py:396-480):
 *   - `thinking` / `reasoning` / `analysis` blocks → reasoning, reading the
 *     `text` key when present (Goose style) else `thinking`.
 *   - everything else with a string `text` → message text.
 *   - text and reasoning parts are each stripped and joined with '\n\n'.
 */
function extractAssistant(blocks: Block[]): {
  text: string;
  reasoning: string;
  toolBlocks: Block[];
} {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolBlocks: Block[] = [];

  for (const block of blocks) {
    const blockType = block.type;
    if (blockType === 'tool_use') {
      toolBlocks.push(block);
      continue;
    }
    if (
      blockType === 'thinking' ||
      blockType === 'reasoning' ||
      blockType === 'analysis'
    ) {
      // Prefer the `text` key when it is present (even if empty) — only fall
      // back to `thinking` when `text` is absent.
      const value = block.text !== undefined ? block.text : block.thinking;
      reasoningParts.push(typeof value === 'string' ? value : stringify(value));
      continue;
    }
    if (typeof block.text === 'string') {
      textParts.push(block.text);
    } else {
      textParts.push(stringify(block));
    }
  }

  const text = textParts
    .map((p) => p.trim())
    .filter((p) => p)
    .join('\n\n');
  const reasoning = reasoningParts
    .map((p) => p.trim())
    .filter((p) => p)
    .join('\n\n');

  return { text, reasoning, toolBlocks };
}

interface ToolUseResult {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  exit_code?: unknown;
  interrupted?: unknown;
  isImage?: unknown;
  [key: string]: unknown;
}

const TOOL_USE_RESULT_FORMATTED_KEYS = new Set([
  'stdout',
  'stderr',
  'exitCode',
  'exit_code',
  'interrupted',
  'isImage',
]);

/**
 * Render a tool_result block (plus its sibling top-level `toolUseResult`) into
 * the human-readable observation string. Mirrors Harbor's `_format_tool_result`
 * (claude_code.py:516-587): the content, then the stdout/stderr/exit_code/
 * interrupted/is_image chunks, then any remaining metadata, then an `[error]`
 * marker when the block reported failure.
 */
function formatToolResult(
  block: Block,
  toolUseResult: ToolUseResult | undefined,
): string | undefined {
  const parts: string[] = [];

  const content = block.content;
  if (typeof content === 'string') {
    if (content.trim()) parts.push(content.trim());
  } else if (Array.isArray(content)) {
    for (const item of content) {
      const value = stringify(item);
      if (value.trim()) parts.push(value.trim());
    }
  } else if (content !== undefined && content !== null && content !== '') {
    parts.push(stringify(content));
  }

  if (toolUseResult && typeof toolUseResult === 'object') {
    const tur = toolUseResult;
    const stdout = tur.stdout;
    const stderr = tur.stderr;
    const exitCode = tur.exitCode ?? tur.exit_code;
    const interrupted = tur.interrupted;
    const isImage = tur.isImage;

    const chunks: string[] = [];
    if (stdout) chunks.push(`[stdout]\n${stdout}`.replace(/\s+$/, ''));
    if (stderr) chunks.push(`[stderr]\n${stderr}`.replace(/\s+$/, ''));
    if (exitCode !== undefined && exitCode !== null && exitCode !== 0)
      chunks.push(`[exit_code] ${exitCode}`);
    if (interrupted) chunks.push(`[interrupted] ${interrupted}`);
    if (isImage) chunks.push(`[is_image] ${isImage}`);

    const remaining: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(tur)) {
      if (!TOOL_USE_RESULT_FORMATTED_KEYS.has(key)) remaining[key] = value;
    }
    if (Object.keys(remaining).length > 0) {
      chunks.push(`[metadata] ${JSON.stringify(remaining)}`);
    }

    const joined = chunks.filter((c) => c).join('\n');
    if (joined) parts.push(joined);
  }

  if (block.is_error === true) {
    parts.push('[error] tool reported failure');
  }

  const resultText = parts
    .filter((p) => p)
    .join('\n\n')
    .trim();
  return resultText || undefined;
}

/** Collect a deterministic, sorted set of one string field across entries. */
function sortedDistinct(entries: Entry[], field: string): string[] {
  const set = new Set<string>();
  for (const entry of entries) {
    const value = entry[field];
    if (typeof value === 'string' && value) set.add(value);
  }
  return [...set].sort();
}

/**
 * Drop events whose `uuid` repeats — claude-code replays old session events
 * after a `compact_boundary`, and a replayed tool_result / assistant row would
 * otherwise double-count its observation and usage. First occurrence wins.
 * Mirrors Harbor's global uuid dedup (claude_code.py:645-657). Events without
 * a uuid are always kept.
 */
function dedupByUuid(entries: LocatedEntry[]): LocatedEntry[] {
  const seen = new Set<string>();
  const out: LocatedEntry[] = [];
  for (const located of entries) {
    const { entry } = located;
    const uuid = entry['uuid'];
    if (typeof uuid === 'string' && uuid) {
      if (seen.has(uuid)) continue;
      seen.add(uuid);
    }
    out.push(located);
  }
  return out;
}

/**
 * Convert a legacy Claude-Code session log (the `~/.claude/projects/.../*.jsonl`
 * layout) into an ATIF v1.7 trajectory.
 *
 * Fidelity (Harbor-equivalent): uuid dedup, turn-bundling by message.id (one
 * LLM inference == one step: text + reasoning + every tool_use share a step),
 * rich tool_result observations, reasoning from thinking/reasoning/analysis
 * blocks, byte-faithful message text, and agent.version + agent.extra read from
 * the log. Token buckets stay DISJOINT and usage is charged once per message.id.
 */
export function normalizeClaudeLegacy(
  raw: string,
  version: string,
  onMalformedLine?: (line: number, message: string) => void,
): AtifTrajectory {
  // Parse all lines first so uuid dedup and the usage map see the same events.
  const parsed: LocatedEntry[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      parsed.push({
        entry: JSON.parse(line) as Entry,
        line: index + 1,
        recordBytes: nativeRecordBytes(line),
      });
    } catch (error) {
      // Tolerate blank / unparseable lines — skip them.
      onMalformedLine?.(
        index + 1,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const entries = dedupByUuid(parsed);

  const steps: AtifStep[] = [];
  const callIndex = new Map<string, AtifStep>();
  // Maps an assistant `message.id` to the single step it bundles, so text /
  // reasoning / every tool_use from one LLM inference land on one step even
  // when the session log splits them across rows.
  const turnByMsgId = new Map<string, AtifStep>();
  const lastUsage = lastUsageByMessageId(entries);
  const usageChargedMsgIds = new Set<string>();
  const seenToolCallIds = new Set<string>();

  // Read agent.version (first non-empty log version) + agent.extra.
  let agentVersion = version;
  for (const { entry } of entries) {
    const ver = entry['version'];
    if (typeof ver === 'string' && ver) {
      agentVersion = ver;
      break;
    }
  }
  // session_id: read from the first row that carries a non-empty sessionId field.
  let sessionId: string | undefined;
  for (const { entry } of entries) {
    const sid = entry['sessionId'];
    if (typeof sid === 'string' && sid) {
      sessionId = sid;
      break;
    }
  }
  const nativeEntries = entries.map(({ entry }) => entry);
  const cwds = sortedDistinct(nativeEntries, 'cwd');
  const gitBranches = sortedDistinct(nativeEntries, 'gitBranch');
  const agentIds = sortedDistinct(nativeEntries, 'agentId');
  const agentExtra: Record<string, unknown> = {};
  const boundaries: NativeBoundary[] = [];
  if (cwds.length) agentExtra['cwds'] = cwds;
  if (gitBranches.length) agentExtra['git_branches'] = gitBranches;
  if (agentIds.length) agentExtra['agent_ids'] = agentIds;
  if (nativeEntries.some((entry) => entry['isSidechain'] === true))
    agentExtra['is_sidechain'] = true;
  for (const { entry, line } of entries) {
    if (
      entry['type'] !== 'system' ||
      !['compact_boundary', 'turn_duration'].includes(String(entry['subtype']))
    )
      continue;
    const turnDuration = entry['subtype'] === 'turn_duration';
    const durationMs = entry['durationMs'];
    const timestamp = entry['timestamp'];
    boundaries.push({
      kind: turnDuration ? 'turn' : 'compaction',
      ...(turnDuration ? { phase: 'complete' as const } : {}),
      ...(turnDuration &&
      typeof durationMs === 'number' &&
      Number.isFinite(durationMs) &&
      durationMs >= 0
        ? { durationMs }
        : {}),
      evidence: {
        lines: [line],
        ...(typeof timestamp === 'string' ? { timestamp } : {}),
      },
    });
  }

  for (const { entry, line, recordBytes } of entries) {
    const type = entry['type'];
    const blocks = blocksOf(entry);

    if (type === 'assistant') {
      const { text, reasoning, toolBlocks } = extractAssistant(blocks);
      const message = entry['message'];
      const m =
        message && typeof message === 'object'
          ? (message as Record<string, unknown>)
          : {};
      const msgId = typeof m['id'] === 'string' ? (m['id'] as string) : null;

      // Bundle one LLM inference into a single step. Reuse the step when the
      // same truthy message.id recurs across rows; id-less rows each get a
      // fresh step (legacy behaviour).
      let step = msgId ? (turnByMsgId.get(msgId) ?? null) : null;
      const isNewStep = step === null;
      if (step === null) {
        step = {
          step_id: steps.length + 1,
          source: 'agent',
          extra: withNativeEvidence(undefined, { lines: [line] }),
        };
        if (typeof entry['timestamp'] === 'string')
          step.timestamp = entry['timestamp'];
        steps.push(step);
        if (msgId) turnByMsgId.set(msgId, step);
      } else {
        step.extra = appendNativeLine(step.extra, line);
      }

      if (text)
        step.message = step.message ? `${step.message}\n\n${text}` : text;
      if (reasoning)
        step.reasoning_content = step.reasoning_content
          ? `${step.reasoning_content}\n\n${reasoning}`
          : reasoning;

      for (const b of toolBlocks) {
        const callId = b.id ?? b.tool_use_id ?? '';
        if (callId && seenToolCallIds.has(callId)) continue;
        if (callId) seenToolCallIds.add(callId);
        const call: AtifToolCall = {
          tool_call_id: callId,
          function_name: b.name ?? '',
          arguments: b.input ?? {},
          extra: withNativeEvidence(undefined, { lines: [line] }),
        };
        if (call.function_name === 'Agent') {
          call.extra = {
            ...call.extra,
            quorum_child: {
              relationship: 'spawned',
            } satisfies NativeChildEvidence,
          };
        }
        step.tool_calls ??= [];
        step.tool_calls.push(call);
        callIndex.set(call.tool_call_id, step);
      }

      // Charge usage once per message.id (the last/most-complete snapshot).
      // Only the first row of a bundled turn carries the usage; later rows of
      // the same id keep the model name but contribute no tokens. Rows with no
      // id always charge their own usage.
      let usage: ClaudeUsage | undefined;
      let usageEvidence: { line: number; timestamp?: string } | undefined;
      if (msgId === null) {
        const u = m['usage'];
        usage = u && typeof u === 'object' ? (u as ClaudeUsage) : undefined;
        const timestamp = entry['timestamp'];
        if (usage)
          usageEvidence = {
            line,
            ...(typeof timestamp === 'string' ? { timestamp } : {}),
          };
      } else if (isNewStep && !usageChargedMsgIds.has(msgId)) {
        usageChargedMsgIds.add(msgId);
        const located = lastUsage.get(msgId);
        usage = located?.usage ?? (m['usage'] as ClaudeUsage | undefined);
        usageEvidence = located
          ? {
              line: located.line,
              ...(located.timestamp ? { timestamp: located.timestamp } : {}),
            }
          : { line };
      }
      applyClaudeUsage(step, m, usage, usageEvidence);
      continue;
    }

    if (type === 'tool_use') {
      // A flat top-level entry that is itself a tool_use block.
      const step: AtifStep = {
        step_id: steps.length + 1,
        source: 'agent',
        extra: withNativeEvidence(undefined, { lines: [line] }),
      };
      if (typeof entry['timestamp'] === 'string')
        step.timestamp = entry['timestamp'];
      const call: AtifToolCall = {
        tool_call_id: (entry['id'] as string | undefined) ?? '',
        function_name: (entry['name'] as string | undefined) ?? '',
        arguments:
          (entry['input'] as Record<string, unknown> | undefined) ?? {},
        extra: withNativeEvidence(undefined, { lines: [line] }),
      };
      step.tool_calls = [call];
      callIndex.set(call.tool_call_id, step);
      steps.push(step);
      continue;
    }

    if (type === 'user') {
      const ts =
        typeof entry['timestamp'] === 'string' ? entry['timestamp'] : undefined;
      const message = (entry['message'] as { content?: unknown } | undefined)
        ?.content;

      // String-form content: byte-faithful (no whitespace mutation), skipping
      // empty / whitespace-only.
      if (typeof message === 'string') {
        if (message.trim()) {
          const userStep: AtifStep = {
            step_id: steps.length + 1,
            source: 'user',
            message,
            extra: withNativeEvidence(undefined, {
              lines: [line],
              origin: userOrigin(entry),
            }),
          };
          if (ts) userStep.timestamp = ts;
          steps.push(userStep);
        }
        continue;
      }

      const toolUseResult = entry['toolUseResult'] as ToolUseResult | undefined;
      const results: AtifObservationResult[] = [];
      const texts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const result: AtifObservationResult = {};
          if (b.tool_use_id) result.source_call_id = b.tool_use_id;
          const formatted = formatToolResult(b, toolUseResult);
          if (formatted !== undefined) result.content = formatted;
          const contentBytes = nativeTextBytes(b.content);
          result.extra = withNativeEvidence(undefined, {
            lines: [line],
            origin: 'unknown',
            recordBytes,
            ...(ts ? { timestamp: ts } : {}),
            ...(contentBytes !== undefined ? { contentBytes } : {}),
          });
          const exitCode = toolUseResult?.exitCode ?? toolUseResult?.exit_code;
          const resultEvidence: NativeToolResultEvidence = {};
          if (
            b.is_error === true ||
            toolUseResult?.interrupted === true ||
            (typeof exitCode === 'number' &&
              Number.isInteger(exitCode) &&
              exitCode !== 0)
          )
            resultEvidence.isError = true;
          else if (b.is_error === false || exitCode === 0)
            resultEvidence.isError = false;
          const durationMs = toolUseResult?.['totalDurationMs'];
          if (
            typeof durationMs === 'number' &&
            Number.isFinite(durationMs) &&
            durationMs >= 0
          )
            resultEvidence.durationMs = durationMs;
          if (Object.keys(resultEvidence).length)
            result.extra = { ...result.extra, quorum_result: resultEvidence };
          const childId = toolUseResult?.['agentId'];
          if (typeof childId === 'string' && childId) {
            const child: NativeChildEvidence = {
              relationship: 'spawned',
              id: childId,
            };
            result.extra = { ...result.extra, quorum_child: child };
            const owner = b.tool_use_id
              ? callIndex.get(b.tool_use_id)
              : undefined;
            const ownerCall = owner?.tool_calls?.find(
              (candidate) => candidate.tool_call_id === b.tool_use_id,
            );
            if (ownerCall?.function_name === 'Agent') {
              ownerCall.extra = { ...ownerCall.extra, quorum_child: child };
            }
          }
          results.push(result);
        } else if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        } else if (b.type !== undefined) {
          // Non-text, non-tool_result block (e.g. image): json-encode it.
          texts.push(stringify(b));
        }
      }

      // Attach tool_results to their owning agent step (same step holds the
      // tool_call, satisfying the ATIF same-step observation invariant).
      for (const r of results) {
        const owner = r.source_call_id
          ? callIndex.get(r.source_call_id)
          : undefined;
        if (owner) {
          owner.observation ??= { results: [] };
          owner.observation.results.push(r);
        }
      }

      // Byte-faithful join of the user text parts, filtering empty parts.
      const textMessage = texts.filter((p) => p.trim()).join('\n\n');
      if (textMessage) {
        const userStep: AtifStep = {
          step_id: steps.length + 1,
          source: 'user',
          message: textMessage,
          extra: withNativeEvidence(undefined, {
            lines: [line],
            origin: userOrigin(entry),
          }),
        };
        if (ts) userStep.timestamp = ts;
        steps.push(userStep);
      }
    }
  }

  const agent: AtifAgent = { name: 'claude-code', version: agentVersion };
  if (Object.keys(agentExtra).length > 0) agent.extra = agentExtra;

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent,
    steps,
  };
  if (sessionId) traj.session_id = sessionId;
  if (boundaries.length > 0)
    traj.extra = { ...traj.extra, quorum_boundaries: boundaries };
  return traj;
}
