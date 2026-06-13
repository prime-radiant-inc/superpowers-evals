import { test, expect } from "bun:test";
import { flattenToolCalls } from "../src/atif/project.ts";
import type { AtifTrajectory } from "../src/atif/types.ts";

function makeTrajectory(): AtifTrajectory {
  return {
    schema_version: "ATIF-v1.7",
    agent: { name: "claude-code", version: "2.0.0" },
    steps: [
      {
        step_id: 1,
        source: "agent",
        tool_calls: [
          {
            tool_call_id: "tc1",
            function_name: "Skill",
            arguments: { skill: "superpowers:foo" },
          },
          {
            tool_call_id: "tc2",
            function_name: "Bash",
            arguments: { command: "ls" },
          },
        ],
      },
      {
        step_id: 2,
        source: "user",
        message: "please continue",
        // no tool_calls
      },
      {
        step_id: 3,
        source: "agent",
        tool_calls: [
          {
            tool_call_id: "tc3",
            function_name: "Edit",
            arguments: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
          },
        ],
      },
    ],
  };
}

test("flattenToolCalls returns views in order, skipping steps with no tool_calls", () => {
  const traj = makeTrajectory();
  const views = flattenToolCalls(traj);
  expect(views).toHaveLength(3);

  expect(views[0]).toEqual({ tool: "Skill", args: { skill: "superpowers:foo" } });
  expect(views[1]).toEqual({ tool: "Bash", args: { command: "ls" } });
  expect(views[2]).toEqual({
    tool: "Edit",
    args: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
  });
});

test("flattenToolCalls returns empty array for trajectory with no tool_calls in any step", () => {
  const traj: AtifTrajectory = {
    schema_version: "ATIF-v1.7",
    agent: { name: "claude-code", version: "2.0.0" },
    steps: [
      { step_id: 1, source: "user", message: "hello" },
      { step_id: 2, source: "agent", message: "world" },
    ],
  };
  expect(flattenToolCalls(traj)).toEqual([]);
});
