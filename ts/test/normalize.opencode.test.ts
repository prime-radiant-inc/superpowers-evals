import { test, expect } from "bun:test";
import { normalizeOpencode } from "../src/normalize/opencode.ts";
import { validateTrajectory } from "../src/atif/validate.ts";

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

const basicExport = {
  info: { id: "ses_1", directory: "/tmp/project" },
  messages: [
    {
      info: { role: "assistant" },
      parts: [
        { type: "step-start" }, // non-tool part, should be ignored
        {
          type: "tool",
          tool: "skill",
          state: { status: "completed", input: { name: "brainstorming" } },
        },
        {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "git status" } },
        },
        {
          type: "tool",
          tool: "task",
          state: { status: "completed", input: { subagent_type: "general", prompt: "review" } },
        },
      ],
    },
  ],
};

const allToolsExport = {
  messages: [
    {
      parts: [
        { type: "tool", tool: "read", state: { input: { file: "README.md" } } },
        { type: "tool", tool: "write", state: { input: { path: "app.py", content: "x" } } },
        { type: "tool", tool: "edit", state: { input: { filePath: "src/app.py" } } },
        {
          type: "tool",
          tool: "apply_patch",
          state: {
            input: {
              patch:
                "*** Begin Patch\n*** Update File: src/app.py\n@@\n-old\n+new\n*** End Patch\n",
            },
          },
        },
        { type: "tool", tool: "grep", state: { input: { pattern: "Skill" } } },
        { type: "tool", tool: "glob", state: { input: { pattern: "*.py" } } },
        { type: "tool", tool: "todowrite", state: { input: { todos: [] } } },
        { type: "tool", tool: "webfetch", state: { input: { url: "https://example.com" } } },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("produces a valid ATIF v1.7 trajectory", () => {
  const traj = normalizeOpencode(JSON.stringify(basicExport), "0.5.0");
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent).toEqual({ name: "opencode", version: "0.5.0" });
});

test("skill maps to Skill with superpowers namespace and name field", () => {
  const traj = normalizeOpencode(JSON.stringify(basicExport), "0.5.0");
  const skillStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Skill");
  expect(skillStep).toBeDefined();
  const tc = skillStep!.tool_calls![0]!;
  expect(tc.arguments["skill"]).toBe("superpowers:brainstorming");
  expect(tc.arguments["name"]).toBe("brainstorming");
});

test("bash maps to Bash with command field", () => {
  const traj = normalizeOpencode(JSON.stringify(basicExport), "0.5.0");
  const bashStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Bash");
  expect(bashStep).toBeDefined();
  expect(bashStep!.tool_calls![0]!.arguments["command"]).toBe("git status");
});

test("task maps to Agent", () => {
  const traj = normalizeOpencode(JSON.stringify(basicExport), "0.5.0");
  const agentStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Agent");
  expect(agentStep).toBeDefined();
  expect(agentStep!.tool_calls![0]!.arguments["prompt"]).toBe("review");
});

test("maps all expected tool names", () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), "0.5.0");
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps
    .filter((s) => s.source === "agent")
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(["Read", "Write", "Edit", "Edit", "Grep", "Glob", "TodoWrite", "WebFetch"]);
});

test("read with 'file' key: extracts file_path", () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), "0.5.0");
  const readStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Read");
  expect(readStep!.tool_calls![0]!.arguments["file_path"]).toBe("README.md");
});

test("write with 'path' key: extracts file_path", () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), "0.5.0");
  const writeStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Write");
  expect(writeStep!.tool_calls![0]!.arguments["file_path"]).toBe("app.py");
});

test("edit with 'filePath' key: extracts file_path", () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), "0.5.0");
  const editSteps = traj.steps.filter((s) => s.tool_calls?.[0]?.function_name === "Edit");
  // First edit is from "edit" tool, second from "apply_patch"
  expect(editSteps[0]!.tool_calls![0]!.arguments["file_path"]).toBe("src/app.py");
});

test("apply_patch: extracts file_path and file_paths from patch text", () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), "0.5.0");
  const patchStep = traj.steps.find(
    (s) =>
      s.tool_calls?.[0]?.function_name === "Edit" &&
      Array.isArray(s.tool_calls[0]?.arguments["file_paths"]),
  );
  expect(patchStep).toBeDefined();
  expect(patchStep!.tool_calls![0]!.arguments["file_path"]).toBe("src/app.py");
  expect(patchStep!.tool_calls![0]!.arguments["file_paths"]).toEqual(["src/app.py"]);
});

test("raw_input is always included in arguments", () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), "0.5.0");
  for (const step of traj.steps.filter((s) => s.source === "agent")) {
    expect("raw_input" in step.tool_calls![0]!.arguments).toBe(true);
  }
});

test("non-tool parts (step-start, text) are ignored", () => {
  const traj = normalizeOpencode(JSON.stringify(basicExport), "0.5.0");
  // basicExport has 1 step-start + 3 tool parts; should be 3 agent steps
  const agentSteps = traj.steps.filter((s) => s.source === "agent");
  expect(agentSteps.length).toBe(3);
});

test("invalid JSON returns empty trajectory with user step placeholder", () => {
  const traj = normalizeOpencode("not json", "0.5.0");
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(traj.steps.length).toBe(1);
  expect(traj.steps[0]!.source).toBe("user");
});

test("step_ids are sequential from 1", () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), "0.5.0");
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});
