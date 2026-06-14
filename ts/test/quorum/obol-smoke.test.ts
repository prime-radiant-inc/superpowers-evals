/**
 * Port of tests/quorum/test_obol_smoke.py
 * Smoke tests for the obol binding itself — pricing resolution both ways.
 */

import { test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { estimatePath, setPricingDir, clearPricingDir, type CostEstimate } from "@primeradianthq/obol";

// Path to the committed test pricing fixture (mirrors conftest.py _PRICING_FIXTURE).
// From ts/test/quorum/ go up 3 levels to reach the worktree root.
const PRICING_FIXTURE = path.resolve(
  import.meta.dirname,
  "../../../tests/quorum/fixtures/pricing"
);

// ─── test_fixture_snapshot_prices_exactly ──────────────────────────────────

test("fixture_snapshot_prices_exactly", async () => {
  /**
   * The committed snapshot makes cost math deterministic.
   * Port of test_fixture_snapshot_prices_exactly.
   */
  await setPricingDir(PRICING_FIXTURE);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obol-smoke-"));
  try {
    const f = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(
      f,
      '{"type":"assistant","message":{"id":"m1","model":"claude-opus-4-7",' +
        '"role":"assistant","content":[],"usage":{"input_tokens":100,' +
        '"cache_creation_input_tokens":0,"cache_read_input_tokens":0,' +
        '"output_tokens":40}}}\n'
    );
    const est: CostEstimate = await estimatePath(f, "claude");
    // 100 * $5/M + 40 * $25/M = $0.0015
    expect(est.total_usd).toBeCloseTo(0.0015, 10);
    expect(est.pricing_as_of).toBe("2026-06-09");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await clearPricingDir();
  }
});

// ─── test_embedded_snapshot_works_without_env ──────────────────────────────

test("embedded_snapshot_works_without_env", async () => {
  /**
   * Default resolution (embedded snapshot floor) — shape-only asserts.
   *
   * Numbers may differ across machines (a local `obol refresh` overrides
   * the embedded floor), so we assert structure, never dollars.
   * Port of test_embedded_snapshot_works_without_env.
   */
  await clearPricingDir();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obol-smoke-"));
  try {
    const f = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(
      f,
      '{"type":"assistant","message":{"id":"m1","model":"claude-opus-4-8",' +
        '"role":"assistant","content":[],"usage":{"input_tokens":1000,' +
        '"cache_creation_input_tokens":0,"cache_read_input_tokens":0,' +
        '"output_tokens":100}}}\n'
    );
    const est: CostEstimate = await estimatePath(f, "claude");
    expect(est.total_usd).toBeGreaterThan(0);
    expect(est.pricing_as_of).toBeTruthy();
    expect(est.per_model.map((m) => m.model)).toEqual(["claude-opus-4-8"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
