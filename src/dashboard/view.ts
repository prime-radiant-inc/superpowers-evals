import {
  type CardRow,
  type CardView,
  type Cell,
  type CellView,
  cellId,
  cellKey,
  type Grid,
  type HeaderTally,
  type RunRecord,
  type SlotView,
} from './contracts.ts';

// Pure derivations for the dashboard read side: fade/drift/cost math, the header
// tally, and the per-cell render-ready view. No IO and no wall-clock except the
// injectable `now` parameter — every formula is ported verbatim from
// .worktrees/dashboard-ref/quorum/dashboard/data.py so the ▲, the bars, and the
// fade stay byte-identical to the Python.

const SECONDS_PER_DAY = 86_400;

// Median of a non-empty list. Even length averages the two middles.
export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    // n is odd, so mid is in range.
    return s[mid] as number;
  }
  const lo = s[mid - 1] as number;
  const hi = s[mid] as number;
  return (lo + hi) / 2;
}

// Continuous stale fade: fresh ~1.0, ~3d ~0.74, a week ~0.54, multi-week -> the
// 0.34 floor. Queued cells use a fixed 0.5 and running cells 1.0 (set in cellView).
export function staleOpacity(ageDays: number): number {
  return 0.34 + 0.66 * Math.exp(-ageDays / 6.0);
}

// True when the latest cost > 1.5x the median of the prior costs, with >=2
// priors. `costs` is oldest..newest; the last element is the latest run. With
// fewer than 2 priors there is no median to beat, so 0- and 1-prior windows
// return false here (the >=2 gate is the only one needed).
export function driftFlag(costs: readonly number[]): boolean {
  if (costs.length < 1) {
    return false;
  }
  const latest = costs[costs.length - 1] as number;
  const priors = costs.slice(0, -1);
  if (priors.length < 2) {
    return false;
  }
  return latest > 1.5 * median(priors);
}

// Per-cell normalization to the window peak; each entry is a fraction in [0, 1].
// An empty or all-zero window returns zeros.
export function costBarHeights(costs: readonly number[]): number[] {
  let peak = 0;
  for (const c of costs) {
    if (c > peak) {
      peak = c;
    }
  }
  if (peak <= 0) {
    return costs.map(() => 0);
  }
  return costs.map((c) => c / peak);
}

// Compact wall-clock label from a millisecond span. `<60s -> "42s"`; `<60m ->
// "5m"` (exact minute) or `"1m17s"` (keeps the seconds part, so a 77s run is not
// a lossy "1m"); `>=60m -> "1h19m"` (drops seconds at the hour scale, minutes
// zero-padded). Parallels rowCost: the cell-bottom analogue of "$X.XX".
export function formatWall(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const secs = totalSeconds % 60;
    return secs === 0 ? `${totalMinutes}m` : `${totalMinutes}m${secs}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}h${mins.toString().padStart(2, '0')}m`;
}

// Run wall-clock in ms, by a two-step cascade (both express the same thing — how
// long the run took — so the metric stays consistent across cells):
//   1. PRECISE: dir-stamp started_at -> verdict finished_at. Survives the no-cost
//      case (timing is independent of obol pricing), but the top-level timestamps
//      are a recent schema addition (~18% of verdicts).
//   2. FALLBACK: economics.gauntlet.duration_ms — the Gauntlet-Agent's span. It
//      UNDER-reports end-to-end by the quorum-side setup before the gauntlet runs
//      and the capture/post-checks after it: ≈1s on warm light-setup runs, but up
//      to tens of seconds on cold venv/plugin-provision runs. Still an honest
//      coarse signal, and populated for ~71% of verdicts (vs ~18% for finished_at)
//      — far better than "—" for the bulk of historical runs.
// null only when neither is available (e.g. an errored run with no timing).
export function runWallMs(rec: RunRecord): number | null {
  const start = parseDirStamp(rec.started_at);
  if (rec.finished_at !== null && start !== null) {
    const end = Date.parse(rec.finished_at);
    if (!Number.isNaN(end) && end >= start) {
      return end - start;
    }
  }
  if (rec.gauntlet_duration_ms !== null && rec.gauntlet_duration_ms >= 0) {
    return rec.gauntlet_duration_ms;
  }
  return null;
}

// Human-coarse single-unit age: `45s`, `12m`, `3h`, `21d`. Sub-minute reads in
// seconds; the unit steps up at each natural boundary. Each unit is an integer
// floor (data.py `int()`). Negative/zero clamps to `0s`.
export function formatAge(ageDays: number): string {
  const seconds = Math.max(0, ageDays) * SECONDS_PER_DAY;
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`;
  }
  const hours = minutes / 60;
  if (hours < 24) {
    return `${Math.floor(hours)}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

// Age in days of the cell's latest run, from finished_at (preferred) or the
// dir-name started_at stamp as a fallback. `now` is injectable for tests.
export function latestAgeDays(cell: Cell, now?: Date): number {
  const reference = now ?? new Date();
  if (cell.window.length === 0) {
    return 0;
  }
  const latest = cell.window[cell.window.length - 1] as RunRecord;
  if (latest.finished_at !== null) {
    const when = Date.parse(latest.finished_at);
    if (!Number.isNaN(when)) {
      return Math.max(0, (reference.getTime() - when) / 1000 / SECONDS_PER_DAY);
    }
  }
  const fromStamp = parseDirStamp(latest.started_at);
  if (fromStamp !== null) {
    return Math.max(
      0,
      (reference.getTime() - fromStamp) / 1000 / SECONDS_PER_DAY,
    );
  }
  return 0;
}

// Parse the dir-name timestamp `YYYYMMDDTHHMMSSZ` to epoch millis, or null. The
// stamp is always UTC (the trailing Z), so it maps to an ISO string for Date.
function parseDirStamp(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (m === null) {
    return null;
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function cellCosts(cell: Cell): number[] {
  const out: number[] = [];
  for (const r of cell.window) {
    if (r.cost_usd !== null) {
      out.push(r.cost_usd);
    }
  }
  return out;
}

// Launch-cost estimate, cascading: the target cell's window mean -> that agent's
// grid-wide latest-cost mean -> the global latest-cost mean -> undefined (the
// chip shows `~$—`).
export function launchEstimate(
  grid: Grid,
  scenario: string,
  agent: string,
): number | undefined {
  const cell = grid.cells.get(cellKey(scenario, agent));
  if (cell !== undefined) {
    const costs = cellCosts(cell);
    if (costs.length > 0) {
      return costs.reduce((a, b) => a + b, 0) / costs.length;
    }
  }
  const agentCosts: number[] = [];
  const globalCosts: number[] = [];
  for (const c of grid.cells.values()) {
    if (c.window.length === 0) {
      continue;
    }
    const latest = c.window[c.window.length - 1] as RunRecord;
    if (latest.cost_usd === null) {
      continue;
    }
    globalCosts.push(latest.cost_usd);
    if (c.agent === agent) {
      agentCosts.push(latest.cost_usd);
    }
  }
  if (agentCosts.length > 0) {
    return agentCosts.reduce((a, b) => a + b, 0) / agentCosts.length;
  }
  if (globalCosts.length > 0) {
    return globalCosts.reduce((a, b) => a + b, 0) / globalCosts.length;
  }
  return undefined;
}

// Grid-wide rollup over the latest verdict of each cell. `not_run` is every
// (scenario, agent) pair with no window (absent or running-only cells).
export function headerTally(
  grid: Grid,
  scenarios: readonly string[],
  agents: readonly string[],
): HeaderTally {
  let passed = 0;
  let failed = 0;
  let indeterminate = 0;
  let notRun = 0;
  for (const scenario of scenarios) {
    for (const agent of agents) {
      const cell = grid.cells.get(cellKey(scenario, agent));
      if (cell === undefined || cell.window.length === 0) {
        notRun += 1;
        continue;
      }
      const latest = (cell.window[cell.window.length - 1] as RunRecord).final;
      if (latest === 'pass') {
        passed += 1;
      } else if (latest === 'fail') {
        failed += 1;
      } else {
        indeterminate += 1;
      }
    }
  }
  return {
    scenarios: scenarios.length,
    agents: agents.length,
    passed,
    failed,
    indeterminate,
    not_run: notRun,
  };
}

// A cost figure, or "$—" when the run couldn't be priced (economics null/
// partial). NOT "$0.00" — that would falsely read as a free run (build spec:
// "never as $0"); "$—" reads as a cost field with an unknown value.
function rowCost(costUsd: number | null): string {
  return costUsd !== null ? `$${costUsd.toFixed(2)}` : '$—';
}

// A wall-clock figure for a run, or "—" when its span can't be computed. The
// walltime analogue of rowCost's "$—": "—" reads as an unknown duration, never a
// misleading "0s".
function rowWall(rec: RunRecord): string {
  const ms = runWallMs(rec);
  return ms !== null ? formatWall(ms) : '—';
}

// The short run nonce — the final `-`-delimited segment of the run id
// (`<scenario>-<agent>-<stamp>-<nonce>`), e.g. `1e55`. Shown in the card row in
// place of the full quad; the full id rides along as a copy-on-hover title.
function runNonce(runId: string): string {
  const i = runId.lastIndexOf('-');
  return i === -1 ? runId : runId.slice(i + 1);
}

// Compact card-row timestamp. Prefers the dir-name started_at (always present)
// rendered as `YYYY-MM-DD HH:MM`; falls back to finished_at when the stamp is
// unparseable.
function rowTimestamp(rec: RunRecord): string {
  const ms = parseDirStamp(rec.started_at);
  if (ms !== null) {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = d.getUTCDate().toString().padStart(2, '0');
    const hh = d.getUTCHours().toString().padStart(2, '0');
    const min = d.getUTCMinutes().toString().padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }
  return rec.finished_at ?? rec.started_at;
}

// Fixed dim for a queued cell (not the stale-fade curve — a queued cell hasn't
// run, so its "age" is meaningless).
const QUEUED_OPACITY = 0.5;

function cardView(
  cell: Cell,
  showDrift: boolean,
  now: Date | undefined,
): CardView | null {
  if (cell.window.length === 0) {
    return null;
  }
  const rows: CardRow[] = cell.window.map((r) => ({
    verdict: r.final,
    cost: rowCost(r.cost_usd),
    wall: rowWall(r),
    timestamp: rowTimestamp(r),
    nonce: runNonce(r.run_id),
    run_id: r.run_id,
  }));
  const age = formatAge(latestAgeDays(cell, now));
  let driftLine: string | null = null;
  if (showDrift) {
    const presentCosts = cellCosts(cell);
    const latest = presentCosts[presentCosts.length - 1] as number;
    const med = median(presentCosts.slice(0, -1));
    driftLine = `▲ latest $${latest.toFixed(2)} vs median $${med.toFixed(2)} of prior runs`;
  }
  return { age, rows, drift_line: driftLine };
}

// Resolve a Cell into a render-ready view. Always 5 slots, ghost-padded on the
// left so the newest run is rightmost. Opacity: running -> 1.0, queued -> 0.5,
// else the stale fade. Verbatim port of data.py `cell_view`.
export function cellView(
  cell: Cell,
  scenario: string,
  agent: string,
  now?: Date,
): CellView {
  const id = cellId(scenario, agent);

  if (cell.queued) {
    // Scheduler queued the cell; child not started (no phase yet). Dimmed,
    // bottom reads "queued". Prior history (if any) still shows as the ribbon.
    let slots: SlotView[];
    if (cell.window.length > 0) {
      slots = paddedSlots(cell.window);
    } else {
      slots = ghostSlots(5);
    }
    return {
      cell_id: id,
      scenario,
      agent,
      state: 'queued',
      slots,
      bottom: 'queued',
      bottomWall: 'queued',
      drift: false,
      opacity: QUEUED_OPACITY,
      card: cardView(cell, false, now),
    };
  }

  if (cell.running !== null && cell.window.length === 0) {
    // Pure running cell (no resolved history yet): shimmer the newest slot.
    const slots: SlotView[] = ghostSlots(4);
    slots.push({ kind: 'running', height: 0, wallHeight: 0 });
    return {
      cell_id: id,
      scenario,
      agent,
      state: 'running',
      slots,
      bottom: cell.running.phase,
      bottomWall: cell.running.phase,
      drift: false,
      opacity: 1.0,
      card: null,
    };
  }

  if (cell.window.length === 0) {
    return {
      cell_id: id,
      scenario,
      agent,
      state: 'empty',
      slots: [],
      bottom: '—',
      bottomWall: '—',
      drift: false,
      opacity: 1.0,
      card: null,
    };
  }

  let slots = paddedSlots(cell.window);
  let bottom: string;
  let bottomWall: string;
  let drift: boolean;
  if (cell.running !== null) {
    // In-flight on top of history: newest slot shimmers, no latest $/wall yet.
    slots = [...slots.slice(1), { kind: 'running', height: 0, wallHeight: 0 }];
    bottom = cell.running.phase;
    bottomWall = cell.running.phase;
    drift = false;
  } else {
    const latest = cell.window[cell.window.length - 1] as RunRecord;
    bottom = latest.cost_usd !== null ? `$${latest.cost_usd.toFixed(2)}` : '$—';
    bottomWall = rowWall(latest);
    drift = driftFlag(cellCosts(cell));
  }
  const state = cell.running !== null ? 'running' : 'done';
  const opacity =
    cell.running !== null ? 1.0 : staleOpacity(latestAgeDays(cell, now));
  return {
    cell_id: id,
    scenario,
    agent,
    state,
    slots,
    bottom,
    bottomWall,
    drift,
    opacity,
    card: cardView(cell, drift, now),
  };
}

function ghostSlots(n: number): SlotView[] {
  const out: SlotView[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ kind: 'ghost', height: 0, wallHeight: 0 });
  }
  return out;
}

// Real slots for the window, ghost-padded on the left to length 5. Each slot
// carries BOTH a cost-bar height and a wall-bar height, each normalized to its
// own window peak (missing cost / uncomputable wall count as 0). The active
// metric's bar is selected in CSS, so a cell never re-fetches to switch.
function paddedSlots(window: readonly RunRecord[]): SlotView[] {
  const costHeights = costBarHeights(window.map((r) => r.cost_usd ?? 0));
  const wallHeights = costBarHeights(window.map((r) => runWallMs(r) ?? 0));
  const real: SlotView[] = window.map((r, i) => ({
    kind: r.final,
    height: costHeights[i] as number,
    wallHeight: wallHeights[i] as number,
  }));
  const pad = 5 - real.length;
  return [...ghostSlots(pad), ...real];
}

// --- diffGrids ---------------------------------------------------------------

// A comparable fingerprint of a cell's displayed state: (newest run_id, running
// phase, is-running, window length). Two scans whose signatures match for a key
// produce no diff entry for that cell.
interface CellSignature {
  readonly latest: string | null;
  readonly runningPhase: string | null;
  readonly isRunning: boolean;
  readonly windowLength: number;
}

function newestId(cell: Cell): string | null {
  return cell.window.length > 0
    ? (cell.window[cell.window.length - 1] as RunRecord).run_id
    : null;
}

function cellSignature(cell: Cell): CellSignature {
  return {
    latest: newestId(cell),
    runningPhase: cell.running !== null ? cell.running.phase : null,
    isRunning: cell.running !== null,
    windowLength: cell.window.length,
  };
}

function signaturesEqual(a: CellSignature, b: CellSignature): boolean {
  return (
    a.latest === b.latest &&
    a.runningPhase === b.runningPhase &&
    a.isRunning === b.isRunning &&
    a.windowLength === b.windowLength
  );
}

// One changed cell in a scan diff. `reason` is advisory only — a coarse hint
// for logging. Consumers MUST treat every returned cell_id as "re-render this
// cell" and MUST NOT branch on the reason (the cell partial is a full-state
// swap, so the exact reason never matters to correctness).
export interface GridChange {
  readonly cell_id: string;
  readonly reason:
    | 'appeared'
    | 'vanished'
    | 'verdict-appeared'
    | 'phase-changed';
}

// Compare two scan snapshots, returning a change for every cell whose displayed
// state changed. Pure: no IO, no clock. Port of data.py `diff_grids`.
export function diffGrids(oldGrid: Grid, newGrid: Grid): GridChange[] {
  const changes: GridChange[] = [];
  const oldCells = oldGrid.cells;
  const newCells = newGrid.cells;

  for (const [key, newCell] of newCells) {
    const id = cellId(newCell.scenario, newCell.agent);
    const oldCell = oldCells.get(key);
    if (oldCell === undefined) {
      changes.push({ cell_id: id, reason: 'appeared' });
      continue;
    }
    if (signaturesEqual(cellSignature(oldCell), cellSignature(newCell))) {
      continue;
    }
    const wasRunningUnresolved =
      oldCell.running !== null && newestId(oldCell) === null;
    if (wasRunningUnresolved && newestId(newCell) !== null) {
      changes.push({ cell_id: id, reason: 'verdict-appeared' });
    } else if (
      oldCell.running !== null &&
      newCell.running !== null &&
      oldCell.running.phase !== newCell.running.phase
    ) {
      changes.push({ cell_id: id, reason: 'phase-changed' });
    } else if (newestId(oldCell) !== newestId(newCell)) {
      changes.push({ cell_id: id, reason: 'verdict-appeared' });
    } else {
      changes.push({ cell_id: id, reason: 'phase-changed' });
    }
  }

  for (const [key, oldCell] of oldCells) {
    if (!newCells.has(key)) {
      changes.push({
        cell_id: cellId(oldCell.scenario, oldCell.agent),
        reason: 'vanished',
      });
    }
  }
  return changes;
}
