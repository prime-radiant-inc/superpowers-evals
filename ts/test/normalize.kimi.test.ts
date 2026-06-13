import { test, expect } from "bun:test";
import { normalizeKimi } from "../src/normalize/kimi.ts";
import { validateTrajectory } from "../src/atif/validate.ts";

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

function toolCall(name: string, args: unknown): string {
  return JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "tool.call", name, args },
  });
}

const basicLines = [
  toolCall("Read", { path: "sample.txt" }),
  toolCall("Bash", { command: "git status" }),
  toolCall("FetchURL", { url: "https://example.test" }),
  JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "tool.result", toolCallId: "tool_1" },
  }),
].join("\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("produces a valid ATIF v1.7 trajectory", () => {
  const traj = normalizeKimi(basicLines, "0.1.0");
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent).toEqual({ name: "kimi", version: "0.1.0" });
});

test("kimi tool names are preserved canonically", () => {
  const traj = normalizeKimi(basicLines, "0.1.0");
  const names = traj.steps
    .filter((s) => s.source === "agent")
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(["Read", "Bash", "FetchURL"]);
});

test("tool.result rows are ignored", () => {
  const traj = normalizeKimi(basicLines, "0.1.0");
  // Only the three tool.call rows produce steps.
  expect(traj.steps.filter((s) => s.source === "agent").length).toBe(3);
});

test("args are carried through verbatim", () => {
  const traj = normalizeKimi(basicLines, "0.1.0");
  const read = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Read");
  expect(read!.tool_calls![0]!.arguments["path"]).toBe("sample.txt");
});

test("bare superpowers skill names are canonicalized", () => {
  const raw = toolCall("Skill", { skill: "brainstorming" });
  const traj = normalizeKimi(raw, "0.1.0");
  const skill = traj.steps[0]!.tool_calls![0]!;
  expect(skill.function_name).toBe("Skill");
  expect(skill.arguments["skill"]).toBe("superpowers:brainstorming");
});

test("already-qualified skill names are left untouched", () => {
  const raw = toolCall("Skill", { skill: "otherplugin:thing" });
  const traj = normalizeKimi(raw, "0.1.0");
  expect(traj.steps[0]!.tool_calls![0]!.arguments["skill"]).toBe("otherplugin:thing");
});

test("non-tool.call events are ignored", () => {
  const raw = JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "message", role: "assistant" },
  });
  const traj = normalizeKimi(raw, "0.1.0");
  expect(traj.steps.filter((s) => s.source === "agent").length).toBe(0);
});

test("non-string tool names are ignored", () => {
  const raw = [toolCall("Read", { path: "x" }), toolCall("", {})].join("\n");
  const traj = normalizeKimi(raw, "0.1.0");
  const names = traj.steps
    .filter((s) => s.source === "agent")
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(["Read"]);
});

test("tolerates blank lines and bad JSON", () => {
  const raw = `\n{not json}\n${toolCall("Bash", { command: "ls" })}\n`;
  const traj = normalizeKimi(raw, "0.1.0");
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(traj.steps[0]!.tool_calls![0]!.function_name).toBe("Bash");
});

test("step_ids are sequential from 1", () => {
  const traj = normalizeKimi(basicLines, "0.1.0");
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});
