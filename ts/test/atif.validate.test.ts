import { test, expect } from "bun:test";
import { validateTrajectory } from "../src/atif/validate.ts";
import type { AtifTrajectory } from "../src/atif/types.ts";

function good(): AtifTrajectory {
  return {
    schema_version: "ATIF-v1.7",
    agent: { name: "claude-code", version: "2.1.175" },
    steps: [
      { step_id: 1, source: "user", message: "do a thing" },
      {
        step_id: 2,
        source: "agent",
        tool_calls: [{ tool_call_id: "t1", function_name: "Bash", arguments: { command: "ls" } }],
        observation: { results: [{ source_call_id: "t1", content: "file.txt" }] },
      },
    ],
  };
}

test("accepts a well-formed trajectory", () => {
  const r = validateTrajectory(good());
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
});

test("rejects a wrong schema_version", () => {
  const t = good();
  (t as { schema_version: string }).schema_version = "ATIF-v1.6";
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("schema_version"))).toBe(true);
});

test("rejects empty steps", () => {
  const t = good();
  t.steps = [];
  expect(validateTrajectory(t).ok).toBe(false);
});

test("rejects non-sequential step_id", () => {
  const t = good();
  t.steps[1]!.step_id = 5;
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("step_id"))).toBe(true);
});

test("rejects tool_calls on a non-agent step", () => {
  const t = good();
  t.steps[0]!.tool_calls = [{ tool_call_id: "x", function_name: "Bash", arguments: {} }];
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("agent-only"))).toBe(true);
});

test("rejects an observation referencing a tool_call from another step", () => {
  const t = good();
  t.steps[1]!.observation = { results: [{ source_call_id: "does-not-exist", content: "x" }] };
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("source_call_id"))).toBe(true);
});
