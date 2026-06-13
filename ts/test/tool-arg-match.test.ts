// Tests for the tool-arg-match verb — structured-matcher replacement for the
// old jq-driven shell tool.
//
// Covers the real scenario usages (jq form → new structured form) with both
// a PASS and a FAIL case each, plus parser unit tests for the contract edges
// (comma-fallback keys, split-on-first-=, --ignore-case, POSIX classes).

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtifTrajectory } from "../src/atif/types.ts";
import type { ToolCallView } from "../src/atif/project.ts";
import { verbToolArgMatch, parseToolArgMatchArgs } from "../src/check/verbs.ts";

function call(tool: string, args: Record<string, unknown> = {}): ToolCallView {
  return { tool, args };
}

function makeTrajectory(calls: ToolCallView[]): AtifTrajectory {
  return {
    schema_version: "ATIF-v1.7",
    agent: { name: "test-agent", version: "0.0.0" },
    steps: [
      {
        step_id: 1,
        source: "agent",
        tool_calls: calls.map((c, i) => ({
          tool_call_id: `tc${i}`,
          function_name: c.tool,
          arguments: c.args,
        })),
      },
    ],
  };
}

const CLI_PATH = join(import.meta.dir, "../src/cli/check-transcript.ts");

interface SpawnResult {
  exitCode: number;
  stderr: string;
  lastRecord: Record<string, unknown> | null;
}

async function runCLI(verbAndArgs: string[], calls: ToolCallView[]): Promise<SpawnResult> {
  const dir = mkdtempSync(join(tmpdir(), "tool-arg-match-test-"));
  const trajectoryPath = join(dir, "trajectory.json");
  const sinkPath = join(dir, "sink.jsonl");
  await Bun.write(trajectoryPath, JSON.stringify(makeTrajectory(calls)));

  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...verbAndArgs], {
    env: {
      ...process.env,
      QUORUM_TRANSCRIPT_PATH: trajectoryPath,
      QUORUM_RECORD_SINK: sinkPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  let lastRecord: Record<string, unknown> | null = null;
  try {
    const sinkContent = readFileSync(sinkPath, "utf8").trim();
    if (sinkContent) {
      const lines = sinkContent.split("\n").filter(Boolean);
      lastRecord = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    }
  } catch {
    // no sink
  }
  rmSync(dir, { recursive: true });
  return { exitCode, stderr, lastRecord };
}

// ---------------------------------------------------------------------------
// Parser unit tests
// ---------------------------------------------------------------------------

test("parse: --eq splits on first '=' only (value may contain '=')", () => {
  const p = parseToolArgMatchArgs(["Bash", "--eq", "command=a=b=c"]);
  expect(p.tool).toBe("Bash");
  expect(p.matchers).toEqual([{ keys: ["command"], kind: "eq", expected: "a=b=c" }]);
});

test("parse: comma-separated fallback keys", () => {
  const p = parseToolArgMatchArgs(["Write", "--matches", "path,file_path=foo"]);
  expect(p.matchers[0]!.keys).toEqual(["path", "file_path"]);
  expect(p.matchers[0]!.kind).toBe("matches");
});

test("parse: --ignore-case flag", () => {
  const p = parseToolArgMatchArgs(["Agent", "--matches", "prompt=x", "--ignore-case"]);
  expect(p.ignoreCase).toBe(true);
});

test("parse: multiple matchers ANDed", () => {
  const p = parseToolArgMatchArgs([
    "Bash",
    "--eq",
    "command=ls",
    "--matches",
    "command=l",
  ]);
  expect(p.matchers).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// Scenario usage 1: Skill --eq skill=superpowers:brainstorming
// ---------------------------------------------------------------------------

test("usage1 Skill --eq skill: PASS", () => {
  const r = verbToolArgMatch(
    [call("Skill", { skill: "superpowers:brainstorming" })],
    false,
    ["Skill", "--eq", "skill=superpowers:brainstorming"],
  );
  expect(r.passed).toBe(true);
});

test("usage1 Skill --eq skill: FAIL (different skill)", () => {
  const r = verbToolArgMatch(
    [call("Skill", { skill: "superpowers:writing-plans" })],
    false,
    ["Skill", "--eq", "skill=superpowers:brainstorming"],
  );
  expect(r.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// Scenario usage 2: Bash --matches command=codex-tools[.]md
// ---------------------------------------------------------------------------

test("usage2 Bash --matches command=codex-tools[.]md: PASS", () => {
  const r = verbToolArgMatch(
    [call("Bash", { command: "cat docs/codex-tools.md" })],
    false,
    ["Bash", "--matches", "command=codex-tools[.]md"],
  );
  expect(r.passed).toBe(true);
});

test("usage2 Bash --matches command=codex-tools[.]md: FAIL (codex-toolsXmd not literal dot)", () => {
  // '.' in jq's regex is a literal-dot bracket-class [.] — must NOT match 'codex-toolsXmd'
  const r = verbToolArgMatch(
    [call("Bash", { command: "cat codex-toolsXmd" })],
    false,
    ["Bash", "--matches", "command=codex-tools[.]md"],
  );
  expect(r.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// Scenario usage 3: Read --eq path=<abs path>
// ---------------------------------------------------------------------------

test("usage3 Read --eq path: PASS", () => {
  const r = verbToolArgMatch(
    [call("Read", { path: "/run/workdir/PLAN.md" })],
    false,
    ["Read", "--eq", "path=/run/workdir/PLAN.md"],
  );
  expect(r.passed).toBe(true);
});

test("usage3 Read --eq path: FAIL (different path)", () => {
  const r = verbToolArgMatch(
    [call("Read", { path: "/run/workdir/OTHER.md" })],
    false,
    ["Read", "--eq", "path=/run/workdir/PLAN.md"],
  );
  expect(r.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// Scenario usage 4: Write --matches path,file_path=(^|/)PI_SUPERPOWERS_OK[.]md$
// (field fallback: path missing → use file_path)
// ---------------------------------------------------------------------------

test("usage4 Write --matches path,file_path (fallback to file_path): PASS", () => {
  const r = verbToolArgMatch(
    [call("Write", { file_path: "/run/workdir/PI_SUPERPOWERS_OK.md" })],
    false,
    ["Write", "--matches", "path,file_path=(^|/)PI_SUPERPOWERS_OK[.]md$"],
  );
  expect(r.passed).toBe(true);
});

test("usage4 Write --matches path,file_path: first-present-key wins (path present but wrong → FAIL)", () => {
  // path IS present (empty-ish wrong value); jq's // uses first PRESENT key,
  // so file_path is NOT consulted even though it would match.
  const r = verbToolArgMatch(
    [
      call("Write", {
        path: "/run/workdir/NOPE.md",
        file_path: "/run/workdir/PI_SUPERPOWERS_OK.md",
      }),
    ],
    false,
    ["Write", "--matches", "path,file_path=(^|/)PI_SUPERPOWERS_OK[.]md$"],
  );
  expect(r.passed).toBe(false);
});

test("usage4 Write --matches path,file_path: FAIL when neither matches", () => {
  const r = verbToolArgMatch(
    [call("Write", { file_path: "/run/workdir/SOMETHING.md" })],
    false,
    ["Write", "--matches", "path,file_path=(^|/)PI_SUPERPOWERS_OK[.]md$"],
  );
  expect(r.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// Scenario usage 5: Agent --matches prompt=collapse runs of hyphens --ignore-case
// ---------------------------------------------------------------------------

test("usage5 Agent --matches prompt --ignore-case: PASS (case differs)", () => {
  const r = verbToolArgMatch(
    [call("Agent", { prompt: "Please COLLAPSE RUNS OF HYPHENS in the slug" })],
    false,
    ["Agent", "--matches", "prompt=collapse runs of hyphens", "--ignore-case"],
  );
  expect(r.passed).toBe(true);
});

test("usage5 Agent --matches prompt WITHOUT --ignore-case: FAIL (case differs)", () => {
  const r = verbToolArgMatch(
    [call("Agent", { prompt: "Please COLLAPSE RUNS OF HYPHENS in the slug" })],
    false,
    ["Agent", "--matches", "prompt=collapse runs of hyphens"],
  );
  expect(r.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// Scenario usage 6: Bash --matches command=git[[:space:]]+worktree[[:space:]]+add
// (POSIX class must work via posixToJsRegex)
// ---------------------------------------------------------------------------

test("usage6 Bash --matches command=git[[:space:]]+worktree[[:space:]]+add: PASS on 'git worktree add'", () => {
  const r = verbToolArgMatch(
    [call("Bash", { command: "git worktree add ../wt feature" })],
    false,
    ["Bash", "--matches", "command=git[[:space:]]+worktree[[:space:]]+add"],
  );
  expect(r.passed).toBe(true);
});

test("usage6 Bash --matches command=git[[:space:]]+...: FAIL on unrelated command", () => {
  const r = verbToolArgMatch(
    [call("Bash", { command: "git status" })],
    false,
    ["Bash", "--matches", "command=git[[:space:]]+worktree[[:space:]]+add"],
  );
  expect(r.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// Multiple matchers ANDed
// ---------------------------------------------------------------------------

test("ANDed matchers: PASS only when ALL satisfied", () => {
  const r = verbToolArgMatch(
    [call("Bash", { command: "git worktree add ../wt", cwd: "/repo" })],
    false,
    ["Bash", "--matches", "command=worktree", "--eq", "cwd=/repo"],
  );
  expect(r.passed).toBe(true);
});

test("ANDed matchers: FAIL when one matcher fails", () => {
  const r = verbToolArgMatch(
    [call("Bash", { command: "git worktree add ../wt", cwd: "/other" })],
    false,
    ["Bash", "--matches", "command=worktree", "--eq", "cwd=/repo"],
  );
  expect(r.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// Existence semantics: empty transcript naturally fails (no empty guard)
// ---------------------------------------------------------------------------

test("empty transcript → FAIL (positive existence assertion)", () => {
  const r = verbToolArgMatch([], true, ["Bash", "--eq", "command=ls"]);
  expect(r.passed).toBe(false);
});

test("wrong tool name → FAIL even if args would match", () => {
  const r = verbToolArgMatch(
    [call("Edit", { command: "ls" })],
    false,
    ["Bash", "--eq", "command=ls"],
  );
  expect(r.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// E2E: CLI exit codes + record shape
// ---------------------------------------------------------------------------

test("E2E tool-arg-match PASS: exit 0, record passed=true, full argv in args", async () => {
  const r = await runCLI(
    ["tool-arg-match", "Skill", "--eq", "skill=superpowers:brainstorming"],
    [call("Skill", { skill: "superpowers:brainstorming" })],
  );
  expect(r.exitCode).toBe(0);
  expect(r.lastRecord!["passed"]).toBe(true);
  expect(r.lastRecord!["check"]).toBe("tool-arg-match");
  expect(r.lastRecord!["args"]).toEqual([
    "Skill",
    "--eq",
    "skill=superpowers:brainstorming",
  ]);
});

test("E2E tool-arg-match FAIL: exit 1, record passed=false", async () => {
  const r = await runCLI(
    ["tool-arg-match", "Skill", "--eq", "skill=superpowers:brainstorming"],
    [call("Bash", { command: "ls" })],
  );
  expect(r.exitCode).toBe(1);
  expect(r.lastRecord!["passed"]).toBe(false);
});

test("E2E tool-arg-match --ignore-case PASS via CLI", async () => {
  const r = await runCLI(
    [
      "tool-arg-match",
      "Agent",
      "--matches",
      "prompt=collapse runs of hyphens",
      "--ignore-case",
    ],
    [call("Agent", { prompt: "COLLAPSE RUNS OF HYPHENS now" })],
  );
  expect(r.exitCode).toBe(0);
  expect(r.lastRecord!["passed"]).toBe(true);
});
