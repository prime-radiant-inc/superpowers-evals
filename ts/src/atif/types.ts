// ATIF v1.7 — Agent Trajectory Interchange Format (Harbor framework).
// Canonical transcript schema for quorum. We model the core fields quorum
// needs; training-only fields (token ids, logprobs) are intentionally omitted
// but survive round-trips via `extra`. Pin the version — ATIF has had breaking
// changes across minors.

export const ATIF_SCHEMA_VERSION = "ATIF-v1.7" as const;

export type AtifSource = "system" | "user" | "agent";

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface AtifObservationResult {
  source_call_id?: string;
  content?: string | unknown[] | null;
  extra?: Record<string, unknown>;
}

export interface AtifObservation {
  results: AtifObservationResult[];
}

export interface AtifMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  extra?: Record<string, unknown>;
}

export interface AtifStep {
  step_id: number;
  timestamp?: string;
  source: AtifSource;
  model_name?: string;
  message?: string | unknown[];
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: AtifObservation;
  metrics?: AtifMetrics;
  extra?: Record<string, unknown>;
}

export interface AtifAgent {
  name: string;
  version: string;
  model_name?: string;
  extra?: Record<string, unknown>;
}

export interface AtifFinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cost_usd?: number;
  total_steps?: number;
  extra?: Record<string, unknown>;
}

export interface AtifTrajectory {
  schema_version: typeof ATIF_SCHEMA_VERSION;
  session_id?: string;
  trajectory_id?: string;
  agent: AtifAgent;
  steps: AtifStep[];
  final_metrics?: AtifFinalMetrics;
  subagent_trajectories?: AtifTrajectory[];
  extra?: Record<string, unknown>;
}
