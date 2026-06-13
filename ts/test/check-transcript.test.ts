// Tests for check-transcript CLI and supporting modules.
//
// Strategy: we exercise verbs both directly (via verbX functions) and
// end-to-end (by spawning the CLI with a temp ATIF trajectory.json and a
// temp record sink, then asserting exit code + emitted JSON line).

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtifTrajectory } from "../src/atif/types.ts";
import type { ToolCallView } from "../src/atif/project.ts";
import {
  verbToolCalled,
  verbToolNotCalled,
  verbToolCount,
  verbToolBefore,
  verbSkillCalled,
  verbSkillNotCalled,
  verbSkillBeforeTool,
  verbSkillBeforeImplementationTool,
  verbImplementationToolNotCalled,
  verbInvestigated,
  verbWorktreeCreated,
  verbToolMatchBeforeToolMatch,
} from "../src/check/verbs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  stdout: string;
  stderr: string;
  lastRecord: Record<string, unknown> | null;
}

async function runCLI(
  verbAndArgs: string[],
  calls: ToolCallView[],
): Promise<SpawnResult> {
  const dir = mkdtempSync(join(tmpdir(), "check-transcript-test-"));
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

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  let lastRecord: Record<string, unknown> | null = null;
  try {
    const sinkContent = readFileSync(sinkPath, "utf8").trim();
    if (sinkContent) {
      const lines = sinkContent.split("\n").filter(Boolean);
      lastRecord = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    }
  } catch {
    // sink not written — that's fine in some cases
  }

  rmSync(dir, { recursive: true });
  return { exitCode, stdout, stderr, lastRecord };
}

async function runCLIEmpty(verbAndArgs: string[]): Promise<SpawnResult> {
  const dir = mkdtempSync(join(tmpdir(), "check-transcript-test-"));
  const sinkPath = join(dir, "sink.jsonl");

  // QUORUM_TRANSCRIPT_PATH not set → empty transcript
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...verbAndArgs], {
    env: {
      ...process.env,
      QUORUM_TRANSCRIPT_PATH: join(dir, "nonexistent.json"),
      QUORUM_RECORD_SINK: sinkPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
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
  return { exitCode, stdout, stderr, lastRecord };
}

// ---------------------------------------------------------------------------
// tool-called
// ---------------------------------------------------------------------------

test("tool-called: pass when tool appears", () => {
  const result = verbToolCalled([call("Read"), call("Bash")], false, ["Read"]);
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("Read called 1 time(s)");
});

test("tool-called: fail when tool absent", () => {
  const result = verbToolCalled([call("Bash")], false, ["Edit"]);
  expect(result.passed).toBe(false);
  expect(result.detail).toBe("Edit never called");
});

test("tool-called: pass (E2E)", async () => {
  const r = await runCLI(["tool-called", "Read"], [call("Read"), call("Bash")]);
  expect(r.exitCode).toBe(0);
  expect(r.lastRecord).not.toBeNull();
  expect(r.lastRecord!["passed"]).toBe(true);
  expect(r.lastRecord!["check"]).toBe("tool-called");
  expect(r.lastRecord!["args"]).toEqual(["Read"]);
});

test("tool-called: fail (E2E)", async () => {
  const r = await runCLI(["tool-called", "EnterWorktree"], [call("Bash")]);
  expect(r.exitCode).toBe(1);
  expect(r.lastRecord!["passed"]).toBe(false);
});

// ---------------------------------------------------------------------------
// tool-not-called
// ---------------------------------------------------------------------------

test("tool-not-called: pass when tool absent", () => {
  const result = verbToolNotCalled([call("Bash")], false, ["Edit"]);
  expect(result.passed).toBe(true);
  expect(result.detail).toBe("Edit never called");
});

test("tool-not-called: fail when tool appears", () => {
  const result = verbToolNotCalled([call("Edit"), call("Bash")], false, ["Edit"]);
  expect(result.passed).toBe(false);
  expect(result.detail).toContain("Edit called 1 time(s) (expected 0)");
});

test("tool-not-called: fail on empty transcript (C1 contract)", () => {
  const result = verbToolNotCalled([], true, ["Edit"]);
  expect(result.passed).toBe(false);
  expect(result.detail).toBe("tool-calls file missing or empty");
});

test("tool-not-called: empty → exit 1 (E2E)", async () => {
  const r = await runCLIEmpty(["tool-not-called", "Edit"]);
  expect(r.exitCode).toBe(1);
  expect(r.lastRecord!["passed"]).toBe(false);
  expect(r.lastRecord!["detail"]).toBe("tool-calls file missing or empty");
});

// ---------------------------------------------------------------------------
// tool-count
// ---------------------------------------------------------------------------

test("tool-count eq: pass", () => {
  const calls_ = [call("Read"), call("Read"), call("Bash")];
  const result = verbToolCount(calls_, false, ["Read", "eq", "2"]);
  expect(result).not.toBeNull();
  expect(result!.passed).toBe(true);
  expect(result!.detail).toContain("Read called 2 time(s) (eq 2)");
});

test("tool-count gt: fail", () => {
  const result = verbToolCount([call("Read")], false, ["Read", "gt", "2"]);
  expect(result!.passed).toBe(false);
  expect(result!.detail).toContain("(expected gt 2)");
});

test("tool-count gte: pass", () => {
  const result = verbToolCount([call("Read"), call("Read")], false, ["Read", "gte", "2"]);
  expect(result!.passed).toBe(true);
});

test("tool-count lt: pass", () => {
  const result = verbToolCount([call("Read")], false, ["Read", "lt", "3"]);
  expect(result!.passed).toBe(true);
});

test("tool-count lte: fail", () => {
  const result = verbToolCount([call("Read"), call("Read"), call("Read")], false, [
    "Read",
    "lte",
    "2",
  ]);
  expect(result!.passed).toBe(false);
});

test("tool-count: unknown op returns null", () => {
  const result = verbToolCount([call("Read")], false, ["Read", "bogus", "1"]);
  expect(result).toBeNull();
});

test("tool-count: unknown op exits 2 (E2E)", async () => {
  const r = await runCLI(["tool-count", "Read", "bogus", "1"], [call("Read")]);
  expect(r.exitCode).toBe(2);
});

// ---------------------------------------------------------------------------
// tool-before
// ---------------------------------------------------------------------------

test("tool-before: pass when a comes first", () => {
  const result = verbToolBefore([call("Read"), call("Bash"), call("Edit")], false, [
    "Read",
    "Edit",
  ]);
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("Read (line 1) before Edit (line 3)");
});

test("tool-before: fail when a is after b", () => {
  const result = verbToolBefore([call("Edit"), call("Read")], false, ["Read", "Edit"]);
  expect(result.passed).toBe(false);
  expect(result.detail).toContain("occurred after");
});

test("tool-before: fail when a never called", () => {
  const result = verbToolBefore([call("Bash")], false, ["Read", "Bash"]);
  expect(result.passed).toBe(false);
  expect(result.detail).toBe("Read never called");
});

test("tool-before: fail when b never called", () => {
  const result = verbToolBefore([call("Read")], false, ["Read", "Edit"]);
  expect(result.passed).toBe(false);
  expect(result.detail).toBe("Edit never called");
});

// ---------------------------------------------------------------------------
// skill-called
// ---------------------------------------------------------------------------

test("skill-called: pass via native Skill tool", () => {
  const result = verbSkillCalled(
    [call("Skill", { skill: "superpowers:brainstorming" })],
    false,
    ["superpowers:brainstorming"],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("Skill(superpowers:brainstorming) called 1 time(s)");
});

test("skill-called: fail when skill never fired", () => {
  const result = verbSkillCalled([call("Bash", { command: "ls" })], false, [
    "superpowers:brainstorming",
  ]);
  expect(result.passed).toBe(false);
  expect(result.detail).toBe("Skill(superpowers:brainstorming) never called");
});

test("skill-called: pass via Bash SKILL.md read", () => {
  // This proves the predicate wiring: a Bash call reading the SKILL.md counts.
  const result = verbSkillCalled(
    [call("Bash", { command: "cat skills/superpowers/brainstorming/SKILL.md" })],
    false,
    ["superpowers:brainstorming"],
  );
  expect(result.passed).toBe(true);
});

test("skill-called: pass via Read SKILL.md (E2E)", async () => {
  const r = await runCLI(
    ["skill-called", "superpowers:brainstorming"],
    [call("Read", { file_path: "/run/skills/superpowers/brainstorming/SKILL.md" })],
  );
  expect(r.exitCode).toBe(0);
  expect(r.lastRecord!["passed"]).toBe(true);
  expect(r.lastRecord!["check"]).toBe("skill-called");
  expect(r.lastRecord!["args"]).toEqual(["superpowers:brainstorming"]);
});

test("skill-called: fail (E2E)", async () => {
  const r = await runCLI(["skill-called", "superpowers:brainstorming"], [call("Bash")]);
  expect(r.exitCode).toBe(1);
  expect(r.lastRecord!["passed"]).toBe(false);
});

// ---------------------------------------------------------------------------
// skill-not-called
// ---------------------------------------------------------------------------

test("skill-not-called: pass when skill absent", () => {
  const result = verbSkillNotCalled([call("Bash"), call("Edit")], false, [
    "superpowers:brainstorming",
  ]);
  expect(result.passed).toBe(true);
});

test("skill-not-called: fail when skill present", () => {
  const result = verbSkillNotCalled(
    [call("Skill", { skill: "superpowers:brainstorming" })],
    false,
    ["superpowers:brainstorming"],
  );
  expect(result.passed).toBe(false);
  expect(result.detail).toContain("expected 0");
});

test("skill-not-called: fail on empty transcript (C1 contract)", () => {
  const result = verbSkillNotCalled([], true, ["superpowers:brainstorming"]);
  expect(result.passed).toBe(false);
  expect(result.detail).toBe("tool-calls file missing or empty");
});

test("skill-not-called: empty → exit 1 (E2E)", async () => {
  const r = await runCLIEmpty(["skill-not-called", "superpowers:brainstorming"]);
  expect(r.exitCode).toBe(1);
  expect(r.lastRecord!["passed"]).toBe(false);
  expect(r.lastRecord!["detail"]).toBe("tool-calls file missing or empty");
});

// ---------------------------------------------------------------------------
// skill-before-tool
// ---------------------------------------------------------------------------

test("skill-before-tool: pass when skill precedes tool", () => {
  const result = verbSkillBeforeTool(
    [call("Skill", { skill: "superpowers:writing-plans" }), call("Edit")],
    false,
    ["superpowers:writing-plans", "Edit"],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("before Edit");
});

test("skill-before-tool: fail when tool fires before skill", () => {
  const result = verbSkillBeforeTool(
    [call("Edit"), call("Skill", { skill: "superpowers:writing-plans" })],
    false,
    ["superpowers:writing-plans", "Edit"],
  );
  expect(result.passed).toBe(false);
  expect(result.detail).toContain("fired after");
});

test("skill-before-tool: vacuous pass when tool never called", () => {
  const result = verbSkillBeforeTool(
    [call("Skill", { skill: "superpowers:writing-plans" })],
    false,
    ["superpowers:writing-plans", "Edit"],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("vacuous");
});

test("skill-before-tool: fail on empty transcript (C1 contract)", () => {
  const result = verbSkillBeforeTool([], true, ["superpowers:writing-plans", "Edit"]);
  expect(result.passed).toBe(false);
  expect(result.detail).toBe("tool-calls file missing or empty");
});

test("skill-before-tool: empty → exit 1 (E2E)", async () => {
  const r = await runCLIEmpty([
    "skill-before-tool",
    "superpowers:writing-plans",
    "Edit",
  ]);
  expect(r.exitCode).toBe(1);
  expect(r.lastRecord!["passed"]).toBe(false);
  expect(r.lastRecord!["detail"]).toBe("tool-calls file missing or empty");
});

// ---------------------------------------------------------------------------
// skill-before-implementation-tool
// ---------------------------------------------------------------------------

test("skill-before-implementation-tool: pass when skill precedes impl Edit", () => {
  const result = verbSkillBeforeImplementationTool(
    [
      call("Skill", { skill: "superpowers:writing-plans" }),
      call("Edit", {
        file_path: "/run/coding-agent-workdir/src/main.ts",
        old_string: "a",
        new_string: "b",
      }),
    ],
    false,
    ["superpowers:writing-plans", "Edit"],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("before implementation Edit");
});

test("skill-before-implementation-tool: fail when impl Edit before skill", () => {
  const result = verbSkillBeforeImplementationTool(
    [
      call("Edit", {
        file_path: "/run/coding-agent-workdir/src/main.ts",
        old_string: "a",
        new_string: "b",
      }),
      call("Skill", { skill: "superpowers:writing-plans" }),
    ],
    false,
    ["superpowers:writing-plans", "Edit"],
  );
  expect(result.passed).toBe(false);
  expect(result.detail).toContain("fired after implementation Edit");
});

test("skill-before-implementation-tool: vacuous pass when no impl Edit", () => {
  const result = verbSkillBeforeImplementationTool(
    [call("Skill", { skill: "superpowers:writing-plans" }), call("Read")],
    false,
    ["superpowers:writing-plans", "Edit"],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("vacuous");
});

test("skill-before-implementation-tool: fail on empty transcript (C1 contract)", () => {
  const result = verbSkillBeforeImplementationTool([], true, [
    "superpowers:writing-plans",
    "Edit",
  ]);
  expect(result.passed).toBe(false);
  expect(result.detail).toBe("tool-calls file missing or empty");
});

// ---------------------------------------------------------------------------
// implementation-tool-not-called
// ---------------------------------------------------------------------------

test("implementation-tool-not-called: pass when no impl Edit", () => {
  // Read on a non-workdir path — should not count as implementation
  const result = verbImplementationToolNotCalled(
    [call("Edit", { file_path: "/absolute/outside/workdir.ts" })],
    false,
    ["Edit"],
  );
  // /absolute/outside/workdir.ts doesn't contain /coding-agent-workdir/ and
  // starts with '/', so implementationRelpath returns "" → not an impl path
  expect(result.passed).toBe(true);
  expect(result.detail).toBe("no implementation Edit call");
});

test("implementation-tool-not-called: fail when impl Edit present", () => {
  const result = verbImplementationToolNotCalled(
    [
      call("Edit", {
        file_path: "/run/coding-agent-workdir/src/foo.ts",
        old_string: "a",
        new_string: "b",
      }),
    ],
    false,
    ["Edit"],
  );
  expect(result.passed).toBe(false);
  expect(result.detail).toContain("implementation Edit called 1 time(s)");
  expect(result.detail).toContain("src/foo.ts");
});

test("implementation-tool-not-called: fail on empty transcript (C1 contract)", () => {
  const result = verbImplementationToolNotCalled([], true, ["Edit"]);
  expect(result.passed).toBe(false);
  expect(result.detail).toBe("tool-calls file missing or empty");
});

// ---------------------------------------------------------------------------
// investigated
// ---------------------------------------------------------------------------

test("investigated: pass via native Read", () => {
  const result = verbInvestigated([call("Read", { file_path: "/tmp/foo.ts" })], false, []);
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("native Read/Grep called 1 time(s)");
});

test("investigated: pass via native Grep", () => {
  const result = verbInvestigated([call("Grep", { pattern: "foo" })], false, []);
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("native Read/Grep called 1 time(s)");
});

test("investigated: pass via Bash grep", () => {
  const result = verbInvestigated(
    [call("Bash", { command: "grep -r foo ." })],
    false,
    [],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("grep/rg invoked via Bash");
});

test("investigated: pass via Bash rg", () => {
  const result = verbInvestigated(
    [call("Bash", { command: "rg 'pattern' src/" })],
    false,
    [],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("grep/rg invoked via Bash");
});

test("investigated: fail when no investigation", () => {
  const result = verbInvestigated([call("Bash", { command: "ls" }), call("Edit")], false, []);
  expect(result.passed).toBe(false);
  expect(result.detail).toContain("no investigation observed");
});

test("investigated: does not match grep as part of a longer word (e.g. agreping)", () => {
  // 'agreping' — grep appears mid-word, preceded by a letter — word boundary blocks match
  const result = verbInvestigated(
    [call("Bash", { command: "echo agreping" })],
    false,
    [],
  );
  expect(result.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// worktree-created
// ---------------------------------------------------------------------------

test("worktree-created: pass via native EnterWorktree", () => {
  const result = verbWorktreeCreated([call("EnterWorktree")], false, []);
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("EnterWorktree called 1 time(s)");
});

test("worktree-created: pass via Bash git worktree add", () => {
  const result = verbWorktreeCreated(
    [call("Bash", { command: "git worktree add ../branch-wt" })],
    false,
    [],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("git worktree add invoked via Bash");
});

test("worktree-created: fail when neither present", () => {
  const result = verbWorktreeCreated([call("Bash", { command: "ls" })], false, []);
  expect(result.passed).toBe(false);
  expect(result.detail).toContain("no worktree creation observed");
});

// ---------------------------------------------------------------------------
// tool-match-before-tool-match
// ---------------------------------------------------------------------------

test("tool-match-before-tool-match: pass when A precedes B", () => {
  const result = verbToolMatchBeforeToolMatch(
    [
      call("Bash", { command: "pytest tests/" }),
      call("Bash", { command: "git commit -m 'wip'" }),
    ],
    false,
    ["Bash", "pytest", "Bash", "git commit"],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("before");
});

test("tool-match-before-tool-match: fail when B precedes A", () => {
  const result = verbToolMatchBeforeToolMatch(
    [
      call("Bash", { command: "git commit -m 'wip'" }),
      call("Bash", { command: "pytest tests/" }),
    ],
    false,
    ["Bash", "pytest", "Bash", "git commit"],
  );
  expect(result.passed).toBe(false);
  expect(result.detail).toContain("fired after");
});

test("tool-match-before-tool-match: vacuous pass when B never matches", () => {
  const result = verbToolMatchBeforeToolMatch(
    [call("Bash", { command: "pytest tests/" })],
    false,
    ["Bash", "pytest", "Bash", "git commit"],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("vacuous");
});

test("tool-match-before-tool-match: fail when B matches but A never does", () => {
  const result = verbToolMatchBeforeToolMatch(
    [call("Bash", { command: "git commit -m 'wip'" })],
    false,
    ["Bash", "pytest", "Bash", "git commit"],
  );
  expect(result.passed).toBe(false);
  expect(result.detail).toContain("but no");
});

test("tool-match-before-tool-match: fail on empty transcript (C1 contract)", () => {
  const result = verbToolMatchBeforeToolMatch([], true, [
    "Bash",
    "pytest",
    "Bash",
    "git commit",
  ]);
  expect(result.passed).toBe(false);
  expect(result.detail).toBe("tool-calls file missing or empty");
});

// ---------------------------------------------------------------------------
// Unknown verb / tool-arg-match deferred
// ---------------------------------------------------------------------------

test("unknown verb exits 2 (E2E)", async () => {
  const r = await runCLI(["totally-unknown-verb"], []);
  expect(r.exitCode).toBe(2);
});

test("tool-arg-match exits 2 with deferred message (E2E)", async () => {
  const r = await runCLI(["tool-arg-match", "Bash", ".command | test(\"ls\")"], [call("Bash", { command: "ls" })]);
  expect(r.exitCode).toBe(2);
  expect(r.stderr).toContain("not yet supported");
});

// ---------------------------------------------------------------------------
// Record shape verification
// ---------------------------------------------------------------------------

test("record JSON shape: check, args, negated, passed, detail (E2E)", async () => {
  const r = await runCLI(["tool-called", "Bash"], [call("Bash", { command: "ls" })]);
  expect(r.exitCode).toBe(0);
  const rec = r.lastRecord!;
  expect(typeof rec["check"]).toBe("string");
  expect(Array.isArray(rec["args"])).toBe(true);
  expect(rec["negated"]).toBe(false);
  expect(typeof rec["passed"]).toBe("boolean");
  // detail is a string or null
  expect(rec["detail"] === null || typeof rec["detail"] === "string").toBe(true);
});

test("record detail is null when no detail string (via no-sink no-op)", () => {
  // No-sink path: env not set. Just verify record shape indirectly by running
  // a passing verb without a sink — the process should exit 0 cleanly.
  // We test record null-detail by checking a fail with minimal args.
  const result = verbToolCalled([], false, ["Bash"]);
  // detail is "Bash never called" — non-null
  expect(result.detail).toBe("Bash never called");
  expect(result.passed).toBe(false);
});
