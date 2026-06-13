import { test, expect } from "bun:test";
import { normalizeCodex } from "../src/normalize/codex.ts";
import { validateTrajectory } from "../src/atif/validate.ts";

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

// Codex rollout format: response_item with payload.type = function_call
const functionCallLine = JSON.stringify({
  type: "response_item",
  payload: {
    type: "function_call",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "git worktree add .worktrees/feature", workdir: "/tmp" }),
    call_id: "call_123",
  },
});

const applyPatchLine = JSON.stringify({
  type: "response_item",
  payload: {
    type: "function_call",
    name: "apply_patch",
    arguments: JSON.stringify({ patch: "--- a/file\n+++ b/file" }),
    call_id: "call_456",
  },
});

const spawnAgentLine = JSON.stringify({
  type: "response_item",
  payload: {
    type: "function_call",
    name: "spawn_agent",
    arguments: JSON.stringify({ task: "review the PR" }),
    call_id: "call_1",
  },
});

const waitAgentLine = JSON.stringify({
  type: "response_item",
  payload: {
    type: "function_call",
    name: "wait_agent",
    arguments: "{}",
    call_id: "call_2",
  },
});

const closeAgentLine = JSON.stringify({
  type: "response_item",
  payload: {
    type: "function_call",
    name: "close_agent",
    arguments: "{}",
    call_id: "call_3",
  },
});

// custom_tool_call variant (current Codex runs)
const customApplyPatchLine = JSON.stringify({
  type: "response_item",
  payload: {
    type: "custom_tool_call",
    name: "apply_patch",
    input: "*** Begin Patch\n*** Add File: foo.go\n+package main\n*** End Patch\n",
    call_id: "call_4",
  },
});

// local_shell_call variant (as produced in test_normalizers.py item key form)
const localShellLine = JSON.stringify({
  type: "response_item",
  item: {
    type: "local_shell_call",
    action: { command: ["git", "worktree", "add", "feature"] },
    status: "completed",
  },
});

const raw2Lines = [functionCallLine, applyPatchLine].join("\n");
const rawFull = [functionCallLine, applyPatchLine, customApplyPatchLine].join("\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("produces a valid ATIF v1.7 trajectory", () => {
  const traj = normalizeCodex(raw2Lines, "1.0.0");
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent).toEqual({ name: "codex", version: "1.0.0" });
});

test("exec_command maps to Bash with args.command from cmd field", () => {
  const traj = normalizeCodex(functionCallLine, "1.0.0");
  const step = traj.steps.find((s) => s.source === "agent");
  expect(step).toBeDefined();
  const tc = step!.tool_calls![0]!;
  expect(tc.function_name).toBe("Bash");
  expect(tc.arguments["command"]).toBe("git worktree add .worktrees/feature");
});

test("apply_patch (function_call) maps to Edit", () => {
  const traj = normalizeCodex(applyPatchLine, "1.0.0");
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe("Edit");
  expect(typeof tc.arguments["patch"]).toBe("string");
});

test("spawn_agent maps to Agent", () => {
  const traj = normalizeCodex(spawnAgentLine, "1.0.0");
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe("Agent");
  expect(tc.arguments["task"]).toBe("review the PR");
});

test("wait_agent and close_agent are kept verbatim (not aliased)", () => {
  const traj = normalizeCodex([waitAgentLine, closeAgentLine].join("\n"), "1.0.0");
  const names = traj.steps.map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(["wait_agent", "close_agent"]);
});

test("apply_patch (custom_tool_call) maps to Edit with patch string", () => {
  const traj = normalizeCodex(customApplyPatchLine, "1.0.0");
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe("Edit");
  expect(typeof tc.arguments["patch"]).toBe("string");
  expect(String(tc.arguments["patch"])).toContain("Begin Patch");
});

test("local_shell_call maps to Bash with joined command string", () => {
  const traj = normalizeCodex(localShellLine, "1.0.0");
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe("Bash");
  expect(String(tc.arguments["command"])).toContain("git worktree add");
});

test("non-response_item lines are ignored", () => {
  const raw = [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp" } }),
    JSON.stringify({ type: "response_item", item: { type: "message", content: [] } }),
    functionCallLine,
  ].join("\n");
  const traj = normalizeCodex(raw, "1.0.0");
  const agentSteps = traj.steps.filter((s) => s.source === "agent" && s.tool_calls?.length);
  expect(agentSteps.length).toBe(1);
  expect(agentSteps[0]!.tool_calls![0]!.function_name).toBe("Bash");
});

test("tolerates blank lines and unparseable JSON", () => {
  const raw = `\n{not json}\n${functionCallLine}\n`;
  const traj = normalizeCodex(raw, "1.0.0");
  expect(validateTrajectory(traj).ok).toBe(true);
  const agentStep = traj.steps.find((s) => s.source === "agent");
  expect(agentStep).toBeDefined();
});

test("step_ids are sequential from 1", () => {
  const traj = normalizeCodex(rawFull, "1.0.0");
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

test("each tool call gets its own step", () => {
  const traj = normalizeCodex(raw2Lines, "1.0.0");
  expect(traj.steps.length).toBe(2);
});
