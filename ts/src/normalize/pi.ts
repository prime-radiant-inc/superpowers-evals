import {
  ATIF_SCHEMA_VERSION,
  type AtifTrajectory,
  type AtifStep,
  type AtifToolCall,
} from "../atif/types.ts";
import { validateTrajectory } from "../atif/validate.ts";

// Reverse mapping: Pi tool names → canonical names.
const PI_TOOL_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

interface PiEntry {
  type?: string;
  message?: {
    role?: string;
    content?: PiContentBlock[];
  };
}

interface PiContentBlock {
  type?: string;
  name?: string;
  arguments?: unknown;
  id?: string;
}

/**
 * Convert a Pi JSONL session log into an ATIF v1.7 trajectory.
 *
 * Pi session files are JSONL entries. Assistant messages contain tool calls as
 * content blocks: {"type": "toolCall", "name": "read", "arguments": {...}}.
 * The special "subagent" tool is aliased to "Agent" for execution calls (those
 * that lack an "action" key in arguments), but kept verbatim for management
 * calls (list, status, resume, ...) that set "action".
 */
export function normalizePi(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: PiEntry;
    try {
      entry = JSON.parse(line) as PiEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry["type"] !== "message") continue;

    const message = entry["message"];
    if (!message || typeof message !== "object") continue;
    if (message["role"] !== "assistant") continue;

    const content = message["content"];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as PiContentBlock;
      if (b["type"] !== "toolCall") continue;

      const name = b["name"] ?? "";
      const args = (typeof b["arguments"] === "object" && b["arguments"] !== null
        ? b["arguments"]
        : {}) as Record<string, unknown>;

      let canonical = PI_TOOL_MAP[name] ?? name;

      // pi-subagents: execution calls (no "action" key) alias to Agent;
      // management calls (with "action" key) stay as "subagent".
      if (name === "subagent") {
        if (!("action" in args)) {
          canonical = "Agent";
        } else {
          canonical = "subagent";
        }
      }

      const tc: AtifToolCall = {
        tool_call_id: b["id"] ?? `${stepId}`,
        function_name: canonical,
        arguments: args,
      };

      steps.push({
        step_id: stepId++,
        source: "agent",
        tool_calls: [tc],
      });
    }
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: "user", message: "" });
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: "pi", version },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(`normalizePi produced invalid ATIF: ${result.errors.join("; ")}`);
  }

  return traj;
}
