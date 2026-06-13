import {
  ATIF_SCHEMA_VERSION,
  type AtifTrajectory,
  type AtifStep,
  type AtifToolCall,
} from "../atif/types.ts";
import { validateTrajectory } from "../atif/validate.ts";

const OPENCODE_TOOL_MAP: Record<string, string> = {
  skill: "Skill",
  task: "Agent",
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  grep: "Grep",
  glob: "Glob",
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
  websearch: "WebSearch",
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

function getToolInput(part: Record<string, unknown>): unknown {
  const state = part["state"];
  if (!state || typeof state !== "object") return {};
  return (state as Record<string, unknown>)["input"] ?? {};
}

function normalizeOpencodeArgs(name: string, rawInput: unknown): Record<string, unknown> {
  const args: Record<string, unknown> =
    typeof rawInput === "object" && rawInput !== null
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

  if (["read", "write", "edit"].includes(name) && !("file_path" in args)) {
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

/**
 * Convert an OpenCode exported session JSON into an ATIF v1.7 trajectory.
 *
 * OpenCode exports a JSON object with a "messages" array; each message has a
 * "parts" array; tool parts have {"type": "tool", "tool": "<name>",
 * "state": {"input": {...}}}.
 */
export function normalizeOpencode(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  if (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data)
  ) {
    const obj = data as Record<string, unknown>;
    const messages = obj["messages"];
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        const msg = message as Record<string, unknown>;
        const parts = msg["parts"];
        if (!Array.isArray(parts)) continue;

        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p["type"] !== "tool") continue;
          const name = p["tool"];
          if (typeof name !== "string" || !name) continue;

          const canonical = OPENCODE_TOOL_MAP[name] ?? name;
          const rawInput = getToolInput(p);
          const args = normalizeOpencodeArgs(name, rawInput);

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
    }
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: "user", message: "" });
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: "opencode", version },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(`normalizeOpencode produced invalid ATIF: ${result.errors.join("; ")}`);
  }

  return traj;
}
