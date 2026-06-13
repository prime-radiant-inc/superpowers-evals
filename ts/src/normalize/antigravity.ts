import {
  ATIF_SCHEMA_VERSION,
  type AtifTrajectory,
  type AtifStep,
  type AtifToolCall,
} from "../atif/types.ts";
import { validateTrajectory } from "../atif/validate.ts";

const ANTIGRAVITY_TOOL_MAP: Record<string, string> = {
  run_command: "Bash",
  view_file: "Read",
  write_to_file: "Write",
  create_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  edit_file: "Edit",
  grep_search: "Grep",
  search_directory: "Grep",
  list_dir: "Glob",
  find_by_name: "Glob",
  find_file: "Glob",
  list_directory: "Glob",
  invoke_subagent: "Agent",
  search_web: "WebSearch",
  read_url_content: "WebFetch",
};

const MISSING = Symbol("missing");

function firstArg(args: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in args) return args[key];
  }
  return MISSING;
}

// Some Antigravity args arrive as JSON string literals (e.g. '"pytest -q"').
// Decode them when the literal is a scalar; otherwise keep the original string.
function canonicalValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (
    typeof parsed === "string" ||
    typeof parsed === "boolean" ||
    typeof parsed === "number"
  ) {
    return parsed;
  }
  return value;
}

function canonicalToolName(name: string): string {
  return ANTIGRAVITY_TOOL_MAP[name] ?? name;
}

interface AntigravityEntry {
  tool_calls?: unknown;
  toolCalls?: unknown;
  PLANNER_RESPONSE?: unknown;
  planner_response?: unknown;
}

interface AntigravityToolCall {
  name?: unknown;
  args?: unknown;
}

function antigravityToolCalls(entry: AntigravityEntry): AntigravityToolCall[] {
  const containers: Record<string, unknown>[] = [entry as Record<string, unknown>];
  for (const plannerKey of ["PLANNER_RESPONSE", "planner_response"] as const) {
    const plannerResponse = entry[plannerKey];
    if (plannerResponse && typeof plannerResponse === "object") {
      containers.push(plannerResponse as Record<string, unknown>);
    }
  }

  const calls: AntigravityToolCall[] = [];
  for (const container of containers) {
    for (const callsKey of ["tool_calls", "toolCalls"] as const) {
      const toolCalls = container[callsKey];
      if (!Array.isArray(toolCalls)) continue;
      for (const call of toolCalls) {
        if (call && typeof call === "object") calls.push(call as AntigravityToolCall);
      }
    }
  }
  return calls;
}

function normalizeAntigravityArgs(name: string, rawArgs: unknown): Record<string, unknown> {
  const isObject = typeof rawArgs === "object" && rawArgs !== null;
  const originalArgs = isObject ? { ...(rawArgs as Record<string, unknown>) } : rawArgs;
  const args: Record<string, unknown> = isObject ? { ...(rawArgs as Record<string, unknown>) } : {};

  args["raw_args"] = originalArgs;

  if (!isObject) return args;
  const ra = rawArgs as Record<string, unknown>;

  if (name === "run_command") {
    const command = firstArg(ra, ["CommandLine", "command"]);
    if (command !== MISSING) args["command"] = canonicalValue(command);
    const cwd = firstArg(ra, ["Cwd", "cwd", "WorkingDirectory", "working_directory"]);
    if (cwd !== MISSING) args["cwd"] = canonicalValue(cwd);
  } else if (name === "view_file") {
    const filePath = firstArg(ra, ["AbsolutePath", "Path", "path", "file_path", "filePath"]);
    if (filePath !== MISSING) args["file_path"] = canonicalValue(filePath);

    let isSkillFile = firstArg(ra, ["IsSkillFile", "isSkillFile", "is_skill_file"]);
    if (isSkillFile === MISSING) {
      const metadata = ra["metadata"];
      if (metadata && typeof metadata === "object") {
        isSkillFile = firstArg(metadata as Record<string, unknown>, [
          "IsSkillFile",
          "isSkillFile",
          "is_skill_file",
        ]);
      }
    }
    if (isSkillFile !== MISSING) args["is_skill_file"] = canonicalValue(isSkillFile);
  } else if (name === "list_dir") {
    const path = firstArg(ra, ["DirectoryPath", "directory_path", "path"]);
    if (path !== MISSING) args["path"] = canonicalValue(path);
  } else if (
    [
      "write_to_file",
      "create_file",
      "replace_file_content",
      "multi_replace_file_content",
      "edit_file",
    ].includes(name)
  ) {
    const filePath = firstArg(ra, [
      "TargetFile",
      "target_file",
      "TargetPath",
      "Path",
      "path",
      "file_path",
      "filePath",
    ]);
    if (filePath !== MISSING) args["file_path"] = canonicalValue(filePath);
  }

  return args;
}

/**
 * Convert an Antigravity JSONL transcript into an ATIF v1.7 trajectory.
 *
 * Antigravity emits tool calls in top-level tool_calls/toolCalls arrays and,
 * for planner turns, nested under PLANNER_RESPONSE/planner_response.
 */
export function normalizeAntigravity(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: AntigravityEntry;
    try {
      entry = JSON.parse(line) as AntigravityEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    for (const toolCall of antigravityToolCalls(entry)) {
      const name = toolCall["name"];
      if (typeof name !== "string" || !name) continue;
      const canonical = canonicalToolName(name);
      const args = normalizeAntigravityArgs(name, toolCall["args"] ?? {});

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
    agent: { name: "antigravity", version },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(`normalizeAntigravity produced invalid ATIF: ${result.errors.join("; ")}`);
  }

  return traj;
}
