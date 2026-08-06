// Run discovery, per-run scanning, and the (agent, role) rollup.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hasClaudeLogs, parseClaudeThreads } from './parse-claude.ts';
import { hasCodexLogs, parseCodexThreads } from './parse-codex.ts';
import { markRedundantSuiteRuns } from './redundancy.ts';
import { appliedNoPatches } from './roles.ts';
import { readJsonFile } from './thread.ts';
import {
  type RunSeats,
  SEAT_ROLES,
  type SeatDialect,
  type SeatEvent,
  type SeatRecord,
  type SeatRole,
} from './types.ts';

/**
 * Run dirs under `resultsRoot` whose basename starts with `scenarioPrefix`.
 *
 * A directory is a run when it carries a per-thread log tree. verdict.json is
 * NOT the test: 14 of the recorded sdd-* runs have logs but no verdict (the
 * harness was killed before scoring), and dropping them would silently shrink
 * the corpus. The scan goes two levels deep because recorded batches
 * (sdd-e27-stack-*) hold their runs as subdirectories and carry no logs of
 * their own.
 */
export function discoverRuns(
  resultsRoot: string,
  scenarioPrefix = '',
): string[] {
  if (!existsSync(resultsRoot)) {
    return [];
  }
  const out: string[] = [];
  for (const name of readdirSync(resultsRoot).sort()) {
    if (name.startsWith('.')) {
      continue;
    }
    const dir = join(resultsRoot, name);
    if (!statSync(dir).isDirectory()) {
      continue;
    }
    const matches = name.startsWith(scenarioPrefix);
    if (matches && (hasClaudeLogs(dir) || hasCodexLogs(dir))) {
      out.push(dir);
      continue;
    }
    // A batch dir: its own name still has to match the prefix, but the runs
    // inside it are what get scanned.
    if (!matches) {
      continue;
    }
    for (const child of readdirSync(dir).sort()) {
      if (child.startsWith('.')) {
        continue;
      }
      const childDir = join(dir, child);
      if (!statSync(childDir).isDirectory()) {
        continue;
      }
      if (hasClaudeLogs(childDir) || hasCodexLogs(childDir)) {
        out.push(childDir);
      }
    }
  }
  return out;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Scan one run dir into seat records, with redundancy already adjudicated.
 *
 * Returns null when the dir has no per-thread logs in a dialect we read.
 *
 * Run identity comes from verdict.json when it has it. Older verdicts predate
 * the scenario/coding_agent/credential fields; rather than parse the directory
 * name (whose scenario/agent/credential/os boundaries are ambiguous — nothing
 * separates a multi-word scenario from the agent token), the agent falls back
 * to the log dialect, which is unambiguous, and scenario/credential stay null.
 */
export function scanRun(runDir: string): RunSeats | null {
  const dialect: SeatDialect | null = hasClaudeLogs(runDir)
    ? 'claude'
    : hasCodexLogs(runDir)
      ? 'codex'
      : null;
  if (dialect === null) {
    return null;
  }
  const runId = basename(runDir);
  const threads = markRedundantSuiteRuns(
    dialect === 'claude'
      ? parseClaudeThreads(runDir)
      : parseCodexThreads(runDir),
  );
  const verdict = readJsonFile(join(runDir, 'verdict.json')) ?? {};
  const provenance = verdict['provenance'];
  const prov =
    typeof provenance === 'object' && provenance !== null
      ? (provenance as Record<string, unknown>)
      : {};
  const scenario = stringOrNull(verdict['scenario']);
  const agent = stringOrNull(verdict['coding_agent']) ?? dialect;
  const credential = stringOrNull(verdict['credential']);
  const dirty = prov['superpowers_dirty'];
  const seats: SeatRecord[] = threads.map((thread) => ({
    runId,
    scenario,
    agent,
    credential,
    seatId: thread.seatId,
    role: thread.role,
    roleSource: thread.roleSource,
    taskLabel: thread.taskLabel,
    spawnDepth: thread.spawnDepth,
    parentId: thread.parentId,
    models: thread.models,
    events: thread.events,
  }));
  return {
    runId,
    runDir,
    dialect,
    scenario,
    agent,
    credential,
    superpowersRev: stringOrNull(prov['superpowers_rev']),
    superpowersDirty: typeof dirty === 'boolean' ? dirty : null,
    seats,
  };
}

/** One rollup row: an (agent, role) cell, at both seat and rep granularity. */
export interface RollupRow {
  readonly agent: string;
  readonly role: SeatRole;
  readonly seats: number;
  readonly seatsWithSuiteRun: number;
  readonly seatsWithFullSuiteRun: number;
  readonly seatsWithRedundantSuiteRun: number;
  readonly seatsWithEvidenceRead: number;
  readonly seatsWithNoPatches: number;
  readonly suiteRuns: number;
  readonly fullSuiteRuns: number;
  readonly redundantSuiteRuns: number;
  readonly evidenceReads: number;
  /** Reps = runs. The rep is the randomization unit, so a rate over seats and a
   *  rate over reps answer different questions and both are reported. */
  readonly reps: number;
  readonly repsWithSuiteRun: number;
  readonly repsWithFullSuiteRun: number;
  readonly repsWithRedundantSuiteRun: number;
}

// Map key for an (agent, role) cell. The separator is a unit separator so it
// cannot collide with an agent name read out of verdict.json.
function seatKey(agent: string, role: SeatRole): string {
  return `${agent}\u001f${role}`;
}

function suiteRunsOf(events: readonly SeatEvent[]): SeatEvent[] {
  return events.filter((event) => event.isSuiteRun === true);
}

interface Cell {
  seats: number;
  seatsWithSuiteRun: number;
  seatsWithFullSuiteRun: number;
  seatsWithRedundantSuiteRun: number;
  seatsWithEvidenceRead: number;
  seatsWithNoPatches: number;
  suiteRuns: number;
  fullSuiteRuns: number;
  redundantSuiteRuns: number;
  evidenceReads: number;
  reps: Set<string>;
  repsWithSuiteRun: Set<string>;
  repsWithFullSuiteRun: Set<string>;
  repsWithRedundantSuiteRun: Set<string>;
}

function emptyCell(): Cell {
  return {
    seats: 0,
    seatsWithSuiteRun: 0,
    seatsWithFullSuiteRun: 0,
    seatsWithRedundantSuiteRun: 0,
    seatsWithEvidenceRead: 0,
    seatsWithNoPatches: 0,
    suiteRuns: 0,
    fullSuiteRuns: 0,
    redundantSuiteRuns: 0,
    evidenceReads: 0,
    reps: new Set(),
    repsWithSuiteRun: new Set(),
    repsWithFullSuiteRun: new Set(),
    repsWithRedundantSuiteRun: new Set(),
  };
}

/**
 * Roll the scanned runs up by (agent, role).
 *
 * Raw and redundant counts are kept separate throughout: a redundant run is
 * still a run that cost time and tokens, so it is included in `suiteRuns` and
 * also counted in `redundantSuiteRuns`. Never subtract one from the other and
 * call the remainder "useful".
 */
export function rollup(runs: readonly RunSeats[]): RollupRow[] {
  const cells = new Map<string, Cell>();
  const agents = new Set<string>();
  for (const run of runs) {
    agents.add(run.agent);
    // Every role present in this run counts the run as a rep for that role.
    for (const seat of run.seats) {
      const key = seatKey(run.agent, seat.role);
      const cell = cells.get(key) ?? emptyCell();
      cells.set(key, cell);
      const runsOfSuite = suiteRunsOf(seat.events);
      const full = runsOfSuite.filter((e) => e.suiteScope === 'full');
      const redundant = runsOfSuite.filter((e) => e.redundant === true);
      const reads = seat.events.filter((e) => e.isEvidenceRead === true);
      cell.seats += 1;
      cell.suiteRuns += runsOfSuite.length;
      cell.fullSuiteRuns += full.length;
      cell.redundantSuiteRuns += redundant.length;
      cell.evidenceReads += reads.length;
      if (runsOfSuite.length > 0) {
        cell.seatsWithSuiteRun += 1;
        cell.repsWithSuiteRun.add(run.runId);
      }
      if (full.length > 0) {
        cell.seatsWithFullSuiteRun += 1;
        cell.repsWithFullSuiteRun.add(run.runId);
      }
      if (redundant.length > 0) {
        cell.seatsWithRedundantSuiteRun += 1;
        cell.repsWithRedundantSuiteRun.add(run.runId);
      }
      if (reads.length > 0) {
        cell.seatsWithEvidenceRead += 1;
      }
      if (appliedNoPatches(seat.events)) {
        cell.seatsWithNoPatches += 1;
      }
      cell.reps.add(run.runId);
    }
  }
  const rows: RollupRow[] = [];
  for (const agent of [...agents].sort()) {
    for (const role of SEAT_ROLES) {
      const cell = cells.get(seatKey(agent, role));
      if (cell === undefined) {
        continue;
      }
      rows.push({
        agent,
        role,
        seats: cell.seats,
        seatsWithSuiteRun: cell.seatsWithSuiteRun,
        seatsWithFullSuiteRun: cell.seatsWithFullSuiteRun,
        seatsWithRedundantSuiteRun: cell.seatsWithRedundantSuiteRun,
        seatsWithEvidenceRead: cell.seatsWithEvidenceRead,
        seatsWithNoPatches: cell.seatsWithNoPatches,
        suiteRuns: cell.suiteRuns,
        fullSuiteRuns: cell.fullSuiteRuns,
        redundantSuiteRuns: cell.redundantSuiteRuns,
        evidenceReads: cell.evidenceReads,
        reps: cell.reps.size,
        repsWithSuiteRun: cell.repsWithSuiteRun.size,
        repsWithFullSuiteRun: cell.repsWithFullSuiteRun.size,
        repsWithRedundantSuiteRun: cell.repsWithRedundantSuiteRun.size,
      });
    }
  }
  return rows;
}
