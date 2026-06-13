import type { AtifTrajectory } from "./types.ts";

export interface ToolCallView {
  tool: string;
  args: Record<string, unknown>;
}

/** Flatten all tool calls across all steps into chronological order. */
export function flattenToolCalls(traj: AtifTrajectory): ToolCallView[] {
  const views: ToolCallView[] = [];
  for (const step of traj.steps) {
    for (const call of step.tool_calls ?? []) {
      views.push({ tool: call.function_name, args: call.arguments });
    }
  }
  return views;
}
