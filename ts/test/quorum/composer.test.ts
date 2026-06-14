/**
 * Tests for ts/src/quorum/composer.ts
 * Ported from tests/quorum/test_composer.py
 */

import { describe, test, expect } from "bun:test";
import type { CheckRecord } from "../../src/quorum/checks.ts";
import {
  compose,
  toDict,
  TRACE_PRIMITIVES,
  type GauntletLayer,
  type RunError,
  type FinalVerdict,
} from "../../src/quorum/composer.ts";

// ---------------------------------------------------------------------------
// Helpers (mirror Python's _gl and _ck)
// ---------------------------------------------------------------------------

function _gl(
  status: GauntletLayer["status"] = "pass",
  summary = "s",
  reasoning = "r",
  runId: string | null = "abc",
): GauntletLayer {
  return { status, summary, reasoning, runId };
}

function _ck(
  name: string,
  passed: boolean,
  phase: CheckRecord["phase"] = "post",
  negated = false,
  detail: string | null = null,
): CheckRecord {
  return { check: name, args: [], negated, passed, detail, phase };
}

// ---------------------------------------------------------------------------
// compose: main decision tree branches
// ---------------------------------------------------------------------------

describe("compose", () => {
  test("all_pass yields pass", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [_ck("file-exists", true)],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("pass");
    expect(v.finalReason.toLowerCase()).toContain("passed");
  });

  test("check fail yields fail", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [_ck("file-exists", false, "post", false, "no path")],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("fail");
  });

  test("gauntlet fail yields fail", () => {
    const v = compose({
      gauntlet: _gl("fail"),
      checks: [_ck("file-exists", true)],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("fail");
  });

  test("gauntlet investigate yields indeterminate", () => {
    const v = compose({
      gauntlet: _gl("investigate", "looped"),
      checks: [],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("indeterminate");
    expect(v.finalReason.toLowerCase()).toContain("investigate");
  });

  test("pre check failure yields indeterminate", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [_ck("git-repo", false, "pre")],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("indeterminate");
  });

  test("capture empty with trace check yields indeterminate", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [_ck("tool-called", true)],
      captureEmpty: true,
      error: null,
    });
    expect(v.final).toBe("indeterminate");
  });

  test("capture empty without trace check passes", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [_ck("file-exists", true)],
      captureEmpty: true,
      error: null,
    });
    expect(v.final).toBe("pass");
  });

  // The four previously-missing trace primitives
  test.each([
    "investigated",
    "worktree-created",
    "implementation-tool-not-called",
    "skill-before-implementation-tool",
  ])(
    "capture empty with transcript verb '%s' yields indeterminate",
    (verb) => {
      const v = compose({
        gauntlet: _gl("pass"),
        checks: [_ck(verb, true)],
        captureEmpty: true,
        error: null,
      });
      expect(v.final).toBe("indeterminate");
    },
  );

  test("error yields indeterminate", () => {
    const err: RunError = { stage: "setup", message: "boom" };
    const v = compose({
      gauntlet: null,
      checks: [],
      captureEmpty: false,
      error: err,
    });
    expect(v.final).toBe("indeterminate");
    expect(v.finalReason).toContain("quorum error (setup): boom");
  });

  test("zero checks passes iff gauntlet passed", () => {
    const pass = compose({
      gauntlet: _gl("pass"),
      checks: [],
      captureEmpty: false,
      error: null,
    });
    expect(pass.final).toBe("pass");

    const fail = compose({
      gauntlet: _gl("fail"),
      checks: [],
      captureEmpty: false,
      error: null,
    });
    expect(fail.final).toBe("fail");
  });

  test("gauntlet null yields indeterminate no verdict", () => {
    const v = compose({
      gauntlet: null,
      checks: [],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("indeterminate");
    expect(v.finalReason).toBe("no Gauntlet-Agent verdict");
  });

  test("gauntlet errored yields indeterminate", () => {
    const v = compose({
      gauntlet: _gl("errored"),
      checks: [],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("indeterminate");
    expect(v.finalReason).toContain("errored");
  });

  test("pass with multiple post checks includes count", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [_ck("file-exists", true), _ck("git-repo", true)],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("pass");
    expect(v.finalReason).toContain("2 post-check(s) passed");
  });

  test("pass with zero post checks uses no-deterministic-checks reason", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("pass");
    expect(v.finalReason).toBe(
      "Gauntlet-Agent passed; no deterministic checks",
    );
  });

  test("fail with both gauntlet fail and post check fail includes both in reason", () => {
    const v = compose({
      gauntlet: _gl("fail"),
      checks: [_ck("file-exists", false)],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("fail");
    expect(v.finalReason).toContain("Gauntlet-Agent reported fail");
    expect(v.finalReason).toContain("1 post-check(s) failed");
  });

  test("error reason includes stage and message", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [],
      captureEmpty: false,
      error: { stage: "capture", message: "timeout" },
    });
    expect(v.finalReason).toBe("quorum error (capture): timeout");
  });

  test("pre check failure reason includes check name", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [_ck("git-repo", false, "pre"), _ck("file-exists", false, "pre")],
      captureEmpty: false,
      error: null,
    });
    expect(v.final).toBe("indeterminate");
    expect(v.finalReason).toContain("git-repo");
    expect(v.finalReason).toContain("file-exists");
  });
});

// ---------------------------------------------------------------------------
// TRACE_PRIMITIVES: all 13 verbs present
// ---------------------------------------------------------------------------

describe("TRACE_PRIMITIVES", () => {
  const expected = new Set([
    "tool-called",
    "tool-not-called",
    "tool-count",
    "tool-before",
    "tool-arg-match",
    "tool-match-before-tool-match",
    "skill-called",
    "skill-not-called",
    "skill-before-tool",
    "skill-before-implementation-tool",
    "implementation-tool-not-called",
    "investigated",
    "worktree-created",
  ]);

  test("has exactly 13 entries", () => {
    expect(TRACE_PRIMITIVES.size).toBe(13);
  });

  test("contains all expected verbs", () => {
    for (const verb of expected) {
      expect(TRACE_PRIMITIVES.has(verb)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// toDict: shape and schema version
// ---------------------------------------------------------------------------

describe("toDict", () => {
  test("schema version is 1", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [_ck("file-exists", true)],
      captureEmpty: false,
      error: null,
    });
    const d = toDict(v) as Record<string, unknown>;
    expect(d["schema"]).toBe(1);
    expect(["pass", "fail", "indeterminate"]).toContain(d["final"] as string);
    expect(d).toHaveProperty("final_reason");
    expect(d).toHaveProperty("checks");
    expect(d).toHaveProperty("gauntlet");
    expect(d).toHaveProperty("error");
  });

  test("economics null by default", () => {
    const v: FinalVerdict = {
      schema: 1,
      final: "pass",
      finalReason: "",
      gauntlet: null,
      checks: [],
      error: null,
      economics: null,
    };
    const d = toDict(v) as Record<string, unknown>;
    expect(d["economics"]).toBeNull();
  });

  test("economics preserved", () => {
    const econ = {
      pricing_asof: "2026-05",
      total_est_cost_usd: 1.5,
      partial: false,
      gauntlet: null,
      coding_agent: null,
    };
    const v: FinalVerdict = {
      schema: 1,
      final: "pass",
      finalReason: "",
      gauntlet: null,
      checks: [],
      error: null,
      economics: econ,
    };
    const d = toDict(v) as Record<string, unknown>;
    expect(d["economics"]).toEqual(econ);
  });

  test("gauntlet null serializes as null", () => {
    const v = compose({
      gauntlet: null,
      checks: [],
      captureEmpty: false,
      error: null,
    });
    const d = toDict(v) as Record<string, unknown>;
    expect(d["gauntlet"]).toBeNull();
  });

  test("gauntlet layer serializes with snake_case run_id", () => {
    const v = compose({
      gauntlet: _gl("pass", "summary text", "reasoning text", "run-xyz"),
      checks: [],
      captureEmpty: false,
      error: null,
    });
    const d = toDict(v) as Record<string, unknown>;
    const g = d["gauntlet"] as Record<string, unknown>;
    expect(g["status"]).toBe("pass");
    expect(g["summary"]).toBe("summary text");
    expect(g["reasoning"]).toBe("reasoning text");
    expect(g["run_id"]).toBe("run-xyz");
    // Must NOT contain camelCase run_id
    expect(g).not.toHaveProperty("runId");
  });

  test("checks array has correct shape", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [_ck("file-exists", true, "post", false, "ok")],
      captureEmpty: false,
      error: null,
    });
    const d = toDict(v) as Record<string, unknown>;
    const checks = d["checks"] as Record<string, unknown>[];
    expect(checks).toHaveLength(1);
    const c = checks[0]!;
    expect(c["check"]).toBe("file-exists");
    expect(c["args"]).toEqual([]);
    expect(c["negated"]).toBe(false);
    expect(c["passed"]).toBe(true);
    expect(c["detail"]).toBe("ok");
    expect(c["phase"]).toBe("post");
  });

  test("error null serializes as null", () => {
    const v = compose({
      gauntlet: _gl("pass"),
      checks: [],
      captureEmpty: false,
      error: null,
    });
    const d = toDict(v) as Record<string, unknown>;
    expect(d["error"]).toBeNull();
  });

  test("error serializes with stage and message", () => {
    const v = compose({
      gauntlet: null,
      checks: [],
      captureEmpty: false,
      error: { stage: "setup", message: "boom" },
    });
    const d = toDict(v) as Record<string, unknown>;
    const e = d["error"] as Record<string, unknown>;
    expect(e["stage"]).toBe("setup");
    expect(e["message"]).toBe("boom");
  });

  // Parity assertion: toDict output matches Python's to_dict byte-for-byte
  // (well, key-for-key with the exact expected shape).
  test("toDict parity with Python to_dict shape (representative verdict)", () => {
    const gl: GauntletLayer = {
      status: "pass",
      summary: "All ACs met",
      reasoning: "The agent did everything correctly.",
      runId: "run-abc-123",
    };
    const checks: CheckRecord[] = [
      {
        check: "file-exists",
        args: ["output.txt"],
        negated: false,
        passed: true,
        detail: null,
        phase: "post",
      },
    ];
    const v = compose({
      gauntlet: gl,
      checks,
      captureEmpty: false,
      error: null,
    });
    const d = toDict(v) as Record<string, unknown>;

    // Expected shape matches Python FinalVerdict.to_dict() exactly:
    // - top-level keys: schema, final, final_reason, gauntlet, checks, error, economics
    // - gauntlet: {status, summary, reasoning, run_id} (snake_case run_id!)
    // - checks[]: {check, args, negated, passed, detail, phase}
    // - error: null
    // - economics: null
    const expected = {
      schema: 1,
      final: "pass",
      final_reason: "Gauntlet-Agent passed; 1 post-check(s) passed",
      gauntlet: {
        status: "pass",
        summary: "All ACs met",
        reasoning: "The agent did everything correctly.",
        run_id: "run-abc-123",
      },
      checks: [
        {
          check: "file-exists",
          args: ["output.txt"],
          negated: false,
          passed: true,
          detail: null,
          phase: "post",
        },
      ],
      error: null,
      economics: null,
    };

    expect(d).toEqual(expected);
  });
});
