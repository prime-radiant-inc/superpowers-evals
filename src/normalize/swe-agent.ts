// Ported from Harbor's src/harbor/agents/installed/swe_agent.py
//   repo:   https://github.com/laude-institute/harbor (Apache-2.0)
//   commit: 5352049de712613e58459cad41afcf0bf8645738 (v0.14.0)
// Log-parsing logic is derived from Harbor; token buckets, tool-name
// canonicalization, and message-id dedup follow OUR conventions
// (docs/superpowers/reference/atif-normalizers.md), NOT Harbor's.

import {
  ATIF_SCHEMA_VERSION,
  type AtifFinalMetrics,
  type AtifStep,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// SWE-agent emits a single synthetic tool named `swe_agent_action` whose
// argument is the raw shell command the agent executed. SWE-agent operates
// in a bash environment (the testbed container), so every action is a shell
// command — map the synthetic tool name to the canonical `Bash`.
const SWE_AGENT_TOOL_MAP: Record<string, string> = {
  swe_agent_action: 'Bash',
};

interface SweAgentStep {
  response?: string;
  thought?: string;
  action?: string;
  observation?: string;
  state?: string;
  query?: Array<{ role?: string; content?: string }>;
}

interface SweAgentInfo {
  model_name?: string;
  model?: string;
  swe_agent_version?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_cost?: number;
  cost?: number;
}

interface SweAgentTraj {
  environment?: string;
  trajectory?: SweAgentStep[];
  info?: SweAgentInfo;
}

/**
 * Convert a SWE-agent .traj JSON log into an ATIF v1.7 trajectory.
 *
 * SWE-agent writes a single JSON file (*.traj) with shape:
 *   {
 *     "environment": "swe_main",
 *     "trajectory": [
 *       {
 *         "response":    "full LLM output",
 *         "thought":     "parsed reasoning",
 *         "action":      "shell command executed",
 *         "observation": "result of action",
 *         "state":       "env state snapshot",
 *         "query":       [{"role": "system", "content": "..."}, ...]  // only on first step
 *       },
 *       ...
 *     ],
 *     "info": {
 *       "model_name":        "claude-3-5-sonnet-20241022",  // or "model"
 *       "swe_agent_version": "0.9.1",
 *       "input_tokens":      4200,
 *       "output_tokens":     310,
 *       "total_cost":        0.015   // or "cost"
 *     }
 *   }
 *
 * Token usage: SWE-agent logs only session-cumulative totals in the `info`
 * block. There is no per-step or per-turn usage data. Per the SINGLE-SOURCE
 * invariant, token counts go to `final_metrics` ONLY — never per-step metrics.
 * Zero counts are treated as absent (matching Harbor's `or 0` / `if > 0 else
 * None` pattern). The log records a cost (total_cost / cost) → emit as
 * final_metrics.total_cost_usd when non-zero.
 *
 * Tool canonicalization: `swe_agent_action` → `Bash`. SWE-agent runs inside
 * a bash-capable testbed container; every action is a shell command.
 *
 * No session_id: the .traj format carries no session identifier.
 *
 * No dedup: the .traj format is a sequential JSON array, not a streaming
 * JSONL; rows are never re-emitted, so no id-based dedup is needed.
 */
export function normalizeSweAgent(
  raw: string,
  version: string,
): AtifTrajectory {
  // Parse the raw .traj JSON. On parse failure, return a minimal valid trajectory.
  let parsed: SweAgentTraj;
  try {
    parsed = JSON.parse(raw) as SweAgentTraj;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      parsed = {};
    }
  } catch {
    parsed = {};
  }

  const info: SweAgentInfo = parsed.info ?? {};
  const environment = parsed.environment ?? 'unknown';
  const modelName: string | undefined =
    (typeof info.model_name === 'string' && info.model_name
      ? info.model_name
      : undefined) ??
    (typeof info.model === 'string' && info.model ? info.model : undefined);

  const trajectorySteps: SweAgentStep[] = Array.isArray(parsed.trajectory)
    ? parsed.trajectory
    : [];

  const steps: AtifStep[] = [];
  let stepId = 1;

  // Emit a system step from the first query if a system message is present.
  // Mirrors Harbor's convert_swe_agent_to_atif: reads trajectory_steps[0].query
  // and emits a step for the first entry with role === "system".
  const firstStep = trajectorySteps[0];
  if (firstStep && Array.isArray(firstStep.query)) {
    for (const msg of firstStep.query) {
      if (msg && msg.role === 'system') {
        const sysStep: AtifStep = {
          step_id: stepId++,
          source: 'system',
        };
        const content = msg.content ?? '';
        if (content) sysStep.message = content;
        steps.push(sysStep);
        break;
      }
    }
  }

  // Convert each trajectory entry to an agent step.
  for (const entry of trajectorySteps) {
    const thought = entry.thought ?? '';
    const action = entry.action ?? '';
    const observation = entry.observation ?? '';
    const response = entry.response ?? '';

    const toolCallId = `call_${stepId}_1`;

    const step: AtifStep = {
      step_id: stepId++,
      source: 'agent',
    };

    if (response) step.message = response;
    if (thought) step.reasoning_content = thought;

    if (action) {
      const nativeName = 'swe_agent_action';
      const canonical = SWE_AGENT_TOOL_MAP[nativeName] ?? nativeName;
      const tc = canonicalizeAgentPrompt({
        tool_call_id: toolCallId,
        function_name: canonical,
        arguments: { raw_action: action },
      });
      step.tool_calls = [tc];

      // Observation attaches to the same step; source_call_id matches tool_call_id.
      if (observation) {
        step.observation = {
          results: [{ source_call_id: toolCallId, content: observation }],
        };
      }
    }

    steps.push(step);
  }

  // Ensure at least one step (validateTrajectory requires a non-empty array).
  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  // Re-number step_ids sequentially from 1 (required by validateTrajectory).
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step) step.step_id = i + 1;
  }

  // Token usage: session-total only → final_metrics (SINGLE-SOURCE invariant).
  // Zeros are treated as absent (Harbor: `or 0` + `if > 0 else None`).
  // No cache split in this format: no cached_tokens / cache_write.
  const rawInput = info.input_tokens ?? 0;
  const rawOutput = info.output_tokens ?? 0;
  const rawCost = info.total_cost ?? info.cost ?? 0;

  let finalMetrics: AtifFinalMetrics | undefined;
  if (rawInput > 0 || rawOutput > 0 || rawCost > 0) {
    finalMetrics = {};
    if (rawInput > 0) finalMetrics.total_prompt_tokens = rawInput;
    if (rawOutput > 0) finalMetrics.total_completion_tokens = rawOutput;
    if (rawCost > 0) finalMetrics.total_cost_usd = rawCost;
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: {
      name: 'swe-agent',
      version,
      extra: {
        original_format: 'swe-agent-traj',
        environment,
      },
    },
    steps,
  };

  if (modelName) traj.agent.model_name = modelName;
  if (finalMetrics) traj.final_metrics = finalMetrics;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeSweAgent produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
