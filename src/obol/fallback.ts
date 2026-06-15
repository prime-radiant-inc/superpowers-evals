import { readFileSync } from 'node:fs';
import type { TokenUsage } from '../contracts/economics.ts';

// ---------------------------------------------------------------------------
// Quorum-side coding-agent token math.
//
// obol prices session logs whose shape its Rust dialect understands. For some
// Coding-Agent versions the on-disk format has drifted past obol's parser
// (gemini-cli's per-message `tokens` block, opencode's session-export
// `messages[].info.tokens`), so obol returns zero tokens and the coding-agent
// economics block comes back null / `partial: true` — even though the real
// per-message usage is sitting right there in the log.
//
// These summers read that usage straight from the agent's own log and produce a
// TokenUsage with the model marked UNPRICED (est_cost_usd: null): we count the
// real tokens, we do not invent a price obol could not compute. estimateSessionLogs
// uses this only as a fallback, after obol returns null.
// ---------------------------------------------------------------------------

interface RawTokens {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Parse every non-blank JSONL row of a file; unreadable files and non-JSON
 *  lines contribute nothing. */
function jsonlRows(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

/** Parse a file as a single JSON value, or undefined on read/parse error. */
function jsonValue(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// A per-model accumulator. provider is whatever the agent stamped on the log.
interface ModelBucket {
  tokens: RawTokens;
  provider: string;
}

const ZERO: RawTokens = {
  input: 0,
  output: 0,
  cache_create: 0,
  cache_read: 0,
};

/** Add a contribution into the per-model map, accumulating tokens. */
function accumulate(
  perModel: Map<string, ModelBucket>,
  model: string,
  provider: string,
  tokens: RawTokens,
): void {
  const b = perModel.get(model) ?? { tokens: { ...ZERO }, provider };
  b.tokens.input += tokens.input;
  b.tokens.output += tokens.output;
  b.tokens.cache_create += tokens.cache_create;
  b.tokens.cache_read += tokens.cache_read;
  perModel.set(model, b);
}

// gemini-cli writes one JSONL row per assistant turn (sometimes twice per turn:
// once before and once after tool calls, sharing the row `id`). Each carries a
// `tokens` block { input, output, cached, thoughts, tool, total } and `model`.
// Dedup by id so a turn is counted once; fold reasoning (`thoughts`) into output.
function geminiTokens(files: readonly string[]): Map<string, ModelBucket> {
  const perModel = new Map<string, ModelBucket>();
  const seen = new Set<string>();
  for (const file of files) {
    for (const row of jsonlRows(file)) {
      if (!isObject(row) || row['type'] !== 'gemini') {
        continue;
      }
      const tok = row['tokens'];
      if (!isObject(tok)) {
        continue;
      }
      const id = typeof row['id'] === 'string' ? row['id'] : null;
      if (id !== null) {
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
      }
      const model = typeof row['model'] === 'string' ? row['model'] : 'unknown';
      accumulate(perModel, model, 'google', {
        input: num(tok['input']),
        output: num(tok['output']) + num(tok['thoughts']),
        cache_create: 0,
        cache_read: num(tok['cached']),
      });
    }
  }
  return perModel;
}

// opencode writes a session export: a single JSON object { info, messages }.
// Each assistant message carries info.tokens { input, output, reasoning,
// cache: { read, write } } and info.model / info.provider. Sum the assistant
// messages; fold reasoning into output.
function opencodeTokens(files: readonly string[]): Map<string, ModelBucket> {
  const perModel = new Map<string, ModelBucket>();
  for (const file of files) {
    const root = jsonValue(file);
    if (!isObject(root)) {
      continue;
    }
    const messages = root['messages'];
    if (!Array.isArray(messages)) {
      continue;
    }
    for (const msg of messages) {
      if (!isObject(msg)) {
        continue;
      }
      const info = isObject(msg['info']) ? msg['info'] : msg;
      if (info['role'] !== 'assistant') {
        continue;
      }
      const tok = info['tokens'];
      if (!isObject(tok)) {
        continue;
      }
      const cache = isObject(tok['cache']) ? tok['cache'] : {};
      // opencode session exports stamp the model on the assistant message as
      // `modelID` / `providerID`.
      const model =
        typeof info['modelID'] === 'string'
          ? info['modelID']
          : typeof info['model'] === 'string'
            ? info['model']
            : 'unknown';
      const provider =
        typeof info['providerID'] === 'string'
          ? info['providerID']
          : typeof info['provider'] === 'string'
            ? info['provider']
            : 'unknown';
      accumulate(perModel, model, provider, {
        input: num(tok['input']),
        output: num(tok['output']) + num(tok['reasoning']),
        cache_create: num(cache['write']),
        cache_read: num(cache['read']),
      });
    }
  }
  return perModel;
}

type Summer = (files: readonly string[]) => Map<string, ModelBucket>;

// Families whose logs carry real token usage that obol's dialect cannot parse.
// Each summer reads the usage straight from the agent's own log.
const SUMMERS: Record<string, Summer> = {
  gemini: geminiTokens,
  opencode: opencodeTokens,
};

/** Build a TokenUsage from a per-model accumulator, with every model marked
 *  unpriced. Returns null when no tokens were counted. */
function toTokenUsage(perModel: Map<string, ModelBucket>): TokenUsage | null {
  const totals: RawTokens = { ...ZERO };
  for (const b of perModel.values()) {
    totals.input += b.tokens.input;
    totals.output += b.tokens.output;
    totals.cache_create += b.tokens.cache_create;
    totals.cache_read += b.tokens.cache_read;
  }
  const totalTokens =
    totals.input + totals.output + totals.cache_create + totals.cache_read;
  if (totalTokens === 0) {
    return null;
  }

  const models: TokenUsage['models'] = {};
  let topModel: string | null = null;
  let topTokens = -1;
  for (const [name, b] of perModel) {
    const modelTokens =
      b.tokens.input +
      b.tokens.output +
      b.tokens.cache_create +
      b.tokens.cache_read;
    models[name] = {
      total_input: b.tokens.input,
      total_cache_create: b.tokens.cache_create,
      total_cache_read: b.tokens.cache_read,
      total_output: b.tokens.output,
      total_tokens: modelTokens,
      provider: b.provider,
      est_cost_usd: null,
    };
    if (modelTokens > topTokens) {
      topTokens = modelTokens;
      topModel = name;
    }
  }

  return {
    total_input: totals.input,
    total_cache_create: totals.cache_create,
    total_cache_read: totals.cache_read,
    total_output: totals.output,
    total_tokens: totalTokens,
    model: topModel,
    models,
    est_cost_usd: null,
    unpriced_models: [...perModel.keys()].sort(),
    approximations: [],
    pricing_as_of: null,
  };
}

/** Sum the Coding-Agent's own per-message token usage from its session logs,
 *  for the families obol cannot price (gemini, opencode). Every model is left
 *  unpriced (est_cost_usd: null). Returns null for a family with no summer or
 *  when the logs carry no token usage. */
export function sumCodingAgentTokens(
  family: string,
  files: readonly string[],
): TokenUsage | null {
  const summer = SUMMERS[family];
  if (summer === undefined || files.length === 0) {
    return null;
  }
  return toTokenUsage(summer(files));
}
