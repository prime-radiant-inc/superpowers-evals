import { ATIF_SCHEMA_VERSION, type AtifTrajectory, type AtifStep, type AtifSource } from "./types.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const AGENT_ONLY: (keyof AtifStep)[] = ["tool_calls", "reasoning_content", "model_name", "metrics", "observation"];

const VALID_SOURCES = new Set<string>(["system", "user", "agent"] satisfies AtifSource[]);

export function validateTrajectory(t: AtifTrajectory): ValidationResult {
  const errors: string[] = [];

  if (t.schema_version !== ATIF_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${ATIF_SCHEMA_VERSION}, got ${String(t.schema_version)}`);
  }
  if (!t.agent || !t.agent.name || !t.agent.version) {
    errors.push("agent.name and agent.version are required");
  }
  if (!Array.isArray(t.steps) || t.steps.length < 1) {
    errors.push("steps must be a non-empty array");
    return { ok: errors.length === 0, errors };
  }

  t.steps.forEach((step, i) => {
    const expectedId = i + 1;
    if (step.step_id !== expectedId) {
      errors.push(`step[${i}].step_id must be ${expectedId} (sequential from 1), got ${step.step_id}`);
    }
    if (!VALID_SOURCES.has(step.source)) {
      errors.push(`step[${i}].source invalid: ${String(step.source)}`);
    }
    if (step.source !== "agent") {
      for (const field of AGENT_ONLY) {
        if (step[field] !== undefined) {
          errors.push(`step[${i}] has agent-only field "${field}" on a ${step.source} step`);
        }
      }
    }
    const toolCalls = step.tool_calls ?? [];
    const callIds = new Set(toolCalls.map((c) => c.tool_call_id));
    if (toolCalls.length !== callIds.size) {
      errors.push(`step[${i}] has duplicate tool_call_id values`);
    }
    for (const result of step.observation?.results ?? []) {
      if (result.source_call_id != null && !callIds.has(result.source_call_id)) {
        errors.push(
          `step[${i}] observation source_call_id "${result.source_call_id}" does not match a tool_call in the same step`,
        );
      }
    }
  });

  return { ok: errors.length === 0, errors };
}
