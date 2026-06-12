import { existsSync } from 'node:fs';
import {
  type CostEstimate,
  type Dialect,
  estimatePath,
  ObolError,
} from '@primeradianthq/obol';
import type { TokenUsage } from '../contracts/economics.ts';

/** Backend family (normalizer name) -> obol dialect. Identity for the 7 priced
 *  dialects; the `obol` dialect is reserved for the gauntlet usage sidecar. */
export const DIALECTS: Record<string, Dialect> = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  gemini: 'gemini',
  kimi: 'kimi',
  opencode: 'opencode',
  pi: 'pi',
};

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
    pricingAsOf = pricingAsOf ?? est.pricing_as_of;
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

/** Price each new session log with obol and merge. Maps `family` to its obol
 *  dialect; returns null for unknown families, empty input, or any ObolError. */
export async function estimateSessionLogs(
  family: string,
  files: readonly string[],
): Promise<TokenUsage | null> {
  const dialect = DIALECTS[family];
  if (dialect === undefined || files.length === 0) {
    return null;
  }
  const estimates: CostEstimate[] = [];
  try {
    for (const f of files) {
      estimates.push(await estimatePath(f, dialect));
    }
  } catch (e) {
    if (e instanceof ObolError) {
      return null;
    }
    throw e;
  }
  return mergeEstimates(estimates);
}

/** Price the gauntlet usage sidecar (obol's own `obol` dialect). Returns null
 *  if the file is absent or obol rejects it (ObolError). */
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
