import {
  type CardRow,
  type CardView,
  type Cell,
  type CellStatus,
  type CellView,
  cellId,
  cellKey,
  type Grid,
  type HeaderTally,
  type RunFinal,
  type RunRecord,
  type SlotView,
} from './contracts.ts';

// Pure derivations for the dashboard read side: fade/drift/cost math, the header
// tally, and the per-cell render-ready view. No IO and no wall-clock except the
// injectable `now` parameter.

const SECONDS_PER_DAY = 86_400;

// Format a duration in milliseconds as a human-readable string.
// 161000 -> '2m41s'; 65000 -> '1m5s'; 9000 -> '9s'; 3661000 -> '1h1m'; null -> '—'
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

// Format a token count compactly.
// 48200 -> '48.2k'; 999 -> '999'; 1_500_000 -> '1.5M'; null -> '—'
export function formatTokens(n: number | null): string {
  if (n === null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

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
// 0.34 floor. Running cells use a fixed 1.0 (set in cellView).
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

// Human-coarse single-unit age: `45s`, `12m`, `3h`, `21d`. Sub-minute reads in
// seconds; the unit steps up at each natural boundary. Each unit is an integer
// floor. Negative/zero clamps to `0s`.
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

// The effective duration of a run in ms. Uses rec.duration_ms when available;
// otherwise derives it from started_at (dir-stamp) and finished_at (ISO-8601).
// Returns null when neither source provides enough data.
function effectiveDuration(rec: RunRecord): number | null {
  if (rec.duration_ms !== null) return rec.duration_ms;
  const start = parseDirStamp(rec.started_at);
  if (start === null) return null;
  const end = rec.finished_at !== null ? Date.parse(rec.finished_at) : null;
  if (end === null || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
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

// A (scenario, agent, os) cell identity — the unit the tally iterates. The grid
// renders one cell per identity; the identity set is the manifest's cells when a
// manifest is present, else the observed grid cells.
export interface CellIdentity {
  readonly scenario: string;
  readonly agent: string;
  readonly os: string;
}

// A manifest cell as headerTally / cellStatus consume it: just eligibility +
// the skip reason. Kept structural so callers can pass the harness manifest cell
// or a test stub.
export interface ManifestCellLike {
  readonly eligible: boolean;
  readonly skipped_reason: 'directive' | 'draft' | 'tier' | null;
}

// Grid-wide rollup over the 5-state taxonomy (cellStatus) of each identity.
// `scenarioCount` / `agentCount` are the header's "N scenarios × M agents"
// figures; `columnCount` is the flattened (agent, os) sub-column count.
// `manifestCellFor` resolves each identity's manifest cell so empty-window cells
// split into `not_run` (eligible/unknown) vs `ineligible` (manifest eligible:false).
export function headerTally(
  grid: Grid,
  identities: readonly CellIdentity[],
  scenarioCount: number,
  agentCount: number,
  columnCount: number,
  manifestCellFor: (
    scenario: string,
    agent: string,
    os: string,
  ) => ManifestCellLike | null,
): HeaderTally {
  let passed = 0;
  let failed = 0;
  let indeterminate = 0;
  let notRun = 0;
  let ineligible = 0;
  for (const id of identities) {
    const cell =
      grid.cells.get(cellKey(id.scenario, id.agent, id.os)) ??
      ({
        scenario: id.scenario,
        agent: id.agent,
        os: id.os,
        window: [],
        running: null,
      } as Cell);
    const mc = manifestCellFor(id.scenario, id.agent, id.os);
    switch (cellStatus(cell, mc)) {
      case 'pass':
        passed += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'incomplete':
        indeterminate += 1;
        break;
      case 'ineligible':
        ineligible += 1;
        break;
      default:
        notRun += 1;
        break;
    }
  }
  return {
    scenarios: scenarioCount,
    agents: agentCount,
    columns: columnCount,
    passed,
    failed,
    indeterminate,
    not_run: notRun,
    ineligible,
  };
}

// A cost figure, or "$—" when the run couldn't be priced (economics null/
// partial). NOT "$0.00" — that would falsely read as a free run (build spec:
// "never as $0"); "$—" reads as a cost field with an unknown value.
function rowCost(costUsd: number | null): string {
  return costUsd !== null ? `$${costUsd.toFixed(2)}` : '$—';
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
    time: formatDuration(effectiveDuration(r)),
    tokens: formatTokens(r.total_tokens),
    timestamp: rowTimestamp(r),
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
  const newest = cell.window[cell.window.length - 1] as RunRecord;
  const runTotal = rowCost(newest.run_total_cost_usd);
  return { age, rows, drift_line: driftLine, run_total: runTotal };
}

// Map a cell + manifest cell to one of the 5 outcome statuses. Exported for
// direct unit testing — the type is kept loose so test objects satisfy it.
export function cellStatus(
  cell: { readonly window: readonly { readonly final: RunFinal }[] },
  manifestCell: {
    readonly eligible: boolean;
    readonly skipped_reason: 'directive' | 'draft' | 'tier' | null;
  } | null,
): CellStatus {
  const newest = cell.window[cell.window.length - 1];
  if (newest !== undefined) {
    if (newest.final === 'pass') return 'pass';
    if (newest.final === 'fail') return 'failed';
    if (newest.final === 'indeterminate') return 'incomplete';
    // 'unknown' (malformed/legacy verdict): treat as incomplete (it ran but we can't grade it)
    return 'incomplete';
  }
  // empty window:
  if (manifestCell !== null && manifestCell.eligible === false)
    return 'ineligible';
  return 'not_run';
}

// The error stage of the newest run, or null. Only relevant when status is
// 'incomplete', but computed for all cells (returns null when no runs or no stage).
function newestErrorStage(cell: Cell): string | null {
  const newest = cell.window[cell.window.length - 1];
  return newest?.error_stage ?? null;
}

// Resolve a Cell into a render-ready view. Always 5 slots, ghost-padded on the
// left so the newest run is rightmost. Opacity: running -> 1.0, else the stale
// fade.
export function cellView(
  cell: Cell,
  scenario: string,
  agent: string,
  os: string,
  manifestCell: {
    readonly eligible: boolean;
    readonly skipped_reason: 'directive' | 'draft' | 'tier' | null;
  } | null,
  now?: Date,
): CellView {
  const id = cellId(scenario, agent, os);

  if (cell.running !== null && cell.window.length === 0) {
    // Pure running cell (no resolved history yet): shimmer the newest slot.
    const slots: SlotView[] = ghostSlots(4);
    slots.push({ kind: 'running', height: 0 });
    return {
      cell_id: id,
      scenario,
      agent,
      os,
      state: 'running',
      status: cellStatus(cell, manifestCell),
      error_stage: null,
      slots,
      bottom: cell.running.phase,
      drift: false,
      opacity: 1.0,
      card: null,
      face_time: '—',
      face_cost: '—',
    };
  }

  if (cell.window.length === 0) {
    return {
      cell_id: id,
      scenario,
      agent,
      os,
      state: 'empty',
      status: cellStatus(cell, manifestCell),
      error_stage: null,
      slots: [],
      bottom: '—',
      drift: false,
      opacity: 1.0,
      card: null,
      face_time: '—',
      face_cost: '—',
    };
  }

  let slots = paddedSlots(cell.window);
  let bottom: string;
  let drift: boolean;
  let face_time: string;
  let face_cost: string;
  if (cell.running !== null) {
    // In-flight on top of history: newest slot shimmers, no latest $ yet.
    slots = [...slots.slice(1), { kind: 'running', height: 0 }];
    bottom = cell.running.phase;
    drift = false;
    face_time = '—';
    face_cost = '—';
  } else {
    const latest = cell.window[cell.window.length - 1] as RunRecord;
    bottom = '—';
    drift = driftFlag(cellCosts(cell));
    face_time = formatDuration(effectiveDuration(latest));
    face_cost = rowCost(latest.cost_usd);
  }
  const state = cell.running !== null ? 'running' : 'done';
  const opacity =
    cell.running !== null ? 1.0 : staleOpacity(latestAgeDays(cell, now));
  return {
    cell_id: id,
    scenario,
    agent,
    os,
    state,
    status: cellStatus(cell, manifestCell),
    error_stage: newestErrorStage(cell),
    slots,
    bottom,
    drift,
    opacity,
    card: cardView(cell, drift, now),
    face_time,
    face_cost,
  };
}

function ghostSlots(n: number): SlotView[] {
  const out: SlotView[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ kind: 'ghost', height: 0 });
  }
  return out;
}

// Real slots for the window, ghost-padded on the left to length 5. Cost-bar
// heights normalize to the window peak (missing costs count as 0).
function paddedSlots(window: readonly RunRecord[]): SlotView[] {
  const costsAll = window.map((r) => r.cost_usd ?? 0);
  const heights = costBarHeights(costsAll);
  const real: SlotView[] = window.map((r, i) => ({
    kind: r.final,
    height: heights[i] as number,
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
// state changed. Pure: no IO, no clock.
export function diffGrids(oldGrid: Grid, newGrid: Grid): GridChange[] {
  const changes: GridChange[] = [];
  const oldCells = oldGrid.cells;
  const newCells = newGrid.cells;

  for (const [key, newCell] of newCells) {
    const id = cellId(newCell.scenario, newCell.agent, newCell.os);
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
        cell_id: cellId(oldCell.scenario, oldCell.agent, oldCell.os),
        reason: 'vanished',
      });
    }
  }
  return changes;
}
