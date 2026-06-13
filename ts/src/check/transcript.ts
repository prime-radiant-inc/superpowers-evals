// check/transcript.ts — load and flatten an ATIF trajectory.json from env.
//
// Reads QUORUM_TRANSCRIPT_PATH (a trajectory.json file). If the file is
// missing, unreadable, or has no tool calls after flattening → empty: true.

import { readFileSync } from "node:fs";

import type { AtifTrajectory } from "../atif/types.ts";
import { flattenToolCalls, type ToolCallView } from "../atif/project.ts";

export interface TranscriptResult {
  calls: ToolCallView[];
  empty: boolean;
}

export function loadCalls(): TranscriptResult {
  const path = process.env["QUORUM_TRANSCRIPT_PATH"];
  if (!path) {
    return { calls: [], empty: true };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { calls: [], empty: true };
  }

  let traj: AtifTrajectory;
  try {
    traj = JSON.parse(raw) as AtifTrajectory;
  } catch {
    return { calls: [], empty: true };
  }

  const calls = flattenToolCalls(traj);
  if (calls.length === 0) {
    return { calls: [], empty: true };
  }

  return { calls, empty: false };
}
