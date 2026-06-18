import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cell, Grid, RunRecord } from '../src/dashboard/contracts.ts';
import { cellKey } from '../src/dashboard/contracts.ts';
import { scanResults } from '../src/dashboard/scan.ts';
import {
  cellStatus,
  cellView,
  costBarHeights,
  driftFlag,
  formatAge,
  formatDuration,
  formatTokens,
  headerTally,
  latestAgeDays,
  median,
  staleOpacity,
} from '../src/dashboard/view.ts';

// --- builders ----------------------------------------------------------------

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 's-claude-20260612T000000Z-aaaa',
    started_at: '20260612T000000Z',
    final: 'pass',
    cost_usd: 1,
    run_total_cost_usd: null,
    duration_ms: null,
    total_tokens: null,
    finished_at: null,
    error_stage: null,
    ...over,
  };
}

function cell(over: Partial<Cell> = {}): Cell {
  return {
    scenario: 's',
    agent: 'claude',
    os: 'linux',
    window: [],
    running: null,
    ...over,
  };
}

function grid(cells: Cell[]): Grid {
  const map = new Map<string, Cell>();
  for (const c of cells) {
    map.set(cellKey(c.scenario, c.agent, c.os), c);
  }
  return { cells: map };
}

// Build the (scenario, agent, os) identities for a list of cells — what
// headerTally now iterates.
function identitiesOf(cells: Cell[]) {
  return cells.map((c) => ({
    scenario: c.scenario,
    agent: c.agent,
    os: c.os,
  }));
}

// --- median ------------------------------------------------------------------

test('median of odd-length list is the middle value', () => {
  expect(median([3, 1, 2])).toBe(2);
});

test('median of even-length list is the mean of the two middles', () => {
  expect(median([1, 2, 3, 4])).toBe(2.5);
});

// --- staleOpacity ------------------------------------------------------------

test('staleOpacity hits the spec anchors', () => {
  expect(staleOpacity(0)).toBeCloseTo(1.0, 2);
  expect(staleOpacity(7)).toBeCloseTo(0.34 + 0.66 * Math.exp(-7 / 6), 6);
  expect(staleOpacity(1000)).toBeGreaterThanOrEqual(0.34);
});

// --- driftFlag ---------------------------------------------------------------

test('driftFlag needs >=2 priors and last > 1.5x median', () => {
  expect(driftFlag([1, 1, 3])).toBe(true); // median([1,1])=1; 3 > 1.5
  expect(driftFlag([1, 1, 1])).toBe(false);
  expect(driftFlag([1, 3])).toBe(false); // only 1 prior
  expect(driftFlag([])).toBe(false);
  expect(driftFlag([5])).toBe(false);
});

test('driftFlag boundary: exactly 1.5x median is not drift (strict >)', () => {
  // priors [2,2] median 2; 1.5*2 = 3; last 3 is NOT > 3.
  expect(driftFlag([2, 2, 3])).toBe(false);
  expect(driftFlag([2, 2, 3.01])).toBe(true);
});

// --- costBarHeights ----------------------------------------------------------

test('costBarHeights normalizes to window peak', () => {
  expect(costBarHeights([1, 2, 4])).toEqual([0.25, 0.5, 1]);
});

test('costBarHeights returns zeros for an all-zero or empty window', () => {
  expect(costBarHeights([0, 0])).toEqual([0, 0]);
  expect(costBarHeights([])).toEqual([]);
});

// --- formatAge ---------------------------------------------------------------

test('formatAge boundaries (integer floor, matching data.py int())', () => {
  expect(formatAge(0.5 / 86400)).toBe('0s'); // 0.5s floors to 0
  expect(formatAge(30 / 86400)).toBe('30s');
  expect(formatAge(59 / 86400)).toBe('59s');
  expect(formatAge(60 / 86400)).toBe('1m'); // exactly 60s steps up
  expect(formatAge(90 / 86400)).toBe('1m'); // 1.5m floors to 1
  expect(formatAge(59 / (24 * 60))).toBe('59m');
  expect(formatAge(60 / (24 * 60))).toBe('1h'); // exactly 60m steps up
  expect(formatAge(2 / 24)).toBe('2h');
  expect(formatAge(23 / 24)).toBe('23h');
  expect(formatAge(1)).toBe('1d'); // exactly 24h steps up
  expect(formatAge(21)).toBe('21d');
});

test('formatAge clamps negatives to 0s', () => {
  expect(formatAge(-5)).toBe('0s');
});

// --- latestAgeDays -----------------------------------------------------------

test('latestAgeDays is 0 for an empty window', () => {
  expect(latestAgeDays(cell({ window: [] }))).toBe(0);
});

test('latestAgeDays uses finished_at when present', () => {
  const now = new Date('2026-06-13T00:00:00Z');
  const c = cell({
    window: [rec({ finished_at: '2026-06-12T00:00:00Z' })],
  });
  expect(latestAgeDays(c, now)).toBeCloseTo(1.0, 6);
});

test('latestAgeDays falls back to started_at when finished_at is null', () => {
  const now = new Date('2026-06-13T00:00:00Z');
  const c = cell({
    window: [rec({ started_at: '20260612T000000Z', finished_at: null })],
  });
  expect(latestAgeDays(c, now)).toBeCloseTo(1.0, 6);
});

test('latestAgeDays clamps to 0 for a future timestamp', () => {
  const now = new Date('2026-06-12T00:00:00Z');
  const c = cell({
    window: [rec({ finished_at: '2026-06-13T00:00:00Z' })],
  });
  expect(latestAgeDays(c, now)).toBe(0);
});

// --- headerTally -------------------------------------------------------------

// headerTally resolves each identity's manifest cell through a callback; with no
// manifest every lookup returns null (so empty-window cells read as not_run).
const noManifest = () => null;

test('headerTally counts the latest verdict per identity and not_run for absences', () => {
  const passCell = cell({
    scenario: 'a',
    agent: 'claude',
    window: [rec({ final: 'fail' }), rec({ final: 'pass' })], // latest = pass
  });
  const failCell = cell({
    scenario: 'b',
    agent: 'claude',
    window: [rec({ final: 'fail' })],
  });
  const g = grid([passCell, failCell]);
  // 3 identities (a/b/c x claude/linux); a=pass, b=fail, c=absent(not_run).
  const identities = [
    { scenario: 'a', agent: 'claude', os: 'linux' },
    { scenario: 'b', agent: 'claude', os: 'linux' },
    { scenario: 'c', agent: 'claude', os: 'linux' },
  ];
  const t = headerTally(g, identities, 3, 1, 3, noManifest);
  expect(t.scenarios).toBe(3);
  expect(t.agents).toBe(1);
  expect(t.columns).toBe(3);
  expect(t.passed).toBe(1);
  expect(t.failed).toBe(1);
  expect(t.indeterminate).toBe(0);
  expect(t.not_run).toBe(1);
  expect(t.ineligible).toBe(0);
});

test('headerTally counts unknown/indeterminate latest as indeterminate', () => {
  const unkCell = cell({
    scenario: 'a',
    agent: 'claude',
    window: [rec({ final: 'unknown' })],
  });
  const indetCell = cell({
    scenario: 'b',
    agent: 'claude',
    window: [rec({ final: 'indeterminate' })],
  });
  const cells = [unkCell, indetCell];
  const t = headerTally(grid(cells), identitiesOf(cells), 2, 1, 2, noManifest);
  expect(t.indeterminate).toBe(2);
  expect(t.passed).toBe(0);
  expect(t.not_run).toBe(0);
});

test('headerTally treats an empty-window cell as not_run', () => {
  const runningOnly = cell({
    scenario: 'a',
    agent: 'claude',
    window: [],
    running: { run_id: 'r', phase: 'agent' },
  });
  const t = headerTally(
    grid([runningOnly]),
    identitiesOf([runningOnly]),
    1,
    1,
    1,
    noManifest,
  );
  expect(t.not_run).toBe(1);
});

test('headerTally counts ineligible identities separately from not_run', () => {
  // One empty-window cell that the manifest marks ineligible, one that is
  // eligible-but-unrun. They must NOT collapse into one not_run figure.
  const identities = [
    { scenario: 'a', agent: 'claude', os: 'linux' },
    { scenario: 'b', agent: 'claude', os: 'linux' },
  ];
  const manifestCellFor = (_s: string, _a: string, _os: string) =>
    _s === 'a'
      ? { eligible: false, skipped_reason: 'directive' as const }
      : { eligible: true, skipped_reason: null };
  const t = headerTally(grid([]), identities, 2, 1, 2, manifestCellFor);
  expect(t.ineligible).toBe(1);
  expect(t.not_run).toBe(1);
});

// --- cellView ----------------------------------------------------------------

test('cellView: empty cell renders state empty with em-dash bottom', () => {
  const v = cellView(cell({ window: [] }), 's', 'claude', 'linux', null);
  expect(v.state).toBe('empty');
  expect(v.bottom).toBe('—');
  expect(v.slots).toEqual([]);
  expect(v.opacity).toBe(1);
  expect(v.card).toBeNull();
  expect(v.cell_id).toBe('cell-s-claude-linux');
});

test('cellView: pure running cell shimmers the newest slot, phase bottom', () => {
  const c = cell({
    window: [],
    running: { run_id: 'r', phase: 'agent' },
  });
  const v = cellView(c, 's', 'claude', 'linux', null);
  expect(v.state).toBe('running');
  expect(v.bottom).toBe('agent');
  expect(v.opacity).toBe(1);
  expect(v.slots.length).toBe(5);
  expect(v.slots[4]?.kind).toBe('running');
  expect(v.slots[0]?.kind).toBe('ghost');
  expect(v.card).toBeNull();
  expect(v.drift).toBe(false);
});

test('cellView: done cell shows face_cost + stale opacity (bottom is "—")', () => {
  const now = new Date('2026-06-13T00:00:00Z');
  const c = cell({
    window: [
      rec({ cost_usd: 1, final: 'pass' }),
      rec({ cost_usd: 2, final: 'fail', finished_at: '2026-06-12T00:00:00Z' }),
    ],
  });
  const v = cellView(c, 's', 'claude', 'linux', null, now);
  expect(v.state).toBe('done');
  // bottom is '—' for done cells; the face is driven by face_time + face_cost
  expect(v.bottom).toBe('—');
  expect(v.face_cost).toBe('$2.00');
  expect(v.opacity).toBeCloseTo(staleOpacity(1.0), 6);
  // 2 real slots, ghost-padded to 5, newest rightmost.
  expect(v.slots.length).toBe(5);
  expect(v.slots[0]?.kind).toBe('ghost');
  expect(v.slots[3]?.kind).toBe('pass');
  expect(v.slots[4]?.kind).toBe('fail');
  // Cost-bar heights normalized to peak 2: [0.5, 1].
  expect(v.slots[3]?.height).toBe(0.5);
  expect(v.slots[4]?.height).toBe(1);
  expect(v.card).not.toBeNull();
  expect(v.card?.rows.length).toBe(2);
});

test('cellView: done cell with unknown cost shows face_cost "$—" (never "$0.00")', () => {
  const c = cell({ window: [rec({ cost_usd: null, final: 'pass' })] });
  const v = cellView(c, 's', 'claude', 'linux', null);
  // face_cost carries the agent-scoped cost; "$—" means cost unknown, not $0.
  expect(v.face_cost).toBe('$—');
  expect(v.bottom).toBe('—');
});

test('cellView: running on top of history shimmers newest, phase bottom', () => {
  const c = cell({
    window: [rec({ cost_usd: 1, final: 'pass' })],
    running: { run_id: 'r', phase: 'checks' },
  });
  const v = cellView(c, 's', 'claude', 'linux', null);
  expect(v.state).toBe('running');
  expect(v.bottom).toBe('checks');
  expect(v.opacity).toBe(1);
  expect(v.slots.length).toBe(5);
  expect(v.slots[4]?.kind).toBe('running');
  expect(v.drift).toBe(false);
  // Card present because there is resolved history.
  expect(v.card).not.toBeNull();
});

test('cellView: drift flag set and drift_line populated when latest spikes', () => {
  const now = new Date('2026-06-13T00:00:00Z');
  const c = cell({
    window: [
      rec({ cost_usd: 1, final: 'pass' }),
      rec({ cost_usd: 1, final: 'pass' }),
      rec({
        cost_usd: 3,
        final: 'pass',
        finished_at: '2026-06-12T00:00:00Z',
      }),
    ],
  });
  const v = cellView(c, 's', 'claude', 'linux', null, now);
  expect(v.drift).toBe(true);
  expect(v.card?.drift_line).toBe(
    '▲ latest $3.00 vs median $1.00 of prior runs',
  );
});

test('cellView: no drift_line when there is no drift', () => {
  const c = cell({
    window: [rec({ cost_usd: 1 }), rec({ cost_usd: 1 }), rec({ cost_usd: 1 })],
  });
  const v = cellView(c, 's', 'claude', 'linux', null);
  expect(v.drift).toBe(false);
  expect(v.card?.drift_line).toBeNull();
});

test('cellView: card rows carry compact timestamp + run id', () => {
  const c = cell({
    window: [
      rec({
        run_id: 's-claude-20260612T133000Z-aaaa',
        started_at: '20260612T133000Z',
        cost_usd: 1.5,
        final: 'fail',
      }),
    ],
  });
  const v = cellView(c, 's', 'claude', 'linux', null);
  const row = v.card?.rows[0];
  expect(row?.verdict).toBe('fail');
  expect(row?.cost).toBe('$1.50');
  expect(row?.timestamp).toBe('2026-06-12 13:30');
  expect(row?.run_id).toBe('s-claude-20260612T133000Z-aaaa');
});

// --- cellStatus --------------------------------------------------------------

test('pass verdict = pass', () => {
  expect(cellStatus({ window: [{ final: 'pass' }] }, null)).toBe('pass');
});

test('fail verdict = failed-grading (ran to completion)', () => {
  expect(cellStatus({ window: [{ final: 'fail' }] }, null)).toBe('failed');
});

test('indeterminate verdict = incomplete', () => {
  expect(cellStatus({ window: [{ final: 'indeterminate' }] }, null)).toBe(
    'incomplete',
  );
});

test('no runs + manifest ineligible = ineligible', () => {
  expect(
    cellStatus(
      { window: [] },
      { eligible: false, skipped_reason: 'directive' },
    ),
  ).toBe('ineligible');
});

test('no runs + eligible = not_run', () => {
  expect(
    cellStatus({ window: [] }, { eligible: true, skipped_reason: null }),
  ).toBe('not_run');
});

test('unknown verdict = incomplete', () => {
  expect(cellStatus({ window: [{ final: 'unknown' }] }, null)).toBe(
    'incomplete',
  );
});

// --- formatDuration ----------------------------------------------------------

test('formatDuration: 161000ms -> "2m41s"', () => {
  expect(formatDuration(161000)).toBe('2m41s');
});

test('formatDuration: null -> "—"', () => {
  expect(formatDuration(null)).toBe('—');
});

test('formatDuration: 9000ms -> "9s"', () => {
  expect(formatDuration(9000)).toBe('9s');
});

test('formatDuration: 3661000ms -> "1h1m"', () => {
  expect(formatDuration(3661000)).toBe('1h1m');
});

test('formatDuration: 65000ms -> "1m5s"', () => {
  expect(formatDuration(65000)).toBe('1m5s');
});

test('formatDuration: 0ms -> "0s"', () => {
  expect(formatDuration(0)).toBe('0s');
});

// --- formatTokens ------------------------------------------------------------

test('formatTokens: 48200 -> "48.2k"', () => {
  expect(formatTokens(48200)).toBe('48.2k');
});

test('formatTokens: null -> "—"', () => {
  expect(formatTokens(null)).toBe('—');
});

test('formatTokens: 999 -> "999"', () => {
  expect(formatTokens(999)).toBe('999');
});

test('formatTokens: 1_500_000 -> "1.5M"', () => {
  expect(formatTokens(1_500_000)).toBe('1.5M');
});

// --- agent-scoped cost + new RunRecord fields via scanResults ----------------

// Helper to write a run dir with a verdict
function writeRun(root: string, runId: string, verdict: unknown): void {
  const d = join(root, runId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'verdict.json'), JSON.stringify(verdict));
}

test('scanResults: cost_usd is agent-scoped when coding_agent.est_cost_usd is present', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-task6-'));
  writeRun(root, 's-claude-linux-20260618T000000Z-aaaa', {
    final: 'pass',
    economics: {
      total_est_cost_usd: 5.0,
      coding_agent: {
        est_cost_usd: 3.0,
        duration_ms: 161000,
        tokens: { total: 48200 },
      },
    },
    finished_at: '2026-06-18T00:01:00Z',
  });
  const grid = scanResults({
    resultsDir: root,
    knownAgents: ['claude'],
    manifest: null,
  });
  const r = grid.cells.get(cellKey('s', 'claude', 'linux'))?.window[0];
  // cost_usd is the AGENT cost, not the run total
  expect(r?.cost_usd).toBe(3.0);
  expect(r?.run_total_cost_usd).toBe(5.0);
  expect(r?.duration_ms).toBe(161000);
  expect(r?.total_tokens).toBe(48200);
});

test('scanResults: cost_usd falls back to run total when agent cost is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-task6-'));
  writeRun(root, 's-claude-linux-20260618T000000Z-bbbb', {
    final: 'pass',
    economics: { total_est_cost_usd: 4.5 },
    finished_at: '2026-06-18T00:01:00Z',
  });
  const grid = scanResults({
    resultsDir: root,
    knownAgents: ['claude'],
    manifest: null,
  });
  const r = grid.cells.get(cellKey('s', 'claude', 'linux'))?.window[0];
  // no agent block -> falls back to run total
  expect(r?.cost_usd).toBe(4.5);
  expect(r?.run_total_cost_usd).toBe(4.5);
  expect(r?.duration_ms).toBeNull();
  expect(r?.total_tokens).toBeNull();
});

test('scanResults: duration_ms null when coding_agent block is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-task6-'));
  writeRun(root, 's-claude-linux-20260618T000000Z-cccc', {
    final: 'pass',
    economics: { total_est_cost_usd: 1.0 },
  });
  const grid = scanResults({
    resultsDir: root,
    knownAgents: ['claude'],
    manifest: null,
  });
  const r = grid.cells.get(cellKey('s', 'claude', 'linux'))?.window[0];
  expect(r?.duration_ms).toBeNull();
  expect(r?.total_tokens).toBeNull();
});

// --- cellView: two-line face (face_time + face_cost) -------------------------

test('cellView done: face_time comes from duration_ms', () => {
  const c = cell({
    window: [rec({ duration_ms: 161000, cost_usd: 2.5, final: 'pass' })],
  });
  const v = cellView(c, 's', 'claude', 'linux', null);
  expect(v.face_time).toBe('2m41s');
  expect(v.face_cost).toBe('$2.50');
});

test('cellView done: face_time falls back to wall-clock when duration_ms is null', () => {
  const now = new Date('2026-06-18T00:05:00Z');
  const c = cell({
    window: [
      rec({
        duration_ms: null,
        started_at: '20260618T000000Z',
        finished_at: '2026-06-18T00:02:00Z',
        cost_usd: 1.0,
        final: 'pass',
      }),
    ],
  });
  const v = cellView(c, 's', 'claude', 'linux', null, now);
  // wall-clock: finished_at - started_at = 2 min = 120000ms -> "2m0s"
  expect(v.face_time).toBe('2m0s');
});

test('cellView done: face_time is "—" when no timing info', () => {
  const c = cell({
    window: [
      rec({
        duration_ms: null,
        started_at: 'bad-stamp',
        finished_at: null,
        cost_usd: 1.0,
      }),
    ],
  });
  const v = cellView(c, 's', 'claude', 'linux', null);
  expect(v.face_time).toBe('—');
});

test('cellView done: face_cost "$—" when cost_usd is null', () => {
  const c = cell({ window: [rec({ cost_usd: null })] });
  const v = cellView(c, 's', 'claude', 'linux', null);
  expect(v.face_cost).toBe('$—');
});

test('cellView running: face_time and face_cost are "—"', () => {
  const c = cell({ window: [], running: { run_id: 'r', phase: 'agent' } });
  const v = cellView(c, 's', 'claude', 'linux', null);
  expect(v.face_time).toBe('—');
  expect(v.face_cost).toBe('—');
});

test('cellView empty: face_time and face_cost are "—"', () => {
  const c = cell({ window: [] });
  const v = cellView(c, 's', 'claude', 'linux', null);
  expect(v.face_time).toBe('—');
  expect(v.face_cost).toBe('—');
});

// --- card rows carry time + tokens -------------------------------------------

test('cellView card rows carry time and tokens', () => {
  const c = cell({
    window: [
      rec({
        run_id: 's-claude-20260612T133000Z-aaaa',
        started_at: '20260612T133000Z',
        duration_ms: 9000,
        total_tokens: 48200,
        cost_usd: 1.5,
        final: 'fail',
      }),
    ],
  });
  const v = cellView(c, 's', 'claude', 'linux', null);
  const row = v.card?.rows[0];
  expect(row?.time).toBe('9s');
  expect(row?.tokens).toBe('48.2k');
  expect(row?.cost).toBe('$1.50');
});

test('cellView card rows: time "—" when no duration, tokens "—" when none', () => {
  const c = cell({
    window: [
      rec({
        duration_ms: null,
        started_at: 'bad-stamp',
        finished_at: null,
        total_tokens: null,
        cost_usd: 1.0,
        final: 'pass',
      }),
    ],
  });
  const v = cellView(c, 's', 'claude', 'linux', null);
  const row = v.card?.rows[0];
  expect(row?.time).toBe('—');
  expect(row?.tokens).toBe('—');
});

// --- CardView has run_total field --------------------------------------------

test('cellView card has run_total from newest run_total_cost_usd', () => {
  const c = cell({
    window: [rec({ cost_usd: 3.0, run_total_cost_usd: 5.0, final: 'pass' })],
  });
  const v = cellView(c, 's', 'claude', 'linux', null);
  expect(v.card?.run_total).toBe('$5.00');
});

test('cellView card run_total is "$—" when run_total_cost_usd is null', () => {
  const c = cell({
    window: [rec({ cost_usd: 3.0, run_total_cost_usd: null, final: 'pass' })],
  });
  const v = cellView(c, 's', 'claude', 'linux', null);
  expect(v.card?.run_total).toBe('$—');
});
