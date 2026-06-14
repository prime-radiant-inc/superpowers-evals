/**
 * Port of tests/quorum/test_obol_capture.py
 *
 * Fixture rates (tests/quorum/fixtures/pricing/current.json, per-1M USD):
 *   opus-4-7   in 5.0 / out 25.0 / cr 0.5 / cw 6.25
 *   sonnet-4-6 in 3.0 / out 15.0 / cr 0.3 / cw 3.75
 *   gpt-5.5    in 5.0 / out 30.0 / cr 0.5 / cw 0.0
 *   kimi       in 1.0 / out  3.0 / cr 0.1 / cw 1.25
 */

import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setPricingDir } from "@primeradianthq/obol";
import {
  estimateSessionLogs,
  estimateUsageSidecar,
} from "../../src/quorum/obol-capture.ts";

// Mirrors conftest.py: pin obol to the committed test pricing snapshot so
// tests are hermetic against the embedded snapshot version and any local
// `obol refresh` state.
// From ts/test/quorum/ go up 3 levels to reach the worktree root.
const PRICING_FIXTURE = path.resolve(
  import.meta.dirname,
  "../../../tests/quorum/fixtures/pricing"
);

// Path to pre-committed fixture files used in both Python and TS tests.
const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../tests/quorum/fixtures"
);

// Helper: write a Claude-format JSONL assistant row.
function claudeRow(
  model: string,
  mid: string,
  inp: number,
  cc: number,
  cr: number,
  out: number
): string {
  return (
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-09T00:00:00Z",
      message: {
        id: mid,
        model,
        role: "assistant",
        content: [],
        usage: {
          input_tokens: inp,
          cache_creation_input_tokens: cc,
          cache_read_input_tokens: cr,
          output_tokens: out,
        },
      },
    }) + "\n"
  );
}

// Set up pricing fixture before all tests (mirrors autouse conftest fixture).
beforeAll(async () => {
  await setPricingDir(PRICING_FIXTURE);
});

// ─── TestEstimateSessionLogs ─────────────────────────────────────────────────

describe("TestEstimateSessionLogs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obol-capture-test-"));
  });

  test("test_claude_multi_file_merge", async () => {
    // Main session (opus) + subagent sibling file (sonnet): buckets and
    // cost merge across files, per-model breakdown keeps both.
    const main = path.join(tmpDir, "main.jsonl");
    fs.writeFileSync(
      main,
      claudeRow("claude-opus-4-7", "m1", 100, 1000, 50, 20) +
        claudeRow("claude-opus-4-7", "m2", 50, 0, 1100, 30)
    );
    const sub = path.join(tmpDir, "sub.jsonl");
    fs.writeFileSync(sub, claudeRow("claude-sonnet-4-6", "s1", 10, 0, 0, 5));

    const usage = await estimateSessionLogs("claude", [main, sub]);

    expect(usage).not.toBeNull();
    expect(usage!["total_input"]).toBe(160);
    expect(usage!["total_cache_create"]).toBe(1000);
    expect(usage!["total_cache_read"]).toBe(1150);
    expect(usage!["total_output"]).toBe(55);
    expect(usage!["total_tokens"]).toBe(160 + 1000 + 1150 + 55);
    // opus: (150*5 + 1000*6.25 + 1150*0.5 + 50*25)/1e6 = 0.008825
    // sonnet: (10*3 + 5*15)/1e6 = 0.000105
    expect(usage!["est_cost_usd"] as number).toBeCloseTo(0.00893, 7);
    expect(usage!["model"]).toBe("claude-opus-4-7"); // costliest model
    expect(
      (usage!["models"] as Record<string, Record<string, unknown>>)[
        "claude-sonnet-4-6"
      ]!["est_cost_usd"] as number
    ).toBeCloseTo(0.000105, 7);
    expect(usage!["unpriced_models"]).toEqual([]);
    expect(usage!["pricing_as_of"]).toBe("2026-06-09");
  });

  test("test_codex_rollout", async () => {
    const f = path.join(tmpDir, "rollout.jsonl");
    fs.copyFileSync(path.join(FIXTURES, "codex_rollout.jsonl"), f);
    const usage = await estimateSessionLogs("codex", [f]);
    expect(usage).not.toBeNull();
    // Last cumulative token_count wins: input 2000 (900 cached) -> 1100
    // uncached; output 120 + 40 reasoning = 160 (obol bills reasoning
    // as output, obol PRI-2124).
    expect(usage!["total_input"]).toBe(1100);
    expect(usage!["total_cache_read"]).toBe(900);
    expect(usage!["total_cache_create"]).toBe(0);
    expect(usage!["total_output"]).toBe(160);
    expect(usage!["est_cost_usd"] as number).toBeCloseTo(
      (1100 * 5.0 + 900 * 0.5 + 160 * 30.0) / 1e6,
      7
    );
  });

  test("test_kimi_wire", async () => {
    const f = path.join(tmpDir, "wire.jsonl");
    fs.writeFileSync(
      f,
      JSON.stringify({
        type: "usage.record",
        usageScope: "turn",
        model: "kimi-for-coding",
        time: 1_800_000_000_000,
        usage: {
          inputOther: 10,
          inputCacheRead: 20,
          inputCacheCreation: 30,
          output: 40,
        },
      }) + "\n"
    );
    const usage = await estimateSessionLogs("kimi", [f]);
    expect(usage).not.toBeNull();
    expect(usage!["total_tokens"]).toBe(100);
    // (10*1 + 20*0.1 + 30*1.25 + 40*3)/1e6
    expect(usage!["est_cost_usd"] as number).toBeCloseTo(0.0001695, 7);
  });

  test("test_kimi_tool_result_bytes", async () => {
    const f = path.join(tmpDir, "wire.jsonl");
    const rows = [
      {
        type: "usage.record",
        usageScope: "turn",
        model: "kimi-for-coding",
        time: 1_800_000_000_000,
        usage: {
          inputOther: 1,
          inputCacheRead: 0,
          inputCacheCreation: 0,
          output: 1,
        },
      },
      {
        type: "context.append_loop_event",
        event: {
          type: "tool.result",
          toolCallId: "t1",
          result: { output: "hello" },
        },
      },
      {
        type: "context.append_loop_event",
        event: {
          type: "tool.result",
          toolCallId: "t2",
          result: { output: "café" },
        },
      },
      {
        type: "context.append_loop_event",
        event: {
          type: "tool.result",
          toolCallId: "t3",
          result: { output: "boom", isError: true },
        },
      },
    ];
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const usage = await estimateSessionLogs("kimi", [f]);

    expect(usage).not.toBeNull();
    expect(usage!["tool_result_total_bytes"]).toBe(14);
  });

  test("test_kimi_real_structure_fixture_tool_result_bytes", async () => {
    const usage = await estimateSessionLogs("kimi", [
      path.join(FIXTURES, "kimi_wire.jsonl"),
    ]);

    expect(usage).not.toBeNull();
    expect(usage!["tool_result_total_bytes"]).toBe(30);
    expect(usage!["total_output"]).toBe(50);
  });

  test("test_kimi_tool_result_bytes_edge_cases", async () => {
    const f = path.join(tmpDir, "wire.jsonl");
    const rows = [
      {
        type: "usage.record",
        usageScope: "turn",
        model: "kimi-for-coding",
        time: 1_800_000_000_000,
        usage: {
          inputOther: 1,
          inputCacheRead: 0,
          inputCacheCreation: 0,
          output: 1,
        },
      },
      {
        type: "context.append_loop_event",
        event: { type: "tool.result", result: { output: { nested: "obj" } } },
      },
      {
        type: "context.append_loop_event",
        event: { type: "tool.result", result: {} },
      },
      {
        type: "context.append_loop_event",
        event: { type: "tool.result", result: { output: "" } },
      },
      {
        type: "context.append_loop_event",
        event: {
          type: "content.part",
          part: { type: "text", text: "ignored" },
        },
      },
    ];
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const usage = await estimateSessionLogs("kimi", [f]);

    expect(usage).not.toBeNull();
    expect(usage!["tool_result_total_bytes"]).toBe(0);
  });

  test("test_unknown_backend_returns_none", async () => {
    const f = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(f, "{}\n");
    expect(await estimateSessionLogs("antigravity", [f])).toBeNull();
  });

  test("test_unparseable_file_returns_none", async () => {
    // A backend obol knows, but a file its parser rejects -> null,
    // never a partial sum. (gemini dialect, garbage content.)
    const f = path.join(tmpDir, "transcript.jsonl");
    fs.writeFileSync(f, "definitely not a gemini transcript\n");
    expect(await estimateSessionLogs("gemini", [f])).toBeNull();
  });

  test("test_zero_usage_returns_none", async () => {
    // Parsable file, no usage rows -> null (no junk zero-cost files).
    const f = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(
      f,
      '{"type":"user","message":{"role":"user","content":"hi"}}\n'
    );
    expect(await estimateSessionLogs("claude", [f])).toBeNull();
  });

  test("test_no_files_returns_none", async () => {
    expect(await estimateSessionLogs("claude", [])).toBeNull();
  });

  test("test_unpriced_model_surfaces", async () => {
    const f = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(f, claudeRow("mystery-model-9", "m1", 100, 0, 0, 10));
    const usage = await estimateSessionLogs("claude", [f]);
    expect(usage).not.toBeNull();
    expect(usage!["unpriced_models"]).toEqual(["mystery-model-9"]);
    expect(usage!["est_cost_usd"]).toBeNull(); // all-unpriced: no silent $0
    expect(usage!["total_input"]).toBe(100); // tokens still reported
  });

  test("test_mixed_priced_and_unpriced", async () => {
    // One priced + one unpriced model: priced cost survives at top level,
    // the unpriced model is flagged per-model and in unpriced_models.
    const f = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(
      f,
      claudeRow("claude-opus-4-7", "m1", 100, 0, 0, 40) +
        claudeRow("mystery-model-9", "m2", 50, 0, 0, 5)
    );
    const usage = await estimateSessionLogs("claude", [f]);
    expect(usage).not.toBeNull();
    expect(usage!["unpriced_models"]).toEqual(["mystery-model-9"]);
    expect(usage!["est_cost_usd"] as number).toBeCloseTo(0.0015, 7); // opus only
    const models = usage!["models"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(models["mystery-model-9"]!["est_cost_usd"]).toBeNull();
    expect(models["claude-opus-4-7"]!["est_cost_usd"] as number).toBeCloseTo(
      0.0015,
      7
    );
  });

  test("test_same_model_across_files_accumulates", async () => {
    // The accumulate-into-existing-bucket path: same model in two files.
    const a = path.join(tmpDir, "a.jsonl");
    const b = path.join(tmpDir, "b.jsonl");
    fs.writeFileSync(a, claudeRow("claude-opus-4-7", "m1", 100, 0, 0, 20));
    fs.writeFileSync(b, claudeRow("claude-opus-4-7", "m2", 50, 0, 0, 30));
    const usage = await estimateSessionLogs("claude", [a, b]);
    expect(usage).not.toBeNull();
    expect(usage!["total_input"]).toBe(150);
    expect(usage!["total_output"]).toBe(50);
    const models = usage!["models"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(models["claude-opus-4-7"]!["total_input"]).toBe(150);
    // (150*5 + 50*25)/1e6
    expect(usage!["est_cost_usd"] as number).toBeCloseTo(0.002, 7);
  });

  test("test_garbage_sibling_file_contributes_nothing", async () => {
    // Line-oriented dialects skip unparseable content (obol returns an
    // empty estimate, same resilience the pre-obol parser had), so a
    // garbage sibling file leaves the good file's usage intact. The
    // ObolError -> null guard covers structural failures instead
    // (pricing tables missing, sidecar schema rejection).
    const good = path.join(tmpDir, "good.jsonl");
    const bad = path.join(tmpDir, "bad.jsonl");
    fs.writeFileSync(good, claudeRow("claude-opus-4-7", "m1", 100, 0, 0, 20));
    fs.writeFileSync(bad, "\x00\x01 not jsonl at all");
    const usage = await estimateSessionLogs("claude", [good, bad]);
    expect(usage).not.toBeNull();
    expect(usage!["total_input"]).toBe(100);
    // (100*5 + 20*25)/1e6
    expect(usage!["est_cost_usd"] as number).toBeCloseTo(0.001, 7);
  });
});

// ─── TestEstimateUsageSidecar ────────────────────────────────────────────────

describe("TestEstimateUsageSidecar", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obol-capture-test-"));
  });

  test("test_gauntlet_sidecar", async () => {
    const f = path.join(tmpDir, "usage.jsonl");
    fs.writeFileSync(
      f,
      JSON.stringify({
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
      }) + "\n"
    );
    const usage = await estimateUsageSidecar(f);
    expect(usage).not.toBeNull();
    expect(usage!["total_input"]).toBe(12);
    expect(usage!["total_cache_create"]).toBe(60);
    expect(usage!["total_cache_read"]).toBe(120);
    expect(usage!["total_output"]).toBe(9);
    // (12*3 + 60*3.75 + 120*0.3 + 9*15)/1e6
    expect(usage!["est_cost_usd"] as number).toBeCloseTo(0.000432, 7);
    expect(usage!["model"]).toBe("claude-sonnet-4-6");
  });

  test("test_missing_file_returns_none", async () => {
    expect(
      await estimateUsageSidecar(path.join(tmpDir, "usage.jsonl"))
    ).toBeNull();
  });

  test("test_unparseable_sidecar_returns_none", async () => {
    const f = path.join(tmpDir, "usage.jsonl");
    fs.writeFileSync(
      f,
      '{"type":"obol.usage","v":"2099-01-01","provider":"x","usage":{}}\n'
    );
    expect(await estimateUsageSidecar(f)).toBeNull();
  });
});
