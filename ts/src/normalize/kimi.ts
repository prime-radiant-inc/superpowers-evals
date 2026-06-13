import {
  ATIF_SCHEMA_VERSION,
  type AtifTrajectory,
  type AtifStep,
  type AtifToolCall,
} from "../atif/types.ts";
import { validateTrajectory } from "../atif/validate.ts";

interface KimiEntry {
  type?: string;
  event?: {
    type?: string;
    name?: string;
    args?: unknown;
  };
}

/**
 * Convert a Kimi Code wire.jsonl session log into an ATIF v1.7 trajectory.
 *
 * Kimi records tool invocations as context loop events:
 *   {"type":"context.append_loop_event",
 *    "event":{"type":"tool.call","name":"Read","args":{...}}}
 *
 * Tool names are already in Claude-Code canonical form; the only rewrite is
 * canonicalizing bare superpowers skill names (e.g. "brainstorming" →
 * "superpowers:brainstorming") on Skill calls.
 */
export function normalizeKimi(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: KimiEntry;
    try {
      entry = JSON.parse(line) as KimiEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry["type"] !== "context.append_loop_event") continue;

    const event = entry["event"];
    if (!event || typeof event !== "object") continue;
    if (event["type"] !== "tool.call") continue;

    const name = event["name"];
    if (typeof name !== "string" || !name) continue;

    const rawArgs = event["args"];
    const args: Record<string, unknown> =
      typeof rawArgs === "object" && rawArgs !== null
        ? { ...(rawArgs as Record<string, unknown>) }
        : { raw_args: rawArgs };

    if (name === "Skill") {
      const skill = args["skill"];
      if (typeof skill === "string" && skill && !skill.includes(":")) {
        args["skill"] = `superpowers:${skill}`;
      }
    }

    const tc: AtifToolCall = {
      tool_call_id: `${stepId}`,
      function_name: name,
      arguments: args,
    };

    steps.push({
      step_id: stepId++,
      source: "agent",
      tool_calls: [tc],
    });
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: "user", message: "" });
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: "kimi", version },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(`normalizeKimi produced invalid ATIF: ${result.errors.join("; ")}`);
  }

  return traj;
}
