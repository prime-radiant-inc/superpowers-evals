import { expect, test } from 'bun:test';
import type { Cell, Grid, RunRecord } from '../src/dashboard/contracts.ts';
import { cellKey } from '../src/dashboard/contracts.ts';
import { diffGrids } from '../src/dashboard/view.ts';

function rec(runId: string): RunRecord {
  return {
    run_id: runId,
    started_at: '20260612T000000Z',
    final: 'pass',
    cost_usd: 1,
    run_total_cost_usd: null,
    duration_ms: null,
    total_tokens: null,
    finished_at: null,
    error_stage: null,
  };
}

// Minimal cell builder: `latest` is the newest run_id (or null = no window),
// `phase` is the running phase (or null = not running). os defaults to linux.
function makeCell(
  scenario: string,
  agent: string,
  latest: string | null,
  phase: string | null,
  os = 'linux',
): Cell {
  return {
    scenario,
    agent,
    os,
    window: latest === null ? [] : [rec(latest)],
    running: phase === null ? null : { run_id: `${latest ?? 'r'}-live`, phase },
  };
}

function grid(cells: Cell[]): Grid {
  const map = new Map<string, Cell>();
  for (const c of cells) {
    map.set(cellKey(c.scenario, c.agent, c.os), c);
  }
  return { cells: map };
}

function reasonFor(
  changes: { cell_id: string; reason: string }[],
  cellId: string,
): string | undefined {
  return changes.find((c) => c.cell_id === cellId)?.reason;
}

test('diffGrids: a new cell yields "appeared"', () => {
  const before = grid([]);
  const after = grid([makeCell('s', 'claude', 'r1', null)]);
  const changes = diffGrids(before, after);
  expect(changes).toEqual([
    { cell_id: 'cell-s-claude-linux', reason: 'appeared' },
  ]);
});

test('diffGrids: a dropped cell yields "vanished"', () => {
  const before = grid([makeCell('s', 'claude', 'r1', null)]);
  const after = grid([]);
  const changes = diffGrids(before, after);
  expect(changes).toEqual([
    { cell_id: 'cell-s-claude-linux', reason: 'vanished' },
  ]);
});

test('diffGrids: a running cell that gains a verdict yields "verdict-appeared"', () => {
  // old: running, no resolved window. new: resolved window, no running.
  const before = grid([makeCell('s', 'claude', null, 'agent')]);
  const after = grid([makeCell('s', 'claude', 'r1', null)]);
  const changes = diffGrids(before, after);
  expect(reasonFor(changes, 'cell-s-claude-linux')).toBe('verdict-appeared');
});

test('diffGrids: a phase advance on a still-running cell yields "phase-changed"', () => {
  const before = grid([makeCell('s', 'claude', null, 'setup')]);
  const after = grid([makeCell('s', 'claude', null, 'agent')]);
  const changes = diffGrids(before, after);
  expect(reasonFor(changes, 'cell-s-claude-linux')).toBe('phase-changed');
});

test('diffGrids: a newest run_id change with no running yields "verdict-appeared"', () => {
  const before = grid([makeCell('s', 'claude', 'r1', null)]);
  const after = grid([makeCell('s', 'claude', 'r2', null)]);
  const changes = diffGrids(before, after);
  expect(reasonFor(changes, 'cell-s-claude-linux')).toBe('verdict-appeared');
});

test('diffGrids: identical grids produce no changes', () => {
  const a = grid([makeCell('s', 'claude', 'r1', null)]);
  const b = grid([makeCell('s', 'claude', 'r1', null)]);
  expect(diffGrids(a, b)).toEqual([]);
});

test('diffGrids: window-length change alone is detected', () => {
  const before: Cell = {
    scenario: 's',
    agent: 'claude',
    os: 'linux',
    window: [rec('r1')],
    running: null,
  };
  const after: Cell = {
    scenario: 's',
    agent: 'claude',
    os: 'linux',
    window: [rec('r0'), rec('r1')], // same newest, longer window
    running: null,
  };
  const changes = diffGrids(grid([before]), grid([after]));
  // Signature differs by window length -> a change is emitted (reason advisory).
  expect(changes.length).toBe(1);
  expect(changes[0]?.cell_id).toBe('cell-s-claude-linux');
});

test('diffGrids: multiple changes across several cells', () => {
  const before = grid([
    makeCell('a', 'claude', 'r1', null), // unchanged
    makeCell('b', 'claude', null, 'setup'), // -> verdict-appeared
    makeCell('c', 'claude', 'r1', null), // -> vanished
  ]);
  const after = grid([
    makeCell('a', 'claude', 'r1', null),
    makeCell('b', 'claude', 'r9', null),
    makeCell('d', 'claude', 'r1', null), // -> appeared
  ]);
  const changes = diffGrids(before, after);
  expect(reasonFor(changes, 'cell-a-claude-linux')).toBeUndefined();
  expect(reasonFor(changes, 'cell-b-claude-linux')).toBe('verdict-appeared');
  expect(reasonFor(changes, 'cell-c-claude-linux')).toBe('vanished');
  expect(reasonFor(changes, 'cell-d-claude-linux')).toBe('appeared');
});
