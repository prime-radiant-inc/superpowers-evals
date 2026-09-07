// check/transcript.ts — load and flatten an ATIF trajectory.json from env.
//
// Reads QUORUM_TRANSCRIPT_PATH (a trajectory.json file). If the file is
// missing, unreadable, or invalid, its evidence is unavailable.

import { readFileSync } from 'node:fs';
import { flattenToolCalls, type ToolCallView } from '../atif/project.ts';
import type { AtifTrajectory } from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import type { CaptureAvailability } from '../capture/index.ts';
import { getEnv } from '../env.ts';

export interface TranscriptResult {
  calls: ToolCallView[];
  availability: CaptureAvailability;
}

export function loadCalls(): TranscriptResult {
  const path = getEnv('QUORUM_TRANSCRIPT_PATH');
  if (!path) {
    return { calls: [], availability: 'unavailable' };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { calls: [], availability: 'unavailable' };
  }

  let calls: ToolCallView[];
  try {
    const traj = JSON.parse(raw) as AtifTrajectory;
    if (!validateTrajectory(traj).ok) {
      return { calls: [], availability: 'unavailable' };
    }
    calls = flattenToolCalls(traj);
  } catch {
    return { calls: [], availability: 'unavailable' };
  }
  const availability = getEnv('QUORUM_CAPTURE_AVAILABILITY');
  if (availability === 'unavailable' || availability === 'errored') {
    return { calls, availability };
  }
  if (availability !== undefined && availability !== 'available') {
    return { calls, availability: 'unavailable' };
  }
  return { calls, availability: 'available' };
}
