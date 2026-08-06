// seat-scan CLI — offline scorer for test-suite invocations by subagent seat.
//
// Usage:
//   bun run src/cli/seat-scan.ts --results <dir> [--scenario-prefix sdd-]
//                                [--json <path>]
//
// Reads only the recorded runs under <dir>; writes nothing there. The run's
// trajectory.json is not used — it flattens every thread into one steps[] array
// and drops thread identity, so it cannot answer a per-seat question. The raw
// per-thread logs the agent CLI left behind are the source.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RollupRow } from '../seats/aggregate.ts';
import { discoverRuns, rollup, scanRun } from '../seats/aggregate.ts';
import type { RunSeats } from '../seats/types.ts';

interface Options {
  readonly results: string;
  readonly scenarioPrefix: string;
  readonly json: string | null;
}

function parseArgs(argv: readonly string[]): Options | string {
  let results: string | null = null;
  let scenarioPrefix = '';
  let json: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--results') {
      if (value === undefined) {
        return '--results needs a directory';
      }
      results = value;
      i += 1;
    } else if (flag === '--scenario-prefix') {
      if (value === undefined) {
        return '--scenario-prefix needs a value';
      }
      scenarioPrefix = value;
      i += 1;
    } else if (flag === '--json') {
      if (value === undefined) {
        return '--json needs a path';
      }
      json = value;
      i += 1;
    } else {
      return `unknown argument: ${flag}`;
    }
  }
  if (results === null) {
    return '--results is required';
  }
  return { results, scenarioPrefix, json };
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return '  — ';
  }
  return `${Math.round((100 * numerator) / denominator)
    .toString()
    .padStart(3)}%`;
}

const HEADER = [
  'agent'.padEnd(8),
  'role'.padEnd(15),
  'seats'.padStart(6),
  '≥1run'.padStart(7),
  '≥1full'.padStart(7),
  '≥1redun'.padStart(8),
  'runs'.padStart(6),
  'full'.padStart(6),
  'redun'.padStart(6),
  'reads'.padStart(6),
  'reps'.padStart(6),
  'rep≥1run'.padStart(9),
  'rep≥1full'.padStart(10),
  'rep≥1redun'.padStart(11),
].join(' ');

function renderRow(row: RollupRow): string {
  return [
    row.agent.padEnd(8),
    row.role.padEnd(15),
    String(row.seats).padStart(6),
    pct(row.seatsWithSuiteRun, row.seats).padStart(7),
    pct(row.seatsWithFullSuiteRun, row.seats).padStart(7),
    pct(row.seatsWithRedundantSuiteRun, row.seats).padStart(8),
    String(row.suiteRuns).padStart(6),
    String(row.fullSuiteRuns).padStart(6),
    String(row.redundantSuiteRuns).padStart(6),
    String(row.evidenceReads).padStart(6),
    String(row.reps).padStart(6),
    pct(row.repsWithSuiteRun, row.reps).padStart(9),
    pct(row.repsWithFullSuiteRun, row.reps).padStart(10),
    pct(row.repsWithRedundantSuiteRun, row.reps).padStart(11),
  ].join(' ');
}

/** Per-seat rows for downstream stats: one JSON object per seat, flat. */
function jsonPayload(runs: readonly RunSeats[], rows: readonly RollupRow[]) {
  return {
    generated_by: 'src/cli/seat-scan.ts',
    runs: runs.length,
    rollup: rows,
    seats: runs.flatMap((run) =>
      run.seats.map((seat) => {
        const suiteRuns = seat.events.filter((e) => e.isSuiteRun === true);
        return {
          run_id: run.runId,
          scenario: run.scenario,
          agent: run.agent,
          credential: run.credential,
          dialect: run.dialect,
          superpowers_rev: run.superpowersRev,
          superpowers_dirty: run.superpowersDirty,
          seat_id: seat.seatId,
          role: seat.role,
          role_source: seat.roleSource,
          task_label: seat.taskLabel,
          spawn_depth: seat.spawnDepth,
          parent_id: seat.parentId,
          models: seat.models,
          applied_no_patches: !seat.events.some((e) => e.kind === 'patch'),
          tool_calls: seat.events.filter((e) => e.kind === 'tool_call').length,
          patches: seat.events.filter((e) => e.kind === 'patch').length,
          suite_runs: suiteRuns.length,
          full_suite_runs: suiteRuns.filter((e) => e.suiteScope === 'full')
            .length,
          focused_suite_runs: suiteRuns.filter(
            (e) => e.suiteScope === 'focused',
          ).length,
          redundant_suite_runs: suiteRuns.filter((e) => e.redundant === true)
            .length,
          evidence_reads: seat.events.filter((e) => e.isEvidenceRead === true)
            .length,
          suite_commands: suiteRuns.map((e) => ({
            command: e.command ?? null,
            families: e.suiteFamilies ?? [],
            scope: e.suiteScope ?? null,
            redundant: e.redundant ?? null,
            timestamp: e.timestamp,
          })),
        };
      }),
    ),
  };
}

const parsed = parseArgs(Bun.argv.slice(2));
if (typeof parsed === 'string') {
  console.error(`seat-scan: ${parsed}`);
  console.error(
    'usage: seat-scan --results <dir> [--scenario-prefix sdd-] [--json <path>]',
  );
  process.exit(2);
}

const runDirs = discoverRuns(parsed.results, parsed.scenarioPrefix);
const runs: RunSeats[] = [];
for (const dir of runDirs) {
  const run = scanRun(dir);
  if (run !== null) {
    runs.push(run);
  }
}

const rows = rollup(runs);

const byDialect = new Map<string, number>();
for (const run of runs) {
  byDialect.set(run.dialect, (byDialect.get(run.dialect) ?? 0) + 1);
}
const withoutScenario = runs.filter((r) => r.scenario === null).length;
const unclassified = runs.reduce(
  (n, run) => n + run.seats.filter((s) => s.role === 'other').length,
  0,
);
const totalSeats = runs.reduce((n, run) => n + run.seats.length, 0);

console.log(
  `seat-scan: ${runs.length} runs with per-thread logs under ${parsed.results}` +
    (parsed.scenarioPrefix === ''
      ? ''
      : ` (prefix "${parsed.scenarioPrefix}")`),
);
console.log(
  `  dialects: ${[...byDialect]
    .map(([d, n]) => `${d}=${n}`)
    .join(
      ' ',
    )}   seats: ${totalSeats}   unclassified seats (role=other): ${unclassified}`,
);
if (withoutScenario > 0) {
  console.log(
    `  ${withoutScenario} runs predate the verdict schema's scenario/agent/credential fields;` +
      ' their agent comes from the log dialect and scenario/credential are null.',
  );
}
console.log('');
console.log(HEADER);
console.log('-'.repeat(HEADER.length));
for (const row of rows) {
  console.log(renderRow(row));
}
console.log('');
console.log(
  'Percentages are of the column-2 denominator (seats, or reps). "runs"/"full"/' +
    '"redun" are raw event counts; a redundant run is also counted in "runs".',
);
console.log(
  'LIMITATION: "redundant" means no recorded file mutation (apply_patch / Edit /' +
    ' Write) landed between this suite run and an earlier run of the same suite',
);
console.log(
  'family. Git checkouts, branch switches, merges, and dependency installs are' +
    ' not tracked, so redundancy is an upper bound on wasted runs, not a count of them.',
);

if (parsed.json !== null) {
  mkdirSync(dirname(parsed.json), { recursive: true });
  writeFileSync(
    parsed.json,
    `${JSON.stringify(jsonPayload(runs, rows), null, 2)}\n`,
  );
  console.log(`\nwrote ${parsed.json}`);
}
