/**
 * Port of tests/quorum/test_economics.py
 *
 * Uses the same fixture pricing snapshot as obol-capture tests so cost
 * assertions match across Python and TS.
 *
 * Pricing fixture rates (tests/quorum/fixtures/pricing/current.json, per-1M USD):
 *   sonnet-4-6: in 3.0 / out 15.0 / cr 0.3 / cw 3.75
 */

import { test, expect, describe, beforeAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setPricingDir } from "@primeradianthq/obol";
import { buildRunEconomics } from "../../src/quorum/economics.ts";

// Pin obol to the committed test pricing snapshot (mirrors conftest.py).
const PRICING_FIXTURE = path.resolve(
  import.meta.dirname,
  "../../../tests/quorum/fixtures/pricing"
);

beforeAll(async () => {
  await setPricingDir(PRICING_FIXTURE);
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const _SONNET_ROW = {
  type: "obol.usage",
  v: "2026-06-08",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  service_tier: "standard",
  usage: {
    input_tokens: 12,
    cache_read_input_tokens: 120,
    cache_creation_input_tokens: 60,
    output_tokens: 9,
  },
};

// (12*3 + 60*3.75 + 120*0.3 + 9*15)/1e6 against the fixture snapshot
const _SONNET_COST = 0.000432;

const _RESULT = { duration_ms: 1000, config: { model: "claude-sonnet-4-6" } };

const _CODING_USAGE = {
  total_input: 160,
  total_cache_create: 1000,
  total_cache_read: 1150,
  total_output: 55,
  total_tokens: 2365,
  model: "claude-opus-4-7",
  models: {
    "claude-opus-4-7": {
      total_input: 150,
      total_cache_create: 1000,
      total_cache_read: 1150,
      total_output: 50,
      total_tokens: 2350,
      provider: "anthropic",
      est_cost_usd: 0.008825,
    },
  },
  est_cost_usd: 0.008825,
  unpriced_models: [] as string[],
  approximations: [] as unknown[],
  pricing_as_of: "2026-06-09",
  duration_ms: 84000,
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "economics-test-"));
}

/**
 * Create gauntlet-agent/results/run-001/ under runDir.
 * Mirrors _gauntlet_results() from test_economics.py.
 */
function gauntletResults(
  runDir: string,
  opts: { usageRows?: unknown[]; result?: unknown } = {}
): string {
  const d = path.join(runDir, "gauntlet-agent", "results", "run-001");
  fs.mkdirSync(d, { recursive: true });
  if (opts.result !== undefined) {
    fs.writeFileSync(path.join(d, "result.json"), JSON.stringify(opts.result));
  }
  if (opts.usageRows !== undefined) {
    fs.writeFileSync(
      path.join(d, "usage.jsonl"),
      opts.usageRows.map((r) => JSON.stringify(r)).join("\n") + "\n"
    );
  }
  return d;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("test_full_economics", async () => {
  const tmp = makeTmp();
  gauntletResults(tmp, { usageRows: [_SONNET_ROW], result: _RESULT });
  fs.writeFileSync(
    path.join(tmp, "coding-agent-token-usage.json"),
    JSON.stringify(_CODING_USAGE)
  );

  const econ = await buildRunEconomics(tmp);
  expect(econ).not.toBeNull();

  const g = econ!["gauntlet"] as Record<string, unknown>;
  expect(g["duration_ms"]).toBe(1000);
  expect(g["model"]).toBe("claude-sonnet-4-6");
  expect(g["tokens"]).toEqual({
    input: 12,
    output: 9,
    cache_create: 60,
    cache_read: 120,
    total: 201,
  });
  expect(g["est_cost_usd"] as number).toBeCloseTo(_SONNET_COST, 7);
  expect(
    (g["obol"] as Record<string, unknown>)["pricing_as_of"]
  ).toBe("2026-06-09");

  const c = econ!["coding_agent"] as Record<string, unknown>;
  expect(c["duration_ms"]).toBe(84000);
  expect(c["est_cost_usd"] as number).toBeCloseTo(0.008825, 7);
  expect(
    ((c["models"] as Record<string, unknown>[])[0] as Record<string, unknown>)[
      "model"
    ]
  ).toBe("claude-opus-4-7");
  expect(c["has_unpriced_model"]).toBe(false);
  expect(
    (c["obol"] as Record<string, unknown>)["pricing_as_of"]
  ).toBe("2026-06-09");

  expect(econ!["total_est_cost_usd"] as number).toBeCloseTo(
    _SONNET_COST + 0.008825,
    7
  );
  expect(econ!["partial"]).toBe(false);
  expect(econ!["pricing_asof"]).toBe("2026-06-09");
});

test("test_missing_usage_sidecar_is_partial", async () => {
  // Older gauntlet (no usage.jsonl): cost None, duration/model still shown.
  const tmp = makeTmp();
  gauntletResults(tmp, { result: _RESULT });
  fs.writeFileSync(
    path.join(tmp, "coding-agent-token-usage.json"),
    JSON.stringify(_CODING_USAGE)
  );

  const econ = await buildRunEconomics(tmp);
  expect(econ).not.toBeNull();

  const g = econ!["gauntlet"] as Record<string, unknown>;
  expect(g["est_cost_usd"]).toBeNull();
  expect(g["duration_ms"]).toBe(1000);
  expect(g["model"]).toBe("claude-sonnet-4-6");
  expect(econ!["partial"]).toBe(true);
  expect(econ!["total_est_cost_usd"]).toBeNull();
});

test("test_coding_block_surfaces_tool_result_bytes", async () => {
  const tmp = makeTmp();
  gauntletResults(tmp, { usageRows: [_SONNET_ROW], result: _RESULT });
  const usage = { ..._CODING_USAGE, tool_result_total_bytes: 142772 };
  fs.writeFileSync(
    path.join(tmp, "coding-agent-token-usage.json"),
    JSON.stringify(usage)
  );

  const econ = await buildRunEconomics(tmp);
  expect(econ).not.toBeNull();
  expect(
    (econ!["coding_agent"] as Record<string, unknown>)["tool_result_total_bytes"]
  ).toBe(142772);
});

test("test_coding_block_defaults_tool_result_bytes_to_zero", async () => {
  const tmp = makeTmp();
  gauntletResults(tmp, { usageRows: [_SONNET_ROW], result: _RESULT });
  fs.writeFileSync(
    path.join(tmp, "coding-agent-token-usage.json"),
    JSON.stringify(_CODING_USAGE)
  );

  const econ = await buildRunEconomics(tmp);
  expect(econ).not.toBeNull();
  expect(
    (econ!["coding_agent"] as Record<string, unknown>)["tool_result_total_bytes"]
  ).toBe(0);
});

test("test_missing_coding_usage_is_partial", async () => {
  const tmp = makeTmp();
  gauntletResults(tmp, { usageRows: [_SONNET_ROW], result: _RESULT });

  const econ = await buildRunEconomics(tmp);
  expect(econ).not.toBeNull();
  expect(econ!["coding_agent"]).toBeNull();
  expect(econ!["partial"]).toBe(true);
  expect(econ!["total_est_cost_usd"]).toBeNull();
});

test("test_no_sources_returns_none", async () => {
  const tmp = makeTmp();
  expect(await buildRunEconomics(tmp)).toBeNull();
});

test("test_unpriced_coding_model_is_partial", async () => {
  const tmp = makeTmp();
  gauntletResults(tmp, { usageRows: [_SONNET_ROW], result: _RESULT });
  const usage = { ..._CODING_USAGE, unpriced_models: ["mystery-model-9"] };
  fs.writeFileSync(
    path.join(tmp, "coding-agent-token-usage.json"),
    JSON.stringify(usage)
  );

  const econ = await buildRunEconomics(tmp);
  expect(econ).not.toBeNull();

  expect(
    (econ!["coding_agent"] as Record<string, unknown>)["has_unpriced_model"]
  ).toBe(true);
  expect(econ!["partial"]).toBe(true);
  expect(econ!["total_est_cost_usd"]).toBeNull();
});

test("test_legacy_frozen_file_renders_without_crash", async () => {
  // A pre-obol frozen file (no pricing_as_of/unpriced_models/approximations
  // keys): block still builds, with no obol provenance.
  const tmp = makeTmp();
  const legacy = {
    total_input: 100,
    total_cache_create: 0,
    total_cache_read: 0,
    total_output: 40,
    total_tokens: 140,
    model: "claude-opus-4-7",
    est_cost_usd: 0.0015,
    duration_ms: 5000,
    models: {},
  };
  fs.writeFileSync(
    path.join(tmp, "coding-agent-token-usage.json"),
    JSON.stringify(legacy)
  );

  const econ = await buildRunEconomics(tmp);
  expect(econ).not.toBeNull();

  const c = econ!["coding_agent"] as Record<string, unknown>;
  expect(c["est_cost_usd"]).toBe(0.0015);
  expect(c["obol"]).toBeNull();
  expect(econ!["partial"]).toBe(true); // no gauntlet block
});

test("test_mixed_unpriced_gauntlet_sidecar_gates_total", async () => {
  // One priced + one unpriced model in the gauntlet sidecar: the priced
  // cost still shows on the block, but the headline total must not
  // pretend completeness (never a silent undercount).
  const tmp = makeTmp();
  const mysteryRow = {
    type: "obol.usage",
    v: "2026-06-08",
    provider: "anthropic",
    model: "mystery-model-9",
    usage: { input_tokens: 5_000_000, output_tokens: 1000 },
  };
  gauntletResults(tmp, {
    usageRows: [_SONNET_ROW, mysteryRow],
    result: _RESULT,
  });
  fs.writeFileSync(
    path.join(tmp, "coding-agent-token-usage.json"),
    JSON.stringify(_CODING_USAGE)
  );

  const econ = await buildRunEconomics(tmp);

  expect(econ).not.toBeNull();
  const g = econ!["gauntlet"] as Record<string, unknown>;
  expect(g["has_unpriced_model"]).toBe(true);
  expect(g["est_cost_usd"] as number).toBeCloseTo(_SONNET_COST, 7);
  expect(econ!["total_est_cost_usd"]).toBeNull();
  expect(econ!["partial"]).toBe(true);
});

test("test_coding_models_sorted_by_cost_desc_with_none_last", async () => {
  const tmp = makeTmp();
  const usage = JSON.parse(JSON.stringify(_CODING_USAGE));
  usage["models"]["claude-sonnet-4-6"] = {
    total_input: 10,
    total_cache_create: 0,
    total_cache_read: 0,
    total_output: 5,
    total_tokens: 15,
    provider: "anthropic",
    est_cost_usd: 0.02, // costlier than opus's 0.008825
  };
  usage["models"]["mystery-model-9"] = {
    total_input: 7,
    total_cache_create: 0,
    total_cache_read: 0,
    total_output: 0,
    total_tokens: 7,
    provider: "anthropic",
    est_cost_usd: null,
  };
  fs.writeFileSync(
    path.join(tmp, "coding-agent-token-usage.json"),
    JSON.stringify(usage)
  );

  const econ = await buildRunEconomics(tmp);

  expect(econ).not.toBeNull();
  const models = (econ!["coding_agent"] as Record<string, unknown>)[
    "models"
  ] as Record<string, unknown>[];
  expect(models.map((m) => m["model"])).toEqual([
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "mystery-model-9",
  ]);
  // per-model None cost flips has_unpriced even without unpriced_models
  expect(
    (econ!["coding_agent"] as Record<string, unknown>)["has_unpriced_model"]
  ).toBe(true);
  expect(econ!["partial"]).toBe(true);
});

test("test_gauntlet_block_none_when_only_coding_usage", async () => {
  const tmp = makeTmp();
  fs.writeFileSync(
    path.join(tmp, "coding-agent-token-usage.json"),
    JSON.stringify(_CODING_USAGE)
  );

  const econ = await buildRunEconomics(tmp);
  expect(econ).not.toBeNull();
  expect(econ!["gauntlet"]).toBeNull();
  expect(econ!["partial"]).toBe(true);
});

test("test_wrong_typed_result_config_degrades", async () => {
  // result.json is written by Gauntlet (external tool): config drift to a
  // list must not crash; model falls back to the sidecar's.
  const tmp = makeTmp();
  gauntletResults(tmp, {
    usageRows: [_SONNET_ROW],
    result: { duration_ms: 1000, config: ["not", "a", "dict"] },
  });
  fs.writeFileSync(
    path.join(tmp, "coding-agent-token-usage.json"),
    JSON.stringify(_CODING_USAGE)
  );

  const econ = await buildRunEconomics(tmp);
  expect(econ).not.toBeNull();
  const g = econ!["gauntlet"] as Record<string, unknown>;
  expect(g["model"]).toBe("claude-sonnet-4-6"); // from sidecar
  expect(g["duration_ms"]).toBe(1000);
});
