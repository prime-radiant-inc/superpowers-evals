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
 * - `reviewer`        judges work, but the log does not say which review seat.
 *                     Deliberately coarse: a reviewer whose subtype is unknown
 *                     must not be counted as a per-task, fix, or final reviewer,
 *                     because the three have different mandates and different
 *                     rates. Only ever produced by the coarsest signal.
 * - `other`           the label did not identify a role. Never a fallback for a
 *                     role we could have read — an honest "unclassified".
 */
export type SeatRole =
  | 'controller'
  | 'implementer'
  | 'task_reviewer'
  | 'fix_reviewer'
  | 'final_reviewer'
  | 'reviewer'
  | 'other';

export const SEAT_ROLES: readonly SeatRole[] = [
  'controller',
  'implementer',
  'task_reviewer',
  'fix_reviewer',
  'final_reviewer',
  'reviewer',
  'other',
];

/**
 * Which signal the seat's role was read from.
 *
 * Confidence is not uniform across these, so it is recorded rather than
 * flattened: a rate computed over `agent_path` and `description` seats is a
 * measurement, and one that mixes in `agent_role` seats is partly an inference.
 * Downstream analysis has to be able to draw that line.
 *
 * - `thread_root`      no spawn record: the thread is the run's controller
 * - `agent_path`       Codex thread_spawn.agent_path, the controller-chosen
 *                      thread name — the signal we trust
 * - `description`      Claude meta.json description, written by the controller
 * - `dispatch_prompt`  the child thread's own opening instruction, used when the
 *                      CLI recorded no agent_path
 * - `agent_role`       Codex thread_spawn.agent_role ("worker" / "default"), a
 *                      two-way split and the last resort
 * - `unclassified`     no signal identified a role; the role is `other`
 */
export type RoleSource =
  | 'thread_root'
  | 'agent_path'
  | 'description'
  | 'dispatch_prompt'
  | 'agent_role'
  | 'unclassified';

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
  /** Which signal produced `role`. */
  readonly roleSource: RoleSource;
  /** The raw label the role was read from: a Claude meta.json description, a
   *  Codex agent_path, or the opening line of a Codex dispatch prompt. Empty for
   *  a controller with no label. */
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
