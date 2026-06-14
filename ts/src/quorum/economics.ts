/**
 * Per-run economics: timing + cost for both agents, computed at run time.
 *
 * Port of quorum/economics.py — preserves the output dict shape exactly
 * (it goes into verdict.json; renderers display it verbatim and never
 * recompute; the show economics pane and its tests depend on the shape).
 *
 * Reads the gauntlet-agent's usage.jsonl sidecar (priced via obol) and the
 * coding-agent's frozen coding-agent-token-usage.json (already obol-priced
 * at capture time), composes them into the economics block.
 *
 * Every read is best-effort: missing files/fields degrade to null +
 * `partial: true`, never a silent $0.
 */

import * as fs from "fs";
import * as path from "path";
import { estimateUsageSidecar } from "./obol-capture.ts";

/**
 * Find the first gauntlet results subdir that has artifacts.
 * Port of _gauntlet_results_dir.
 */
function gauntletResultsDir(runDir: string): string | null {
  const base = path.join(runDir, "gauntlet-agent", "results");
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    return null;
  }
  const entries = fs
    .readdirSync(base)
    .sort()
    .map((name) => path.join(base, name))
    .filter((d) => fs.statSync(d).isDirectory());

  for (const d of entries) {
    if (
      fs.existsSync(path.join(d, "result.json")) ||
      fs.existsSync(path.join(d, "usage.jsonl"))
    ) {
      return d;
    }
  }
  return null;
}

/**
 * Parse a JSON file into a dict, or null on any error / wrong type.
 * Port of _read_json.
 */
function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the obol provenance block, or null for pre-obol frozen files.
 * Port of _obol_provenance.
 */
function obolProvenance(
  usage: Record<string, unknown>
): Record<string, unknown> | null {
  if (!("pricing_as_of" in usage)) {
    return null;
  }
  return {
    per_model: (usage["models"] as Record<string, unknown>) ?? {},
    unpriced_models: (usage["unpriced_models"] as string[]) ?? [],
    approximations: (usage["approximations"] as unknown[]) ?? [],
    pricing_as_of: usage["pricing_as_of"],
  };
}

/**
 * Extract aggregate token counts into the shared shell shape.
 * Port of _tokens_shell.
 */
function tokensShell(usage: Record<string, unknown>): Record<string, number> {
  return {
    input: (usage["total_input"] as number) ?? 0,
    output: (usage["total_output"] as number) ?? 0,
    cache_create: (usage["total_cache_create"] as number) ?? 0,
    cache_read: (usage["total_cache_read"] as number) ?? 0,
    total: (usage["total_tokens"] as number) ?? 0,
  };
}

/**
 * Build the gauntlet-agent sub-block.
 * Port of _gauntlet_block.
 */
function gauntletBlock(
  result: Record<string, unknown> | null,
  usage: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (result === null && usage === null) {
    return null;
  }
  const r = result ?? {};
  const u = usage ?? {};
  const dur = r["duration_ms"];
  const config = r["config"];
  const configModel =
    typeof config === "object" && config !== null && !Array.isArray(config)
      ? (config as Record<string, unknown>)["model"]
      : null;
  const model = u["model"] ?? configModel ?? null;
  const hasUnpriced = Boolean(
    Array.isArray(u["unpriced_models"]) &&
      (u["unpriced_models"] as unknown[]).length > 0
  );

  return {
    duration_ms:
      typeof dur === "number" ? Math.trunc(dur) : null,
    model: model ?? null,
    tokens: tokensShell(u),
    est_cost_usd: u["est_cost_usd"] ?? null,
    has_unpriced_model: hasUnpriced,
    obol: usage !== null ? obolProvenance(usage) : null,
  };
}

/**
 * Build the coding-agent sub-block from the frozen token-usage artifact.
 * Port of _coding_block.
 */
function codingBlock(usage: Record<string, unknown>): Record<string, unknown> {
  const rawModels = (usage["models"] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const models: Record<string, unknown>[] = [];

  for (const [modelId, mt] of Object.entries(rawModels)) {
    models.push({
      model: modelId,
      tokens: {
        input: (mt["total_input"] as number) ?? 0,
        output: (mt["total_output"] as number) ?? 0,
        cache_create: (mt["total_cache_create"] as number) ?? 0,
        cache_read: (mt["total_cache_read"] as number) ?? 0,
        total: (mt["total_tokens"] as number) ?? 0,
      },
      est_cost_usd: mt["est_cost_usd"] ?? null,
    });
  }

  // Sort by cost descending; null costs sort last (treated as 0 for the key).
  models.sort((a, b) => {
    const ac = (a["est_cost_usd"] as number | null) ?? 0;
    const bc = (b["est_cost_usd"] as number | null) ?? 0;
    return bc - ac;
  });

  const hasUnpricedFromList = Boolean(
    Array.isArray(usage["unpriced_models"]) &&
      (usage["unpriced_models"] as unknown[]).length > 0
  );
  const hasUnpricedFromModels = models.some(
    (m) => (m["est_cost_usd"] as number | null) === null
  );
  const hasUnpriced = hasUnpricedFromList || hasUnpricedFromModels;

  return {
    duration_ms: usage["duration_ms"] ?? null,
    model: usage["model"] ?? null,
    models,
    tokens: tokensShell(usage),
    est_cost_usd: usage["est_cost_usd"] ?? null,
    tool_result_total_bytes: (usage["tool_result_total_bytes"] as number) ?? 0,
    has_unpriced_model: hasUnpriced,
    obol: obolProvenance(usage),
  };
}

/**
 * Build the economics block for verdict.json, or null if no source exists.
 * Port of build_run_economics.
 */
export async function buildRunEconomics(
  runDir: string
): Promise<Record<string, unknown> | null> {
  const resultsDir = gauntletResultsDir(runDir);
  const gResult = resultsDir
    ? readJson(path.join(resultsDir, "result.json"))
    : null;
  const gUsage = resultsDir
    ? await estimateUsageSidecar(path.join(resultsDir, "usage.jsonl"))
    : null;
  const codingUsage = readJson(
    path.join(runDir, "coding-agent-token-usage.json")
  );

  if (gResult === null && gUsage === null && codingUsage === null) {
    return null;
  }

  const gauntlet = gauntletBlock(gResult, gUsage);
  const coding = codingUsage !== null ? codingBlock(codingUsage) : null;

  const gCost =
    gauntlet !== null ? (gauntlet["est_cost_usd"] as number | null) : null;
  const cCost =
    coding !== null ? (coding["est_cost_usd"] as number | null) : null;
  const codingHasUnpriced = Boolean(
    coding !== null && coding["has_unpriced_model"]
  );
  const gauntletHasUnpriced = Boolean(
    gauntlet !== null && gauntlet["has_unpriced_model"]
  );
  const anyUnpriced = codingHasUnpriced || gauntletHasUnpriced;

  const total =
    gCost !== null && cCost !== null && !anyUnpriced
      ? Math.round((gCost + cCost) * 1_000_000) / 1_000_000
      : null;

  const partial =
    gauntlet === null ||
    coding === null ||
    gCost === null ||
    cCost === null ||
    anyUnpriced;

  let pricingAsof: unknown = null;
  for (const block of [coding, gauntlet]) {
    if (block === null) continue;
    const prov = (block["obol"] as Record<string, unknown> | null) ?? {};
    if (prov["pricing_as_of"]) {
      pricingAsof = prov["pricing_as_of"];
      break;
    }
  }

  return {
    pricing_asof: pricingAsof,
    gauntlet,
    coding_agent: coding,
    total_est_cost_usd: total,
    partial,
  };
}
