import { test, expect } from "bun:test";
import { normalizeGemini } from "../src/normalize/gemini.ts";
import { validateTrajectory } from "../src/atif/validate.ts";

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

// JSONL format: individual lines, each a JSON object
const jsonlLines = [
  JSON.stringify({ kind: "main" }), // not "gemini" type, should be ignored
  JSON.stringify({
    type: "gemini",
    content: "Reading file",
    toolCalls: [
      { id: "read_file_1", name: "read_file", args: { file_path: "GEMINI.md" }, status: "success" },
    ],
  }),
  JSON.stringify({
    type: "gemini",
    content: "Running command",
    toolCalls: [
      { id: "shell_1", name: "run_shell_command", args: { command: "git status" }, status: "success" },
    ],
  }),
].join("\n");

// JSON object format with "messages" array
const messagesJson = JSON.stringify({
  messages: [
    { kind: "main" },
    {
      type: "gemini",
      content: "Using a skill",
      toolCalls: [
        { id: "skill-1", name: "activate_skill", args: { skill: "superpowers:brainstorming" }, status: "success" },
        { id: "ls-1", name: "list_directory", args: { path: "src" }, status: "success" },
        { id: "write-1", name: "write_file", args: { file_path: "notes.md", content: "x" }, status: "success" },
        { id: "replace-1", name: "replace", args: { file_path: "notes.md", old_string: "x", new_string: "y" }, status: "success" },
        { id: "shell-1", name: "run_shell_command", args: { command: "git status" }, status: "success" },
      ],
    },
    // duplicate shell-1 id in different message — should be deduplicated
    {
      type: "gemini",
      content: "duplicate",
      toolCalls: [
        { id: "shell-1", name: "run_shell_command", args: { command: "pwd" }, status: "success" },
      ],
    },
  ],
});

// activate_skill with "name" argument (not "skill")
const nameArgJson = JSON.stringify({
  type: "gemini",
  toolCalls: [
    { id: "skill-1", name: "activate_skill", args: { name: "test-driven-development" } },
  ],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("produces a valid ATIF v1.7 trajectory (JSONL)", () => {
  const traj = normalizeGemini(jsonlLines, "0.1.18");
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent).toEqual({ name: "gemini", version: "0.1.18" });
});

test("read_file maps to Read", () => {
  const traj = normalizeGemini(jsonlLines, "0.1.18");
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe("Read");
  expect(tc.arguments["file_path"]).toBe("GEMINI.md");
});

test("run_shell_command maps to Bash", () => {
  const traj = normalizeGemini(jsonlLines, "0.1.18");
  const tc = traj.steps[1]!.tool_calls![0]!;
  expect(tc.function_name).toBe("Bash");
  expect(tc.arguments["command"]).toBe("git status");
});

test("JSON messages format: maps all expected tool names", () => {
  const traj = normalizeGemini(messagesJson, "0.1.18");
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps
    .filter((s) => s.source === "agent")
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(["Skill", "Glob", "Write", "Edit", "Bash"]);
});

test("activate_skill with 'skill' arg: normalizes to superpowers:<name>", () => {
  const traj = normalizeGemini(messagesJson, "0.1.18");
  const skillStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Skill");
  expect(skillStep).toBeDefined();
  expect(skillStep!.tool_calls![0]!.arguments["skill"]).toBe("superpowers:brainstorming");
});

test("activate_skill with 'name' arg: normalizes to superpowers:<name>", () => {
  const traj = normalizeGemini(nameArgJson, "0.1.18");
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe("Skill");
  expect(tc.arguments["skill"]).toBe("superpowers:test-driven-development");
});

test("activate_skill with already-namespaced 'skill' arg is kept as-is", () => {
  const raw = JSON.stringify({
    type: "gemini",
    toolCalls: [{ id: "x", name: "activate_skill", args: { skill: "superpowers:brainstorming" } }],
  });
  const traj = normalizeGemini(raw, "0.1.18");
  expect(traj.steps[0]!.tool_calls![0]!.arguments["skill"]).toBe("superpowers:brainstorming");
});

test("duplicate tool call ids across messages are deduplicated", () => {
  const traj = normalizeGemini(messagesJson, "0.1.18");
  // shell-1 appears twice but should only appear once
  const shellSteps = traj.steps.filter(
    (s) => s.tool_calls?.[0]?.tool_call_id === "shell-1",
  );
  expect(shellSteps.length).toBe(1);
});

test("non-gemini type messages are ignored", () => {
  const raw = [
    JSON.stringify({ type: "user", content: "hello" }),
    JSON.stringify({ type: "gemini", toolCalls: [{ id: "x", name: "read_file", args: { file_path: "f" } }] }),
  ].join("\n");
  const traj = normalizeGemini(raw, "0.1.18");
  const agentSteps = traj.steps.filter((s) => s.source === "agent");
  expect(agentSteps.length).toBe(1);
});

test("tolerates blank lines and bad JSON", () => {
  const raw = `\n{not json}\n${JSON.stringify({ type: "gemini", toolCalls: [{ id: "y", name: "glob", args: { path: "." } }] })}\n`;
  const traj = normalizeGemini(raw, "0.1.18");
  expect(validateTrajectory(traj).ok).toBe(true);
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe("Glob");
});

test("step_ids are sequential from 1", () => {
  const traj = normalizeGemini(jsonlLines, "0.1.18");
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

test("list_directory maps to Glob", () => {
  const traj = normalizeGemini(messagesJson, "0.1.18");
  const globStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === "Glob" && s.tool_calls?.[0]?.arguments["path"] === "src",
  );
  expect(globStep).toBeDefined();
});

test("replace maps to Edit", () => {
  const traj = normalizeGemini(messagesJson, "0.1.18");
  const editStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Edit");
  expect(editStep).toBeDefined();
});

test("write_file maps to Write", () => {
  const traj = normalizeGemini(messagesJson, "0.1.18");
  const writeStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Write");
  expect(writeStep).toBeDefined();
  expect(writeStep!.tool_calls![0]!.arguments["file_path"]).toBe("notes.md");
});

test("step timestamp is carried from the source message when present", () => {
  // The multi-log merge in quorum/capture.py orders steps by this timestamp,
  // so the normalizer must surface it where the source has it.
  const raw = JSON.stringify({
    type: "gemini",
    timestamp: "2026-06-12T00:19:23.695Z",
    toolCalls: [{ id: "skill-1", name: "activate_skill", args: { name: "writing-plans" } }],
  });
  const traj = normalizeGemini(raw, "0.1.18");
  expect(traj.steps[0]!.timestamp).toBe("2026-06-12T00:19:23.695Z");
});
