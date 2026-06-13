import { test, expect } from "bun:test";
import { normalizeCopilot } from "../src/normalize/copilot.ts";
import { validateTrajectory } from "../src/atif/validate.ts";

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

const basicLine = JSON.stringify({
  type: "assistant.message",
  data: {
    toolRequests: [
      { name: "skill", arguments: { skill: "superpowers:brainstorming" } },
      { name: "bash", arguments: { cmd: "git status" } },
      {
        name: "apply_patch",
        arguments: {
          patch:
            "*** Begin Patch\n*** Update File: src/app.py\n@@\n-old\n+new\n*** End Patch\n",
        },
      },
      { name: "view", arguments: { file: "README.md" } },
      { name: "edit", arguments: { filePath: "src/edit.py" } },
      { name: "create", arguments: { path: "src/new.py" } },
      { name: "write", arguments: { file_path: "src/write.py" } },
      { name: "rg", arguments: { pattern: "Skill" } },
      { name: "glob", arguments: { pattern: "*.py" } },
      { name: "task", arguments: { prompt: "review" } },
      { name: "read_agent", arguments: { agent: "reviewer" } },
      { name: "list_agents", arguments: {} },
      { name: "write_agent", arguments: { agent: "reviewer" } },
      { name: "update_todo", arguments: { todos: [] } },
      { name: "web_fetch", arguments: { url: "https://example.test" } },
      { name: "web_search", arguments: { query: "quorum docs" } },
    ],
  },
});

const multiLineLine = [
  JSON.stringify({
    type: "assistant.message",
    data: {
      toolRequests: [
        { name: "bash", arguments: { command: "pwd" } },
        { name: "skill", arguments: { name: "brainstorming" } },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant.message",
    data: {
      toolRequests: [
        { name: "view", arguments: { path: "README.md" } },
        { name: "write", arguments: { file: "notes.md" } },
      ],
    },
  }),
].join("\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("produces a valid ATIF v1.7 trajectory", () => {
  const traj = normalizeCopilot(basicLine, "1.0.0");
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent).toEqual({ name: "copilot", version: "1.0.0" });
});

test("maps all expected tool names in correct order", () => {
  const traj = normalizeCopilot(basicLine, "1.0.0");
  const names = traj.steps
    .filter((s) => s.source === "agent")
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual([
    "Skill",
    "Bash",
    "Edit",
    "Read",
    "Edit",
    "Write",
    "Write",
    "Grep",
    "Glob",
    "Agent",
    "Agent",
    "Agent",
    "Agent",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
  ]);
});

test("skill with 'skill' arg: normalizes to superpowers:<name> and adds name field", () => {
  const traj = normalizeCopilot(basicLine, "1.0.0");
  const skillStep = traj.steps[0]!;
  const tc = skillStep.tool_calls![0]!;
  expect(tc.function_name).toBe("Skill");
  expect(tc.arguments["skill"]).toBe("superpowers:brainstorming");
  expect(tc.arguments["name"]).toBe("brainstorming");
});

test("bash with 'cmd' arg: normalizes to 'command'", () => {
  const traj = normalizeCopilot(basicLine, "1.0.0");
  const bashStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Bash");
  expect(bashStep).toBeDefined();
  expect(bashStep!.tool_calls![0]!.arguments["command"]).toBe("git status");
});

test("apply_patch: extracts file_path from patch text", () => {
  const traj = normalizeCopilot(basicLine, "1.0.0");
  const editStep = traj.steps.find(
    (s) =>
      s.tool_calls?.[0]?.function_name === "Edit" &&
      Array.isArray(s.tool_calls[0]?.arguments["file_paths"]),
  );
  expect(editStep).toBeDefined();
  expect(editStep!.tool_calls![0]!.arguments["file_path"]).toBe("src/app.py");
  expect(editStep!.tool_calls![0]!.arguments["file_paths"]).toEqual(["src/app.py"]);
});

test("view maps to Read with file_path extracted from 'file' key", () => {
  const traj = normalizeCopilot(basicLine, "1.0.0");
  const readStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Read");
  expect(readStep).toBeDefined();
  expect(readStep!.tool_calls![0]!.arguments["file_path"]).toBe("README.md");
});

test("raw_input is always included in arguments", () => {
  const traj = normalizeCopilot(basicLine, "1.0.0");
  for (const step of traj.steps.filter((s) => s.source === "agent")) {
    expect("raw_input" in step.tool_calls![0]!.arguments).toBe(true);
  }
});

test("multiple assistant.message lines: preserves order across messages", () => {
  const traj = normalizeCopilot(multiLineLine, "1.0.0");
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps
    .filter((s) => s.source === "agent")
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(["Bash", "Skill", "Read", "Write"]);
});

test("skill with 'name' arg (not 'skill'): normalizes correctly", () => {
  const traj = normalizeCopilot(multiLineLine, "1.0.0");
  const skillStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Skill");
  expect(skillStep).toBeDefined();
  expect(skillStep!.tool_calls![0]!.arguments["skill"]).toBe("superpowers:brainstorming");
  expect(skillStep!.tool_calls![0]!.arguments["name"]).toBe("brainstorming");
});

test("ignores non-assistant.message events and bad JSON", () => {
  const raw = [
    "not json",
    JSON.stringify([]),
    JSON.stringify({ type: "tool.execution_complete" }),
    JSON.stringify({ type: "assistant.message", data: { toolRequests: "bad" } }),
    JSON.stringify({
      type: "assistant.message",
      data: { toolRequests: [{ name: "bash", arguments: { command: "ls" } }] },
    }),
  ].join("\n");
  const traj = normalizeCopilot(raw, "1.0.0");
  const agentSteps = traj.steps.filter((s) => s.source === "agent");
  expect(agentSteps.length).toBe(1);
  expect(agentSteps[0]!.tool_calls![0]!.function_name).toBe("Bash");
});

test("step_ids are sequential from 1", () => {
  const traj = normalizeCopilot(multiLineLine, "1.0.0");
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});
