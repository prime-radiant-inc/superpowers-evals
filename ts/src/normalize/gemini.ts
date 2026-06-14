import {
  ATIF_SCHEMA_VERSION,
  type AtifTrajectory,
  type AtifStep,
  type AtifToolCall,
} from "../atif/types.ts";
import { validateTrajectory } from "../atif/validate.ts";

// Reverse mapping: Gemini tool names → canonical names.
const GEMINI_TOOL_MAP: Record<string, string> = {
  run_shell_command: "Bash",
  read_file: "Read",
  write_file: "Write",
  replace: "Edit",
  grep_search: "Grep",
  glob: "Glob",
  activate_skill: "Skill",
  google_web_search: "WebSearch",
  web_fetch: "WebFetch",
  write_todos: "TodoWrite",
  list_directory: "Glob",
  enter_plan_mode: "EnterPlanMode",
  exit_plan_mode: "ExitPlanMode",
};

interface GeminiMessage {
  type?: string;
  timestamp?: string | number;
  createdAt?: string | number;
  time?: string | number;
  toolCalls?: GeminiToolCall[];
  [key: string]: unknown;
}

/**
 * Extract an ISO-8601 step timestamp from a Gemini message.
 *
 * Accepts `timestamp`, `createdAt`, or `time` (in that priority order).
 * String values are used verbatim; numeric values (epoch milliseconds) are
 * converted to an ISO-8601 string so the merge in quorum/capture.py can
 * order steps from multiple logs by event time.
 */
function extractTimestamp(message: GeminiMessage): string | undefined {
  const raw = message["timestamp"] ?? message["createdAt"] ?? message["time"];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (typeof raw === "number" && isFinite(raw)) {
    return new Date(raw).toISOString();
  }
  return undefined;
}

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  status?: string;
}

function parseGeminiMessages(raw: string): GeminiMessage[] {
  const messages: GeminiMessage[] = [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (typeof data === "object" && data !== null) {
      const obj = data as Record<string, unknown>;
      if ("messages" in obj && Array.isArray(obj["messages"])) {
        for (const m of obj["messages"]) {
          if (typeof m === "object" && m !== null) messages.push(m as GeminiMessage);
        }
      } else if (Array.isArray(data)) {
        for (const m of data) {
          if (typeof m === "object" && m !== null) messages.push(m as GeminiMessage);
        }
      } else {
        messages.push(obj as GeminiMessage);
      }
    }
  } catch {
    // JSONL fallback
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as unknown;
        if (typeof entry === "object" && entry !== null) {
          messages.push(entry as GeminiMessage);
        }
      } catch {
        continue;
      }
    }
  }
  return messages;
}

function normalizeGeminiToolCall(tc: GeminiToolCall): AtifToolCall {
  const geminiName = tc.name ?? "";
  const canonical = GEMINI_TOOL_MAP[geminiName] ?? geminiName;
  const rawArgs = tc.args ?? {};
  const args: Record<string, unknown> = { ...rawArgs };

  if (canonical === "Skill") {
    // Gemini passes skill via "skill" or "name" key; normalize to "skill" with namespace.
    const skillName =
      (typeof args["skill"] === "string" ? args["skill"] : null) ??
      (typeof args["name"] === "string" ? args["name"] : null) ??
      "";
    if (skillName) {
      args["skill"] = skillName.includes(":") ? skillName : `superpowers:${skillName}`;
    }
  }

  return {
    tool_call_id: tc.id ?? "",
    function_name: canonical,
    arguments: args,
  };
}

/**
 * Convert a Gemini CLI session log into an ATIF v1.7 trajectory.
 *
 * Gemini logs may be a single JSON object with a "messages" array, a plain
 * JSON array, or JSONL. Each "gemini"-type message may carry a toolCalls
 * array. Duplicate tool call ids (same id across messages) are deduplicated.
 * Each tool call becomes its own agent step.
 */
export function normalizeGemini(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  const seenIds = new Set<string>();
  let stepId = 1;

  for (const message of parseGeminiMessages(raw)) {
    if (message["type"] !== "gemini") continue;
    const toolCalls = message["toolCalls"];
    if (!Array.isArray(toolCalls)) continue;
    const timestamp = extractTimestamp(message);

    for (const tc of toolCalls) {
      if (typeof tc !== "object" || tc === null) continue;
      const gtc = tc as GeminiToolCall;
      const id = gtc.id;
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }

      const atifTc = normalizeGeminiToolCall(gtc);
      const step: AtifStep = {
        step_id: stepId++,
        source: "agent",
        tool_calls: [atifTc],
      };
      if (timestamp) step.timestamp = timestamp;
      steps.push(step);
    }
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: "user", message: "" });
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: "gemini", version },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(`normalizeGemini produced invalid ATIF: ${result.errors.join("; ")}`);
  }

  return traj;
}
