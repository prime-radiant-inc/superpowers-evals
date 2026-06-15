import { existsSync, readFileSync } from 'node:fs';
import {
  type CostEstimate,
  estimatePath,
  ObolError,
} from '@primeradianthq/obol';
import type { TokenUsage } from '../contracts/economics.ts';

const BUCKET_KEYS = [
  'total_input',
  'total_cache_create',
  'total_cache_read',
  'total_output',
] as const;

const round10 = (n: number): number => Math.round(n * 1e10) / 1e10;

interface Bucket {
  total_input: number;
  total_cache_create: number;
  total_cache_read: number;
  total_output: number;
  provider: string;
  subtotal_usd: number;
}

/** Sum per-model token buckets and subtotals across obol estimates into one
 *  TokenUsage. obol's `tokens.cache_write` maps to our `total_cache_create`.
 *  Approximations dedupe by a (kind, detail) tuple key (null != ""). Keeps the
 *  first non-null `pricing_as_of`. Returns null when no tokens were counted.
 *  Costs round to 10 decimals; `est_cost_usd` is null when every priced model
 *  is unpriced. */
export function mergeEstimates(
  estimates: readonly CostEstimate[],
): TokenUsage | null {
  const perModel = new Map<string, Bucket>();
  const unpriced = new Set<string>();
  const approximations: { kind: string; detail: string | null }[] = [];
  const seenApprox = new Set<string>();
  let pricingAsOf: string | null = null;

  for (const est of estimates) {
    // Keep the first TRUTHY pricing_as_of (parity with Python's `or`): an
    // empty-string from an earlier estimate is skipped for a later real date.
    pricingAsOf = pricingAsOf || est.pricing_as_of;
    for (const m of est.unpriced_models) {
      unpriced.add(m);
    }
    for (const a of est.approximations) {
      const detail = a.detail ?? null; // boundary: obol's optional -> our null
      const key = JSON.stringify([a.kind, detail]); // tuple key: null != ""
      if (!seenApprox.has(key)) {
        seenApprox.add(key);
        approximations.push({ kind: a.kind, detail });
      }
    }
    for (const mc of est.per_model) {
      const b = perModel.get(mc.model) ?? {
        total_input: 0,
        total_cache_create: 0,
        total_cache_read: 0,
        total_output: 0,
        provider: mc.provider,
        subtotal_usd: 0,
      };
      b.total_input += mc.tokens.input;
      b.total_cache_create += mc.tokens.cache_write;
      b.total_cache_read += mc.tokens.cache_read;
      b.total_output += mc.tokens.output;
      b.subtotal_usd += mc.subtotal_usd;
      perModel.set(mc.model, b);
    }
  }

  const totals = {
    total_input: 0,
    total_cache_create: 0,
    total_cache_read: 0,
    total_output: 0,
  };
  for (const b of perModel.values()) {
    for (const k of BUCKET_KEYS) {
      totals[k] += b[k];
    }
  }
  const totalTokens = BUCKET_KEYS.reduce((s, k) => s + totals[k], 0);
  if (totalTokens === 0) {
    return null;
  }

  const allUnpriced =
    perModel.size > 0 && [...perModel.keys()].every((m) => unpriced.has(m));
  const models: TokenUsage['models'] = {};
  let topModel: string | null = null;
  let topCost = -1;
  let totalUsd = 0;
  for (const [name, b] of perModel) {
    const tokens =
      b.total_input +
      b.total_cache_create +
      b.total_cache_read +
      b.total_output;
    models[name] = {
      total_input: b.total_input,
      total_cache_create: b.total_cache_create,
      total_cache_read: b.total_cache_read,
      total_output: b.total_output,
      total_tokens: tokens,
      provider: b.provider,
      est_cost_usd: unpriced.has(name) ? null : round10(b.subtotal_usd),
    };
    totalUsd += b.subtotal_usd;
    if (b.subtotal_usd > topCost) {
      topCost = b.subtotal_usd;
      topModel = name;
    }
  }

  return {
    ...totals,
    total_tokens: totalTokens,
    model: topModel,
    models,
    est_cost_usd: allUnpriced ? null : round10(totalUsd),
    unpriced_models: [...unpriced].sort(),
    approximations,
    pricing_as_of: pricingAsOf,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sum the UTF-8 byte length of every tool.result output string in a kimi wire
 *  log: context.append_loop_event rows whose event.type is "tool.result" and
 *  whose result.output is a string. Unreadable files, blank/non-JSON lines, and
 *  rows of any other shape contribute zero. Ports
 *  quorum/obol_capture.py _kimi_tool_result_total_bytes. */
export function kimiToolResultTotalBytes(file: string): number {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(row) || row['type'] !== 'context.append_loop_event') {
      continue;
    }
    const event = row['event'];
    if (!isObject(event) || event['type'] !== 'tool.result') {
      continue;
    }
    const result = event['result'];
    if (!isObject(result)) {
      continue;
    }
    const output = result['output'];
    if (typeof output === 'string') {
      total += Buffer.byteLength(output, 'utf8');
    }
  }
  return total;
}

/** Price the run's ATIF trajectory.json via obol's `"atif"` dialect. obol reads
 *  the trajectory directly: it honors an embedded per-step `cost_usd` (opencode,
 *  pi) and otherwise prices the token buckets with its rate tables; a model with
 *  no rate surfaces as unpriced (est_cost_usd null, tokens kept). Returns null
 *  when the file is absent, obol rejects it (ObolError), or the trajectory
 *  carries no usage (antigravity). This is the ONLY coding-agent token source:
 *  the normalizers fill the trajectory's metrics, no raw log is re-parsed. */
export async function estimateTrajectory(
  path: string,
): Promise<TokenUsage | null> {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return mergeEstimates([await estimatePath(path, 'atif')]);
  } catch (e) {
    if (e instanceof ObolError) {
      return null;
    }
    throw e;
  }
}

/** Price the gauntlet usage sidecar (obol's own `obol` dialect). Returns null
 *  if the file is absent or obol rejects it (ObolError). This is the QA-driver
 *  (Gauntlet-Agent) measurement-overhead side, not a coding-agent log. */
export async function estimateUsageSidecar(
  path: string,
): Promise<TokenUsage | null> {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return mergeEstimates([await estimatePath(path, 'obol')]);
  } catch (e) {
    if (e instanceof ObolError) {
      return null;
    }
    throw e;
  }
}
