// Seat records: one per thread of a recorded eval run.
//
// A "seat" is a thread with a job — the controller, or one subagent dispatched
// to fill a named role in the subagent-driven-development loop. The run's
// trajectory.json cannot answer seat questions: it flattens every thread into
// one steps[] array and drops thread identity (AtifTrajectory declares
// subagent_trajectories but nothing writes it). These records come from the raw
// per-thread logs the agent CLI left under the run dir.

import type { SuiteFamily, SuiteScope } from './test-commands.ts';

/** Which harness dialect the run's logs are in. */
export type SeatDialect = 'claude' | 'codex';

/**
 * The seat's job in the SDD loop.
 *
 * - `controller`      the root thread that dispatches everything else
 * - `implementer`     builds a task, or applies a fix wave
 * - `task_reviewer`   reviews one task's work (spec and/or quality)
 * - `fix_reviewer`    re-reviews after a fix (a re-review / scoped fix review)
 * - `final_reviewer`  reviews the whole branch at the end
 * - `other`           the label did not identify a role. Never a fallback for a
 *                     role we could have read — an honest "unclassified".
 */
export type SeatRole =
  | 'controller'
  | 'implementer'
  | 'task_reviewer'
  | 'fix_reviewer'
  | 'final_reviewer'
  | 'other';

export const SEAT_ROLES: readonly SeatRole[] = [
  'controller',
  'implementer',
  'task_reviewer',
  'fix_reviewer',
  'final_reviewer',
  'other',
];

/** One thing a seat did. `patch` is a file mutation; `tool_call` is everything
 *  else the thread invoked. */
export interface SeatEvent {
  readonly kind: 'tool_call' | 'patch';
  readonly tool: string;
  /** The shell command, when the call was a shell call. */
  readonly command?: string;
  readonly timestamp: string;
  readonly isSuiteRun?: boolean;
  /** Broadest scope among the families this one call ran: `full` if any family
   *  ran package-wide. */
  readonly suiteScope?: SuiteScope;
  readonly suiteFamilies?: readonly SuiteFamily[];
  readonly isEvidenceRead?: boolean;
  /** Set by redundancy adjudication over the whole run's timeline. */
  readonly redundant?: boolean;
}

export interface SeatRecord {
  readonly runId: string;
  readonly scenario: string | null;
  readonly agent: string;
  readonly credential: string | null;
  /** Stable within a run: the Claude agentId / thread uuid, or the Codex
   *  thread id. */
  readonly seatId: string;
  readonly role: SeatRole;
  /** The raw label the role was read from: a Claude meta.json description, or a
   *  Codex agent_path. Empty for a controller with no label. */
  readonly taskLabel: string;
  readonly spawnDepth: number | null;
  readonly parentId: string | null;
  readonly models: readonly string[];
  readonly events: readonly SeatEvent[];
}

export interface RunSeats {
  readonly runId: string;
  readonly runDir: string;
  readonly dialect: SeatDialect;
  readonly scenario: string | null;
  readonly agent: string;
  readonly credential: string | null;
  /** verdict.json provenance.superpowers_rev — the arm identity. */
  readonly superpowersRev: string | null;
  readonly superpowersDirty: boolean | null;
  readonly seats: readonly SeatRecord[];
}
