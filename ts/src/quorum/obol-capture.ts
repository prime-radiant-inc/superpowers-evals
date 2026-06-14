/**
 * All quorum↔obol traffic: estimate session logs / usage sidecars, merge, re-shape.
 *
 * Port of quorum/obol_capture.py — preserves the frozen-artifact output dict shape
 * exactly, including field names and null semantics.
 *
 * obol owns parsing and pricing; this module owns the quorum-side dict shape that
 * freezes into run artifacts. estimate_path is single-file, so multi-file runs
 * (Claude subagents write sibling JSONLs) merge here — plain addition over obol's
 * outputs, never token math of our own.
 *
 * Capture is best-effort measurement: expected failure paths return null —
 * never a silent $0. (Only ObolError is caught; exotic OS errors can still
 * propagate.) Line-oriented dialect parsers skip unparseable content (a garbage
 * sibling file contributes zero, matching pre-obol behavior); ObolError covers
 * structural failures like missing pricing tables or sidecar schema rejection.
 */

import * as fs from "fs";
import {
  estimatePath,
  ObolError,
  type CostEstimate,
} from "@primeradianthq/obol";

// quorum normalizer name -> obol dialect. Covers every backend dialect obol
// knows (the eighth, `obol`, is the sidecar format, not a backend); backends
// absent here (antigravity) simply aren't priced. A mapped backend whose log
// format diverges from obol's parser degrades to null at parse time, so
// listing one costs nothing.
export const DIALECTS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  copilot: "copilot",
  gemini: "gemini",
  kimi: "kimi",
  opencode: "opencode",
  pi: "pi",
};

const BUCKET_KEYS = [
  "total_input",
  "total_cache_create",
  "total_cache_read",
  "total_output",
] as const;

type BucketKey = (typeof BUCKET_KEYS)[number];

function emptyBucket(): Record<BucketKey, number> {
  return {
    total_input: 0,
    total_cache_create: 0,
    total_cache_read: 0,
    total_output: 0,
  };
}

/**
 * Sum obol CostEstimates into the frozen-artifact dict shape.
 *
 * Cost is additive across files, so summing subtotals is exact — no
 * re-pricing happens here. Returns null when the merged result carries no
 * usage at all (parsable files with zero usage rows produce no artifact).
 *
 * Port of _merge_estimates.
 */
export function mergeEstimates(
  estimates: CostEstimate[]
): Record<string, unknown> | null {
  const perModel: Record<
    string,
    Record<BucketKey, number> & {
      provider: string;
      subtotal_usd: number;
    }
  > = {};
  const unpriced = new Set<string>();
  const approximations: Array<{ kind: string; detail?: string }> = [];
  const seenApprox = new Set<string>();
  let pricingAsOf: string | null = null;

  for (const est of estimates) {
    if (pricingAsOf === null) {
      pricingAsOf = est.pricing_as_of;
    }
    for (const u of est.unpriced_models) {
      unpriced.add(u);
    }
    for (const a of est.approximations) {
      // key: serialize kind+detail as a stable string for dedup
      const key = JSON.stringify([a.kind, a.detail ?? null]);
      if (!seenApprox.has(key)) {
        seenApprox.add(key);
        approximations.push({ kind: a.kind, detail: a.detail });
      }
    }
    for (const mc of est.per_model) {
      if (!(mc.model in perModel)) {
        // first file's provider label wins for a model seen in several files
        perModel[mc.model] = {
          ...emptyBucket(),
          provider: mc.provider,
          subtotal_usd: 0.0,
        };
      }
      const bucket = perModel[mc.model]!;
      bucket.total_input += mc.tokens.input;
      bucket.total_cache_create += mc.tokens.cache_write; // cache_write -> total_cache_create
      bucket.total_cache_read += mc.tokens.cache_read;
      bucket.total_output += mc.tokens.output;
      bucket.subtotal_usd += mc.subtotal_usd;
    }
  }

  const totals = emptyBucket();
  for (const bucket of Object.values(perModel)) {
    for (const k of BUCKET_KEYS) {
      totals[k] += bucket[k];
    }
  }
  const totalTokens = BUCKET_KEYS.reduce((sum, k) => sum + totals[k], 0);
  if (totalTokens === 0) {
    return null; // zero usage -> no artifact, even if obol named models
  }

  const totalUsd = Object.values(perModel).reduce(
    (sum, b) => sum + b.subtotal_usd,
    0
  );
  // Exact, and consistent with the per-model est_cost_usd field below: a
  // genuinely-$0-priced model (free tier) must not flip the run to unpriced.
  const allUnpriced =
    Object.keys(perModel).length > 0 &&
    Object.keys(perModel).every((m) => unpriced.has(m));

  const modelsOut: Record<string, unknown> = {};
  for (const [m, b] of Object.entries(perModel)) {
    const modelTotalTokens = BUCKET_KEYS.reduce((sum, k) => sum + b[k], 0);
    modelsOut[m] = {
      ...Object.fromEntries(BUCKET_KEYS.map((k) => [k, b[k]])),
      total_tokens: modelTotalTokens,
      provider: b.provider,
      // round to 10 decimal places: strips float-summation noise from frozen
      // artifacts without losing sub-cent precision (plan said 6; that
      // truncated small costs).
      est_cost_usd: unpriced.has(m)
        ? null
        : roundTo(b.subtotal_usd, 10),
    };
  }

  const topModel =
    Object.keys(perModel).length > 0
      ? Object.keys(perModel).reduce((best, m) =>
          perModel[m]!.subtotal_usd > perModel[best]!.subtotal_usd ? m : best
        )
      : null;

  return {
    ...totals,
    total_tokens: totalTokens,
    model: topModel,
    models: modelsOut,
    est_cost_usd: allUnpriced ? null : roundTo(totalUsd, 10),
    unpriced_models: [...unpriced].sort(),
    approximations,
    pricing_as_of: pricingAsOf,
  };
}

/** Round a number to `places` decimal places (strips float-summation noise). */
function roundTo(value: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

/**
 * Count UTF-8 bytes of tool result outputs in a kimi wire log.
 *
 * Port of _kimi_tool_result_total_bytes. Counts only context.append_loop_event
 * rows whose event.type is "tool.result" and whose result.output is a string.
 */
function kimiToolResultTotalBytes(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  let total = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r["type"] !== "context.append_loop_event") continue;
    const event = r["event"];
    if (typeof event !== "object" || event === null) continue;
    const e = event as Record<string, unknown>;
    if (e["type"] !== "tool.result") continue;
    const result = e["result"];
    if (typeof result !== "object" || result === null) continue;
    const res = result as Record<string, unknown>;
    const output = res["output"];
    if (typeof output === "string") {
      total += Buffer.byteLength(output, "utf-8");
    }
  }
  return total;
}

/**
 * Price a run's session logs via obol; null when capture isn't possible.
 *
 * Port of estimate_session_logs.
 */
export async function estimateSessionLogs(
  backendFamily: string,
  sessionLogFiles: string[]
): Promise<Record<string, unknown> | null> {
  const dialect = DIALECTS[backendFamily];
  if (dialect === undefined || sessionLogFiles.length === 0) {
    return null;
  }
  const estimates: CostEstimate[] = [];
  for (const filePath of sessionLogFiles) {
    try {
      estimates.push(await estimatePath(filePath, dialect as Parameters<typeof estimatePath>[1]));
    } catch (err) {
      if (err instanceof ObolError) {
        return null;
      }
      throw err;
    }
  }
  const usage = mergeEstimates(estimates);
  if (usage !== null && backendFamily === "kimi") {
    usage["tool_result_total_bytes"] = sessionLogFiles.reduce(
      (sum, p) => sum + kimiToolResultTotalBytes(p),
      0
    );
  }
  return usage;
}

/**
 * Price a gauntlet `usage.jsonl` sidecar (the `obol` dialect).
 *
 * Port of estimate_usage_sidecar.
 */
export async function estimateUsageSidecar(
  filePath: string
): Promise<Record<string, unknown> | null> {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  let est: CostEstimate;
  try {
    est = await estimatePath(filePath, "obol");
  } catch (err) {
    if (err instanceof ObolError) {
      return null;
    }
    throw err;
  }
  return mergeEstimates([est]);
}
