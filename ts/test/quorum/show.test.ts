import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ShowError,
  isBatchDir,
  render,
  renderBatch,
  resolveTarget,
  _formatEconomicsPane,
  _fmtBytes,
} from "../../src/quorum/show.ts";

// ---- helpers ----

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "show-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeRun(root: string, name: string, ageSeconds = 0): string {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "verdict.json"), '{"schema":1,"final":"pass"}');
  if (ageSeconds) {
    const t = Date.now() / 1000 - ageSeconds;
    fs.utimesSync(path.join(d, "verdict.json"), t, t);
  }
  return d;
}

// ---------- resolver ----------------------------------------------------

describe("resolveTarget", () => {
  test("omitted picks newest", () => {
    const root = path.join(tmp, "results");
    fs.mkdirSync(root);
    makeRun(root, "old-claude-20260501T000000Z-aaaa", 10000);
    const newer = makeRun(root, "new-claude-20260523T000000Z-bbbb");
    expect(resolveTarget(undefined, root)).toBe(newer);
  });

  test("path to run dir", () => {
    const root = path.join(tmp, "results");
    fs.mkdirSync(root);
    const run = makeRun(root, "x-claude-20260523T000000Z-aaaa");
    expect(resolveTarget(run, root)).toBe(run);
  });

  test("path to verdict.json", () => {
    const root = path.join(tmp, "results");
    fs.mkdirSync(root);
    const run = makeRun(root, "x-claude-20260523T000000Z-aaaa");
    expect(resolveTarget(path.join(run, "verdict.json"), root)).toBe(run);
  });

  test("prefix match newest", () => {
    const root = path.join(tmp, "results");
    fs.mkdirSync(root);
    makeRun(root, "worktree-flow-claude-20260501T000000Z-aaaa", 10000);
    const newer = makeRun(root, "worktree-flow-claude-20260523T000000Z-bbbb");
    expect(resolveTarget("worktree-flow", root)).toBe(newer);
  });

  test("prefix greedy picks newest across variants", () => {
    const root = path.join(tmp, "results");
    fs.mkdirSync(root);
    makeRun(root, "worktree-already-inside-claude-20260501T000000Z-a", 10000);
    const newer = makeRun(root, "worktree-consent-flow-claude-20260523T000000Z-b");
    expect(resolveTarget("worktree", root)).toBe(newer);
  });

  test("no match raises", () => {
    const root = path.join(tmp, "results");
    fs.mkdirSync(root);
    expect(() => resolveTarget("does-not-exist", root)).toThrow(/no run-dir resolved/);
  });

  test("empty results root (omitted) raises", () => {
    const root = path.join(tmp, "results");
    fs.mkdirSync(root);
    expect(() => resolveTarget(undefined, root)).toThrow(/no run-dir resolved/);
  });

  test("path without verdict.json raises", () => {
    const bad = path.join(tmp, "not-a-run");
    fs.mkdirSync(bad);
    expect(() => resolveTarget(bad, tmp)).toThrow(/no verdict.json/);
  });

  test("missing results root, omitted target", () => {
    const nope = path.join(tmp, "does-not-exist");
    expect(() => resolveTarget(undefined, nope)).toThrow(/results root does not exist/);
  });

  test("missing results root, prefix target", () => {
    const nope = path.join(tmp, "does-not-exist");
    expect(() => resolveTarget("worktree", nope)).toThrow(/results root does not exist/);
  });

  test("absolute nonexistent path does not crash on glob", () => {
    const root = path.join(tmp, "results");
    fs.mkdirSync(root);
    const typo = "/Users/me/typo-run-dir";
    expect(() => resolveTarget(typo, root)).toThrow(/no run-dir resolved/);
  });

  test("ShowError is an Error subclass", () => {
    expect(() => resolveTarget("nope", path.join(tmp, "missing"))).toThrow(ShowError);
  });
});

// ---------- renderer fixtures -------------------------------------------

function verdictFailPassJudge(): Record<string, unknown> {
  return {
    schema: 1,
    final: "fail",
    final_reason: "1 post-check(s) failed",
    gauntlet: {
      status: "pass",
      summary: "The agent created a worktree for notifications.",
      reasoning: "Both ACs satisfied: (1) agent proceeded; (2) worktree created.",
      run_id: "worktree-consent-flow_20260523T215258Z_22i6",
    },
    checks: [
      { check: "git-repo", args: [], negated: false, passed: true, detail: null, phase: "pre" },
      {
        check: "git-branch",
        args: ["main"],
        negated: false,
        passed: true,
        detail: null,
        phase: "pre",
      },
      {
        check: "git-count",
        args: ["worktrees", "eq", "2"],
        negated: false,
        passed: false,
        detail: "worktrees count 1 not eq 2",
        phase: "post",
      },
    ],
    error: null,
  };
}

// ---------- renderer: full mode -----------------------------------------

describe("render full mode", () => {
  test("contains canonical fields", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const out = render(verdictFailPassJudge(), runDir, { color: false, mode: "full" });
    expect(out).toContain(runDir);
    expect(out).toContain("final");
    expect(out).toContain("fail");
    expect(out).toContain("1 post-check(s) failed");
    expect(out).toContain("Gauntlet-Agent");
    expect(out).toContain("The agent created a worktree for notifications.");
    expect(out).toContain("Both ACs satisfied");
    expect(out).toContain("git-repo");
    expect(out).toContain("git-count worktrees eq 2");
    expect(out).toContain("worktrees count 1 not eq 2");
    expect(out).toContain("triaging-a-failing-eval.md");
  });

  test("separates pre and post", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const out = render(verdictFailPassJudge(), runDir, { color: false, mode: "full" });
    expect(out.indexOf("git-repo")).toBeLessThan(out.indexOf("git-count"));
  });

  test("failing check shows detail after the check", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const out = render(verdictFailPassJudge(), runDir, { color: false, mode: "full" });
    expect(out.indexOf("worktrees count 1 not eq 2")).toBeGreaterThan(out.indexOf("git-count"));
  });

  test("matches golden byte-for-byte (plain)", () => {
    const out = render(verdictFailPassJudge(), "/tmp/run", { color: false, mode: "full" });
    const golden =
      "run-dir   /tmp/run\n" +
      "final     fail\n" +
      "reason    1 post-check(s) failed\n" +
      "\n" +
      "─── Gauntlet-Agent ───────────────────────────────\n" +
      "status    pass\n" +
      "summary   The agent created a worktree for notifications.\n" +
      "reasoning Both ACs satisfied: (1) agent proceeded; (2) worktree created.\n" +
      "\n" +
      "─── Deterministic checks ─────────────────────────\n" +
      "pre  ✓ git-repo\n" +
      "pre  ✓ git-branch main\n" +
      "post ✗ git-count worktrees eq 2\n" +
      "       ↳ worktrees count 1 not eq 2\n" +
      "\n" +
      "see docs/superpowers/skills/triaging-a-failing-eval.md for triage.\n";
    expect(out).toBe(golden);
  });
});

// ---------- renderer: quiet + json --------------------------------------

describe("render quiet + json", () => {
  test("quiet two lines", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const out = render(verdictFailPassJudge(), runDir, { color: false, mode: "quiet" });
    const lines = out.split("\n").filter((_, i, arr) => i < arr.length - 1 || arr[i] !== "");
    // splitlines() semantics: trailing newline not a separate element
    const splitLines = out.replace(/\n$/, "").split("\n");
    expect(splitLines.length).toBe(2);
    expect(splitLines[0]!.startsWith("final")).toBe(true);
    expect(splitLines[1]!.startsWith("reason")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
    void lines;
  });

  test("json is valid verdict json", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const v = verdictFailPassJudge();
    const out = render(v, runDir, { color: false, mode: "json" });
    const parsed = JSON.parse(out);
    expect(parsed.schema).toBe(1);
    expect(parsed.final).toBe("fail");
    expect(parsed.checks.length).toBe(3);
  });
});

// ---------- renderer: other verdict shapes ------------------------------

describe("render other shapes", () => {
  test("pass verdict", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const v = {
      schema: 1,
      final: "pass",
      final_reason: "Gauntlet-Agent passed; 2 post-check(s) passed",
      gauntlet: { status: "pass", summary: "ok", reasoning: "ok", run_id: "x_20260523T000000Z_0000" },
      checks: [
        { check: "file-exists", args: ["x.md"], negated: false, passed: true, detail: null, phase: "post" },
      ],
      error: null,
    };
    const out = render(v, runDir, { color: false, mode: "full" });
    expect(out).toContain("pass");
    expect(out).toContain("✓");
  });

  test("indeterminate with error", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const v = {
      schema: 1,
      final: "indeterminate",
      final_reason: "setup.sh crashed (exit 2)",
      gauntlet: null,
      checks: [],
      error: { stage: "setup", message: "setup.sh exit 2" },
    };
    const out = render(v, runDir, { color: false, mode: "full" });
    expect(out).toContain("indeterminate");
    expect(out).toContain("setup.sh crashed");
    expect(out).toContain("Gauntlet-Agent");
  });
});

// ---------- renderer: ANSI color ----------------------------------------

describe("render color", () => {
  test("full color injects ansi", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const out = render(verdictFailPassJudge(), runDir, { color: true, mode: "full" });
    expect(out).toContain("\x1b[");
    const hasRed =
      out.includes("\x1b[31m") || out.includes("\x1b[91m") || out.includes("\x1b[38;2;255;85;85m");
    expect(hasRed).toBe(true);
  });

  test("full color yellow on indeterminate", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const v = {
      schema: 1,
      final: "indeterminate",
      final_reason: "pre-check(s) failed",
      gauntlet: { status: "pass", summary: "s", reasoning: "r", run_id: "x_z_0" },
      checks: [],
      error: null,
    };
    const out = render(v, runDir, { color: true, mode: "full" });
    const hasYellow =
      out.includes("\x1b[33m") || out.includes("\x1b[93m") || out.includes("\x1b[38;2;241;250;140m");
    expect(hasYellow).toBe(true);
  });

  test("no color omits ansi", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const out = render(verdictFailPassJudge(), runDir, { color: false, mode: "full" });
    expect(out).not.toContain("\x1b[");
  });

  test("quiet color skipped", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const out = render(verdictFailPassJudge(), runDir, { color: true, mode: "quiet" });
    expect(out).not.toContain("\x1b[");
  });

  test("color full golden byte-for-byte", () => {
    const out = render(verdictFailPassJudge(), "/tmp/run", { color: true, mode: "full" });
    const L = (t: string) => `\x1b[38;2;122;130;148m\x1b[22m\x1b[22m${t}\x1b[0m`;
    const cyan = (t: string) => `\x1b[96m\x1b[1m\x1b[22m${t}\x1b[0m`;
    const golden =
      `${L("run-dir  ")} /tmp/run\n` +
      `${L("final    ")} \x1b[38;2;255;85;85m\x1b[1m\x1b[22mfail\x1b[0m\n` +
      `${L("reason   ")} 1 post-check(s) failed\n` +
      "\n" +
      `${cyan("─── Gauntlet-Agent ───────────────────────────────")}\n` +
      `${L("status   ")} \x1b[38;2;80;250;123m\x1b[1m\x1b[22mpass\x1b[0m\n` +
      `${L("summary  ")} The agent created a worktree for notifications.\n` +
      `${L("reasoning")} Both ACs satisfied: (1) agent proceeded; (2) worktree created.\n` +
      "\n" +
      `${cyan("─── Deterministic checks ─────────────────────────")}\n` +
      `\x1b[94m\x1b[22m\x1b[22mpre \x1b[0m \x1b[38;2;80;250;123m\x1b[1m\x1b[22m✓\x1b[0m git-repo\n` +
      `\x1b[94m\x1b[22m\x1b[22mpre \x1b[0m \x1b[38;2;80;250;123m\x1b[1m\x1b[22m✓\x1b[0m git-branch main\n` +
      `\x1b[94m\x1b[22m\x1b[22mpost\x1b[0m \x1b[38;2;255;85;85m\x1b[1m\x1b[22m✗\x1b[0m git-count worktrees eq 2\n` +
      `\x1b[31m\x1b[22m\x1b[22m       ↳ worktrees count 1 not eq 2\x1b[0m\n` +
      "\n" +
      "see docs/superpowers/skills/triaging-a-failing-eval.md for triage.\n";
    expect(out).toBe(golden);
  });
});

// ---------- renderer: batch matrix --------------------------------------

function seedBatch(
  root: string,
  agents: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const outRoot = path.join(root, "results");
  const batchDir = path.join(outRoot, "batches", "20260526T180000Z-abcd");
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(
    path.join(batchDir, "batch.json"),
    JSON.stringify({
      schema_version: 1,
      id: "20260526T180000Z-abcd",
      started_at: "2026-05-26T18:00:00+00:00",
      finished_at: "2026-05-26T18:03:41+00:00",
      coding_agents: agents,
      jobs: 1,
    }),
  );
  const lines: string[] = [];
  for (const r of rows) {
    const verdict = r["_verdict"] ?? "pass";
    const reason = r["_reason"] ?? "ok";
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!k.startsWith("_")) clean[k] = v;
    }
    lines.push(JSON.stringify(clean));
    if (r["run_id"]) {
      const runDir = path.join(outRoot, r["run_id"] as string);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "verdict.json"),
        JSON.stringify({ final: verdict, final_reason: reason, gauntlet: {}, checks: {}, error: null }),
      );
    }
  }
  fs.writeFileSync(path.join(batchDir, "results.jsonl"), lines.join("\n") + "\n");
  return batchDir;
}

describe("renderBatch", () => {
  test("matrix two agents", () => {
    const batchDir = seedBatch(tmp, ["claude", "codex"], [
      { scenario: "foo", coding_agent: "claude", run_id: "foo-claude-x", _verdict: "pass" },
      { scenario: "foo", coding_agent: "codex", run_id: null, skipped: "directive" },
      { scenario: "bar", coding_agent: "claude", run_id: "bar-claude-x", _verdict: "fail" },
      { scenario: "bar", coding_agent: "codex", run_id: "bar-codex-x", _verdict: "indeterminate" },
    ]);
    const out = renderBatch({ batchDir, resultsRoot: path.join(tmp, "results"), color: false });
    expect(out).toContain("scenario");
    expect(out).toContain("claude");
    expect(out).toContain("codex");
    expect(out).toContain("✓ pass");
    expect(out).toContain("✗ fail");
    expect(out).toContain("⊘ indet");
    expect(out).toContain("— skip");
    expect(out).toContain("Legend:");
    expect(out).toContain("1 ✓");
    expect(out).toContain("1 ✗");
    expect(out).toContain("1 ⊘");
    expect(out).toContain("1 —");
  });

  test("matrix golden byte-for-byte (plain)", () => {
    const batchDir = seedBatch(tmp, ["claude", "codex"], [
      { scenario: "foo", coding_agent: "claude", run_id: "foo-claude-x", _verdict: "pass" },
      { scenario: "foo", coding_agent: "codex", run_id: null, skipped: "directive" },
      { scenario: "bar", coding_agent: "claude", run_id: "bar-claude-x", _verdict: "fail" },
      { scenario: "bar", coding_agent: "codex", run_id: "bar-codex-x", _verdict: "indeterminate" },
    ]);
    const out = renderBatch({ batchDir, resultsRoot: path.join(tmp, "results"), color: false });
    const golden =
      "batch 20260526T180000Z-abcd · started 2026-05-26T18:00:00+00:00 · finished 2026-05-26T18:03:41+00:00\n" +
      "\n" +
      "| scenario | claude  | codex   |\n" +
      "|----------|---------|---------|\n" +
      "| bar      | ✗ fail  | ⊘ indet |\n" +
      "| foo      | ✓ pass  | — skip  |\n" +
      "\n" +
      "Legend: ✓ pass   ✗ fail   ⊘ indeterminate   — skipped (directive)   ? no verdict\n" +
      "1 ✓ · 1 ✗ · 1 ⊘ · 1 —\n";
    expect(out).toBe(golden);
  });

  test("missing verdict renders question glyph", () => {
    const batchDir = seedBatch(tmp, ["claude"], [
      { scenario: "foo", coding_agent: "claude", run_id: "ghost" },
    ]);
    const out = renderBatch({ batchDir, resultsRoot: path.join(tmp, "results"), color: false });
    expect(out).toContain("?");
  });

  test("emits ansi when color true; none when false", () => {
    const batchDir = seedBatch(tmp, ["claude"], [
      { scenario: "foo", coding_agent: "claude", run_id: "foo-claude-x", _verdict: "pass" },
    ]);
    const out = renderBatch({ batchDir, resultsRoot: path.join(tmp, "results"), color: true });
    expect(out).toContain("\x1b[");
    const outPlain = renderBatch({ batchDir, resultsRoot: path.join(tmp, "results"), color: false });
    expect(outPlain).not.toContain("\x1b[");
  });

  test("color matrix golden byte-for-byte", () => {
    const batchDir = seedBatch(tmp, ["claude", "codex"], [
      { scenario: "foo", coding_agent: "claude", run_id: "foo-claude-x", _verdict: "pass" },
      { scenario: "foo", coding_agent: "codex", run_id: null, skipped: "directive" },
      { scenario: "bar", coding_agent: "claude", run_id: "bar-claude-x", _verdict: "fail" },
      { scenario: "bar", coding_agent: "codex", run_id: "bar-codex-x", _verdict: "indeterminate" },
    ]);
    const out = renderBatch({ batchDir, resultsRoot: path.join(tmp, "results"), color: true });
    const golden =
      "batch 20260526T180000Z-abcd · started 2026-05-26T18:00:00+00:00 · finished 2026-05-26T18:03:41+00:00\n" +
      "\n" +
      "| scenario | claude  | codex   |\n" +
      "|----------|---------|---------|\n" +
      "| bar      | \x1b[38;2;255;85;85m✗ fail \x1b[0m | \x1b[38;2;241;250;140m⊘ indet\x1b[0m |\n" +
      "| foo      | \x1b[38;2;80;250;123m✓ pass \x1b[0m | \x1b[38;2;122;130;148m— skip \x1b[0m |\n" +
      "\n" +
      "Legend: ✓ pass   ✗ fail   ⊘ indeterminate   — skipped (directive)   ? no verdict\n" +
      "1 ✓ · 1 ✗ · 1 ⊘ · 1 —\n";
    expect(out).toBe(golden);
  });
});

// ---------- resolver: batch-dir handling --------------------------------

describe("batch-dir resolution", () => {
  test("returns batch dir for batch id", () => {
    const outRoot = path.join(tmp, "results");
    const batchDir = path.join(outRoot, "batches", "20260526T180000Z-abcd");
    fs.mkdirSync(batchDir, { recursive: true });
    fs.writeFileSync(path.join(batchDir, "batch.json"), "{}");
    expect(resolveTarget("20260526T180000Z-abcd", outRoot)).toBe(batchDir);
  });

  test("returns batch dir for explicit path", () => {
    const outRoot = path.join(tmp, "results");
    const batchDir = path.join(outRoot, "batches", "20260526T180000Z-abcd");
    fs.mkdirSync(batchDir, { recursive: true });
    fs.writeFileSync(path.join(batchDir, "batch.json"), "{}");
    expect(resolveTarget(batchDir, outRoot)).toBe(batchDir);
  });

  test("isBatchDir", () => {
    const batchDir = path.join(tmp, "20260526T180000Z-abcd");
    fs.mkdirSync(batchDir);
    fs.writeFileSync(path.join(batchDir, "batch.json"), "{}");
    expect(isBatchDir(batchDir)).toBe(true);

    const runDir = path.join(tmp, "foo-claude-20260526T180000Z-abcd");
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, "verdict.json"), "{}");
    expect(isBatchDir(runDir)).toBe(false);
  });
});

// ---------- economics pane ----------------------------------------------

describe("economics pane", () => {
  test("render includes economics pane", () => {
    const verdict = {
      final: "pass",
      final_reason: "ok",
      gauntlet: { status: "pass", summary: "", reasoning: "" },
      checks: [],
      economics: {
        pricing_asof: "2026-05",
        gauntlet: { duration_ms: 1885117, model: "claude-sonnet-4-6", tokens: { total: 7100000 }, est_cost_usd: 0.42 },
        coding_agent: { duration_ms: 1443000, model: "gpt-5.5", tokens: { total: 2300000 }, est_cost_usd: 1.85 },
        total_est_cost_usd: 2.27,
        partial: false,
      },
    };
    const out = render(verdict, "/tmp/run", { color: false, mode: "full" });
    expect(out).toContain("Economics");
    expect(out).toContain("$2.27");
    expect(out).toContain("Gauntlet");
    expect(out).toContain("Coding");
  });

  test("economics render golden (plain)", () => {
    const verdict = {
      final: "pass",
      final_reason: "ok",
      gauntlet: { status: "pass", summary: "", reasoning: "" },
      checks: [],
      economics: {
        pricing_asof: "2026-05",
        gauntlet: { duration_ms: 1885117, model: "claude-sonnet-4-6", tokens: { total: 7100000 }, est_cost_usd: 0.42 },
        coding_agent: { duration_ms: 1443000, model: "gpt-5.5", tokens: { total: 2300000 }, est_cost_usd: 1.85 },
        total_est_cost_usd: 2.27,
        partial: false,
      },
    };
    const out = render(verdict, "/tmp/run", { color: false, mode: "full" });
    const golden =
      "run-dir   /tmp/run\n" +
      "final     pass\n" +
      "reason    ok\n" +
      "\n" +
      "─── Gauntlet-Agent ───────────────────────────────\n" +
      "status    pass\n" +
      "summary   \n" +
      "reasoning \n" +
      "\n" +
      "─── Deterministic checks ─────────────────────────\n" +
      "\n" +
      "─── Economics ────────────────────────────────────\n" +
      "               duration    tokens  est cost\n" +
      "  Gauntlet      31m 25s      7.1M     $0.42\n" +
      "  Coding        24m 03s      2.3M     $1.85\n" +
      "  total                               $2.27\n" +
      "\n" +
      "see docs/superpowers/skills/triaging-a-failing-eval.md for triage.\n";
    expect(out).toBe(golden);
  });

  test("absent is safe", () => {
    const verdict = {
      final: "pass",
      final_reason: "",
      gauntlet: { status: "pass" },
      checks: [],
    };
    const out = render(verdict, "/tmp/run", { color: false, mode: "full" });
    expect(typeof out).toBe("string");
  });

  test("per-model subrows", () => {
    const verdict = {
      final: "pass",
      final_reason: "ok",
      gauntlet: { status: "pass", summary: "", reasoning: "" },
      checks: [],
      economics: {
        pricing_asof: "2026-05",
        gauntlet: { duration_ms: 1000, model: "claude-sonnet-4-6", tokens: { total: 4300000 }, est_cost_usd: 1.71 },
        coding_agent: {
          duration_ms: 2000,
          model: "claude-opus-4-7",
          tokens: { total: 27500000 },
          est_cost_usd: 32.98,
          models: [
            { model: "claude-opus-4-7", tokens: { total: 9700000 }, est_cost_usd: 25.09 },
            { model: "claude-sonnet-4-6", tokens: { total: 11400000 }, est_cost_usd: 6.5 },
            { model: "claude-haiku-4-5-20251001", tokens: { total: 6400000 }, est_cost_usd: 1.39 },
          ],
        },
        total_est_cost_usd: 34.69,
        partial: false,
      },
    };
    const out = render(verdict, "/tmp/run", { color: false, mode: "full" });
    expect(out).toContain("opus");
    expect(out).toContain("sonnet");
    expect(out).toContain("haiku");
    expect(out).toContain("$25.09");
    expect(out).toContain("$6.50");
    expect(out).toContain("$1.39");
    expect(out).toContain("$34.69");
  });

  test("per-model subrows golden pane", () => {
    const verdict = {
      economics: {
        pricing_asof: "2026-05",
        gauntlet: { duration_ms: 1000, model: "claude-sonnet-4-6", tokens: { total: 4300000 }, est_cost_usd: 1.71 },
        coding_agent: {
          duration_ms: 2000,
          model: "claude-opus-4-7",
          tokens: { total: 27500000 },
          est_cost_usd: 32.98,
          models: [
            { model: "claude-opus-4-7", tokens: { total: 9700000 }, est_cost_usd: 25.09 },
            { model: "claude-sonnet-4-6", tokens: { total: 11400000 }, est_cost_usd: 6.5 },
            { model: "claude-haiku-4-5-20251001", tokens: { total: 6400000 }, est_cost_usd: 1.39 },
          ],
        },
        total_est_cost_usd: 34.69,
        partial: false,
      },
    };
    const pane = _formatEconomicsPane(verdict, false);
    const golden =
      "─── Economics ────────────────────────────────────\n" +
      "               duration    tokens  est cost\n" +
      "  Gauntlet       0m 01s      4.3M     $1.71\n" +
      "  Coding         0m 02s     27.5M    $32.98\n" +
      "    opus                     9.7M    $25.09\n" +
      "    sonnet                  11.4M     $6.50\n" +
      "    haiku                    6.4M     $1.39\n" +
      "  total                              $34.69\n";
    expect(pane).toBe(golden);
  });

  test("pricing footnote", () => {
    const verdict = {
      final: "pass",
      final_reason: "ok",
      gauntlet: { status: "pass", summary: "", reasoning: "" },
      checks: [],
      economics: {
        pricing_asof: "2026-06-09",
        gauntlet: {
          duration_ms: 1000,
          model: "claude-sonnet-4-6",
          tokens: { total: 201 },
          est_cost_usd: 0.000432,
          obol: { pricing_as_of: "2026-06-09", approximations: [], unpriced_models: [], per_model: {} },
        },
        coding_agent: {
          duration_ms: 2000,
          model: "gpt-5.5",
          tokens: { total: 2160 },
          est_cost_usd: 0.01075,
          models: [],
          has_unpriced_model: false,
          obol: {
            pricing_as_of: "2026-06-09",
            approximations: [{ kind: "assumed_standard_tier", detail: null }],
            unpriced_models: [],
            per_model: {},
          },
        },
        total_est_cost_usd: 0.011182,
        partial: false,
      },
    };
    const out = render(verdict, tmp, { color: false, mode: "full" });
    expect(out).toContain("pricing: as of 2026-06-09");
    expect(out).toContain("assumed_standard_tier");
  });

  test("footnote golden pane", () => {
    const verdict = {
      economics: {
        pricing_asof: "2026-06-09",
        gauntlet: {
          duration_ms: 1000,
          model: "claude-sonnet-4-6",
          tokens: { total: 201 },
          est_cost_usd: 0.000432,
          obol: { pricing_as_of: "2026-06-09", approximations: [], unpriced_models: [], per_model: {} },
        },
        coding_agent: {
          duration_ms: 2000,
          model: "gpt-5.5",
          tokens: { total: 2160 },
          est_cost_usd: 0.01075,
          models: [],
          has_unpriced_model: false,
          obol: {
            pricing_as_of: "2026-06-09",
            approximations: [{ kind: "assumed_standard_tier", detail: null }],
            unpriced_models: [],
            per_model: {},
          },
        },
        total_est_cost_usd: 0.011182,
        partial: false,
      },
    };
    const pane = _formatEconomicsPane(verdict, false);
    const golden =
      "─── Economics ────────────────────────────────────\n" +
      "               duration    tokens  est cost\n" +
      "  Gauntlet       0m 01s        0K     $0.00\n" +
      "  Coding         0m 02s        2K     $0.01\n" +
      "  total                               $0.01\n" +
      "  pricing: as of 2026-06-09 · assumed_standard_tier\n";
    expect(pane).toBe(golden);
  });

  test("no provenance, no footnote", () => {
    const verdict = {
      final: "pass",
      final_reason: "ok",
      gauntlet: { status: "pass", summary: "", reasoning: "" },
      checks: [],
      economics: {
        gauntlet: { duration_ms: 1000, model: "m", tokens: { total: 1 }, est_cost_usd: 0.01 },
        coding_agent: null,
        total_est_cost_usd: null,
        partial: true,
      },
    };
    const out = render(verdict, tmp, { color: false, mode: "full" });
    expect(out).not.toContain("pricing:");
  });

  test("renders tool_result bytes", () => {
    const verdict = {
      economics: {
        gauntlet: null,
        coding_agent: {
          duration_ms: 1000,
          model: "kimi-for-coding",
          models: [],
          tokens: { total: 1000 },
          est_cost_usd: null,
          tool_result_total_bytes: 142772,
        },
        total_est_cost_usd: null,
        partial: true,
      },
    };
    const pane = _formatEconomicsPane(verdict, false);
    expect(pane).toContain("143KB");
  });

  test("tool bytes golden pane", () => {
    const verdict = {
      economics: {
        gauntlet: null,
        coding_agent: {
          duration_ms: 1000,
          model: "kimi-for-coding",
          models: [],
          tokens: { total: 1000 },
          est_cost_usd: null,
          tool_result_total_bytes: 142772,
        },
        total_est_cost_usd: null,
        partial: true,
      },
    };
    const pane = _formatEconomicsPane(verdict, false);
    const golden =
      "─── Economics ────────────────────────────────────\n" +
      "               duration    tokens  est cost\n" +
      "  Gauntlet            —         —         —\n" +
      "  Coding         0m 01s        1K n/a (kimi-for-coding)\n" +
      "  tool bytes                143KB          \n" +
      "  total                             partial\n";
    expect(pane).toBe(golden);
  });

  test("omits zero tool_result bytes", () => {
    const verdict = {
      economics: {
        gauntlet: null,
        coding_agent: {
          duration_ms: 1000,
          model: "kimi-for-coding",
          models: [],
          tokens: { total: 1000 },
          est_cost_usd: null,
          tool_result_total_bytes: 0,
        },
        total_est_cost_usd: null,
        partial: true,
      },
    };
    const pane = _formatEconomicsPane(verdict, false);
    expect(pane).not.toContain("tool bytes");
  });
});

describe("_fmtBytes", () => {
  test("all tiers", () => {
    expect(_fmtBytes(0)).toBe("—");
    expect(_fmtBytes(null)).toBe("—");
    expect(_fmtBytes(512)).toBe("512B");
    expect(_fmtBytes(142772)).toBe("143KB");
    expect(_fmtBytes(1500000)).toBe("1.5MB");
  });
});
