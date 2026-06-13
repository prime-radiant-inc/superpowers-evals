import { expect, test } from 'bun:test';
import type { Cell, Grid, RunRecord } from '../src/dashboard/contracts.ts';
import { cellKey } from '../src/dashboard/contracts.ts';
import {
  cellView,
  costBarHeights,
  driftFlag,
  formatAge,
  headerTally,
  latestAgeDays,
  launchEstimate,
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
    finished_at: null,
    ...over,
  };
}

function cell(over: Partial<Cell> = {}): Cell {
  return {
    scenario: 's',
    agent: 'claude',
    window: [],
    running: null,
    queued: false,
    ...over,
  };
}

function grid(cells: Cell[]): Grid {
  const map = new Map<string, Cell>();
  for (const c of cells) {
    map.set(cellKey(c.scenario, c.agent), c);
  }
  return { cells: map };
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

// --- launchEstimate ----------------------------------------------------------

test('launchEstimate uses the cell-window mean first', () => {
  const c = cell({
    window: [rec({ cost_usd: 2 }), rec({ cost_usd: 4 })],
  });
  expect(launchEstimate(grid([c]), 's', 'claude')).toBe(3);
});

test('launchEstimate falls back to the agent grid-wide latest mean', () => {
  const other = cell({
    scenario: 'other',
    agent: 'claude',
    window: [rec({ cost_usd: 1 }), rec({ cost_usd: 5 })], // latest = 5
  });
  // Target cell (s, claude) absent -> agent mean of latest costs.
  expect(launchEstimate(grid([other]), 's', 'claude')).toBe(5);
});

test('launchEstimate falls back to the global latest mean', () => {
  const codexCell = cell({
    scenario: 'other',
    agent: 'codex',
    window: [rec({ cost_usd: 8 })], // latest = 8
  });
  // No claude cell at all -> global latest mean.
  expect(launchEstimate(grid([codexCell]), 's', 'claude')).toBe(8);
});

test('launchEstimate returns undefined when there is nothing to estimate from', () => {
  expect(launchEstimate(grid([]), 's', 'claude')).toBeUndefined();
});

test('launchEstimate ignores cells whose latest cost is null in the fallbacks', () => {
  const target = cell({
    scenario: 's',
    agent: 'claude',
    window: [rec({ cost_usd: null })], // present cell but no usable cell cost
  });
  const codexCell = cell({
    scenario: 'other',
    agent: 'codex',
    window: [rec({ cost_usd: 6 })],
  });
  // Cell window has no present costs -> fall through to global latest = 6.
  expect(launchEstimate(grid([target, codexCell]), 's', 'claude')).toBe(6);
});

// --- headerTally -------------------------------------------------------------

test('headerTally counts the latest verdict per cell and not_run for absences', () => {
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
  // 3 scenarios x 1 agent = 3 pairs; a=pass, b=fail, c=absent(not_run).
  const t = headerTally(g, ['a', 'b', 'c'], ['claude']);
  expect(t.scenarios).toBe(3);
  expect(t.agents).toBe(1);
  expect(t.passed).toBe(1);
  expect(t.failed).toBe(1);
  expect(t.indeterminate).toBe(0);
  expect(t.not_run).toBe(1);
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
  const t = headerTally(grid([unkCell, indetCell]), ['a', 'b'], ['claude']);
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
  const t = headerTally(grid([runningOnly]), ['a'], ['claude']);
  expect(t.not_run).toBe(1);
});

// --- cellView ----------------------------------------------------------------

test('cellView: empty cell renders state empty with em-dash bottom', () => {
  const v = cellView(cell({ window: [] }), 's', 'claude');
  expect(v.state).toBe('empty');
  expect(v.bottom).toBe('—');
  expect(v.slots).toEqual([]);
  expect(v.opacity).toBe(1);
  expect(v.card).toBeNull();
  expect(v.cell_id).toBe('cell-s-claude');
});

test('cellView: pure running cell shimmers the newest slot, phase bottom', () => {
  const c = cell({
    window: [],
    running: { run_id: 'r', phase: 'agent' },
  });
  const v = cellView(c, 's', 'claude');
  expect(v.state).toBe('running');
  expect(v.bottom).toBe('agent');
  expect(v.opacity).toBe(1);
  expect(v.slots.length).toBe(5);
  expect(v.slots[4]?.kind).toBe('running');
  expect(v.slots[0]?.kind).toBe('ghost');
  expect(v.card).toBeNull();
  expect(v.drift).toBe(false);
});

test('cellView: done cell shows latest cost bottom + stale opacity', () => {
  const now = new Date('2026-06-13T00:00:00Z');
  const c = cell({
    window: [
      rec({ cost_usd: 1, final: 'pass' }),
      rec({ cost_usd: 2, final: 'fail', finished_at: '2026-06-12T00:00:00Z' }),
    ],
  });
  const v = cellView(c, 's', 'claude', now);
  expect(v.state).toBe('done');
  expect(v.bottom).toBe('$2.00');
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

test('cellView: done cell with unknown cost shows "$—" (never "$0.00")', () => {
  const c = cell({ window: [rec({ cost_usd: null, final: 'pass' })] });
  const v = cellView(c, 's', 'claude');
  expect(v.bottom).toBe('$—');
});

test('cellView: running on top of history shimmers newest, phase bottom', () => {
  const c = cell({
    window: [rec({ cost_usd: 1, final: 'pass' })],
    running: { run_id: 'r', phase: 'checks' },
  });
  const v = cellView(c, 's', 'claude');
  expect(v.state).toBe('running');
  expect(v.bottom).toBe('checks');
  expect(v.opacity).toBe(1);
  expect(v.slots.length).toBe(5);
  expect(v.slots[4]?.kind).toBe('running');
  expect(v.drift).toBe(false);
  // Card present because there is resolved history.
  expect(v.card).not.toBeNull();
});

test('cellView: queued cell is dimmed, bottom reads "queued"', () => {
  const c = cell({ window: [], queued: true });
  const v = cellView(c, 's', 'claude');
  expect(v.state).toBe('queued');
  expect(v.bottom).toBe('queued');
  expect(v.opacity).toBe(0.5);
  expect(v.slots.length).toBe(5);
  expect(v.slots.every((s) => s.kind === 'ghost')).toBe(true);
});

test('cellView: queued cell with history keeps the ribbon beneath', () => {
  const c = cell({
    window: [rec({ cost_usd: 1, final: 'pass' })],
    queued: true,
  });
  const v = cellView(c, 's', 'claude');
  expect(v.state).toBe('queued');
  expect(v.bottom).toBe('queued');
  expect(v.opacity).toBe(0.5);
  expect(v.slots[4]?.kind).toBe('pass');
  expect(v.slots[0]?.kind).toBe('ghost');
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
  const v = cellView(c, 's', 'claude', now);
  expect(v.drift).toBe(true);
  expect(v.card?.drift_line).toBe(
    '▲ latest $3.00 vs median $1.00 of prior runs',
  );
});

test('cellView: no drift_line when there is no drift', () => {
  const c = cell({
    window: [rec({ cost_usd: 1 }), rec({ cost_usd: 1 }), rec({ cost_usd: 1 })],
  });
  const v = cellView(c, 's', 'claude');
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
  const v = cellView(c, 's', 'claude');
  const row = v.card?.rows[0];
  expect(row?.verdict).toBe('fail');
  expect(row?.cost).toBe('$1.50');
  expect(row?.timestamp).toBe('2026-06-12 13:30');
  expect(row?.run_id).toBe('s-claude-20260612T133000Z-aaaa');
});
