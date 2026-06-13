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
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("steps"))).toBe(true);
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

// Fix 1: observation is agent-only
test("rejects observation on a non-agent step", () => {
  const t = good();
  t.steps[0]!.observation = { results: [{ content: "x" }] };
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("agent-only"))).toBe(true);
});

// Fix 2: null source_call_id treated as absent (no spurious error)
test("accepts null source_call_id on an agent step with tool_calls", () => {
  const t = good();
  // Real JSON can carry null; treat as absent — no source_call_id error expected.
  t.steps[1]!.observation = {
    results: [{ source_call_id: null as unknown as undefined, content: "x" }],
  };
  const r = validateTrajectory(t);
  expect(r.ok).toBe(true);
  expect(r.errors.some((e) => e.includes("source_call_id"))).toBe(false);
});

// Fix 3: duplicate tool_call_id within a step
test("rejects duplicate tool_call_id within a step", () => {
  const t = good();
  t.steps[1]!.tool_calls = [
    { tool_call_id: "dup", function_name: "Bash", arguments: { command: "ls" } },
    { tool_call_id: "dup", function_name: "Read", arguments: { file_path: "/tmp" } },
  ];
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("duplicate"))).toBe(true);
});

// Fix 4: invalid source value
test("rejects a step with an invalid source", () => {
  const t = good();
  (t.steps[0] as unknown as { source: string }).source = "robot";
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("source"))).toBe(true);
});

// Fix 5a: agent step missing name
test("rejects agent missing name", () => {
  const t = good();
  t.agent.name = "";
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("agent"))).toBe(true);
});

// Fix 5b: agent step missing version
test("rejects agent missing version", () => {
  const t = good();
  t.agent.version = "";
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("agent"))).toBe(true);
});
