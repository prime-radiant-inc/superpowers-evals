import {
  ATIF_SCHEMA_VERSION,
  type AtifTrajectory,
  type AtifStep,
  type AtifToolCall,
} from "../atif/types.ts";
import { validateTrajectory } from "../atif/validate.ts";

const COPILOT_TOOL_MAP: Record<string, string> = {
  skill: "Skill",
  bash: "Bash",
  apply_patch: "Edit",
  edit: "Edit",
  create: "Write",
  write: "Write",
  view: "Read",
  rg: "Grep",
  glob: "Glob",
  task: "Agent",
  read_agent: "Agent",
  list_agents: "Agent",
  write_agent: "Agent",
  update_todo: "TodoWrite",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
};

function applyPatchPaths(patchText: unknown): string[] {
  if (typeof patchText !== "string") return [];
  const paths: string[] = [];
  const prefixes = ["*** Add File: ", "*** Update File: ", "*** Delete File: "];
  for (const line of patchText.split("\n")) {
    for (const prefix of prefixes) {
      if (line.startsWith(prefix)) {
        const path = line.slice(prefix.length).trim();
        if (path) paths.push(path);
        break;
      }
    }
  }
  return paths;
}

function normalizeCopilotArgs(name: string, rawInput: unknown): Record<string, unknown> {
  const args: Record<string, unknown> = typeof rawInput === "object" && rawInput !== null
    ? { ...(rawInput as Record<string, unknown>) }
    : {};
  args["raw_input"] = rawInput;

  if (name === "skill") {
    let skillName = "";
    if (typeof rawInput === "object" && rawInput !== null) {
      const ri = rawInput as Record<string, unknown>;
      const candidate = ri["skill"] ?? ri["name"];
      if (typeof candidate === "string") skillName = candidate;
    }
    if (skillName) {
      args["name"] = skillName.split(":").slice(-1)[0] ?? skillName;
      args["skill"] = skillName.includes(":") ? skillName : `superpowers:${skillName}`;
    }
  }

  if (name === "bash" && !("command" in args)) {
    const cmd = args["cmd"];
    if (typeof cmd === "string") args["command"] = cmd;
  }

  if (["view", "edit", "create", "write"].includes(name) && !("file_path" in args)) {
    for (const key of ["file_path", "filePath", "path", "file"]) {
      const val = args[key];
      if (typeof val === "string") {
        args["file_path"] = val;
        break;
      }
    }
  }

  if (name === "apply_patch" && !("file_path" in args)) {
    let patchText = args["patch"];
    if (typeof patchText !== "string" && typeof rawInput === "string") {
      patchText = rawInput;
    }
    const paths = applyPatchPaths(patchText);
    if (paths.length > 0) {
      args["file_path"] = paths[0];
      args["file_paths"] = paths;
    }
  }

  return args;
}

interface CopilotEntry {
  type?: string;
  data?: {
    toolRequests?: unknown[];
  };
}

interface CopilotToolRequest {
  name?: string;
  arguments?: unknown;
}

/**
 * Convert a Copilot CLI session-state JSONL log into an ATIF v1.7 trajectory.
 *
 * Copilot logs JSONL where assistant messages have:
 *   {"type": "assistant.message", "data": {"toolRequests": [{"name": "...", "arguments": {...}}]}}
 */
export function normalizeCopilot(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: CopilotEntry;
    try {
      entry = JSON.parse(line) as CopilotEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry["type"] !== "assistant.message") continue;
    const data = entry["data"];
    if (!data || typeof data !== "object") continue;
    const toolRequests = data["toolRequests"];
    if (!Array.isArray(toolRequests)) continue;

    for (const request of toolRequests) {
      if (!request || typeof request !== "object") continue;
      const req = request as CopilotToolRequest;
      const name = req["name"];
      if (typeof name !== "string" || !name) continue;

      const canonical = COPILOT_TOOL_MAP[name] ?? name;
      const args = normalizeCopilotArgs(name, req["arguments"] ?? {});

      const tc: AtifToolCall = {
        tool_call_id: `${stepId}`,
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
    agent: { name: "copilot", version },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(`normalizeCopilot produced invalid ATIF: ${result.errors.join("; ")}`);
  }

  return traj;
}
