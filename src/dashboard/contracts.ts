import { z } from 'zod';

// Dashboard read-side contracts. The literal unions and zod schemas here are the
// single source of truth for the grid model; scan.ts, view.ts, templates.ts,
// orchestrator.ts, and server.ts all import from here.

// The four cell display states. Closed union so renders + state machines stay
// exhaustive (assertNever on the default).
export const CELL_STATES = ['empty', 'done', 'running', 'queued'] as const;
export type CellState = (typeof CELL_STATES)[number];

// The six verdict-ribbon slot kinds. `ghost` is left-padding; `running` is the
// shimmer slot for an in-flight run.
export const SLOT_KINDS = [
  'pass',
  'fail',
  'indeterminate',
  'unknown',
  'ghost',
  'running',
] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

// A resolved run's final, as the grid reads it. A verdict whose `final` is
// outside pass/fail/indeterminate (or missing) collapses to 'unknown'.
export type RunFinal = 'pass' | 'fail' | 'indeterminate' | 'unknown';

// phase.json, written by the runner at each boundary it owns (Task 2). `pid` is
// the `quorum run` process id — required, since liveness comes from it (phase
// mtime is NOT a liveness signal: a phase can last tens of minutes).
export const PhaseJsonSchema = z.object({
  phase: z.string(),
  updated_at: z.string(),
  pid: z.number(),
});
export type PhaseJson = z.infer<typeof PhaseJsonSchema>;

// The narrow read-side view of verdict.json — only the fields the grid needs.
// Every field is `.catch`-guarded so a single wrong-typed field never sinks the
// whole parse: a malformed/legacy/externally-edited verdict still reads as a
// PRESENT verdict. This preserves the authority rule — once verdict.json exists,
// phase.json is ignored for that dir — for off-happy-path files too. A
// non-string `final` degrades to undefined (the read-side then collapses it to
// 'unknown'); a non-number cost degrades to null (rendered "cost unknown", never
// $0).
export const DashboardVerdictSchema = z.object({
  final: z.string().optional().catch(undefined),
  economics: z
    .object({
      total_est_cost_usd: z.number().nullable().optional().catch(null),
    })
    .nullable()
    .optional()
    .catch(null),
  finished_at: z.string().nullable().optional().catch(null),
  scenario: z.string().optional().catch(undefined),
  coding_agent: z.string().optional().catch(undefined),
  started_at: z.string().optional().catch(undefined),
});
export type DashboardVerdict = z.infer<typeof DashboardVerdictSchema>;

// One resolved run in a cell's window. started_at is the dir-name stamp
// (YYYYMMDDTHHMMSSZ); finished_at is the verdict's ISO-8601 value or null.
export interface RunRecord {
  readonly run_id: string;
  readonly started_at: string;
  readonly final: RunFinal;
  readonly cost_usd: number | null;
  readonly finished_at: string | null;
}

// An in-flight run: a dir with phase.json + a live pid and no verdict yet.
export interface RunningRun {
  readonly run_id: string;
  readonly phase: string;
}

// One (scenario, agent) cell. `window` is oldest..newest, length <= 5. `queued`
// is ephemeral — set only by orchestrator cell_queued events, never by a scan.
export interface Cell {
  readonly scenario: string;
  readonly agent: string;
  readonly window: readonly RunRecord[];
  readonly running: RunningRun | null;
  queued: boolean;
}

// A scan snapshot. Key = `${scenario}\t${agent}` (tab is absent from names).
// Never-run cells are absent from the map (not null entries).
export interface Grid {
  readonly cells: Map<string, Cell>;
}

// The cell map key helper — the one place the composite key is formed.
export function cellKey(scenario: string, agent: string): string {
  return `${scenario}\t${agent}`;
}

// The DOM id / SSE event name for a cell. Both the `id` and `sse-swap`
// attributes equal this; cell events are addressed to it.
export function cellId(scenario: string, agent: string): string {
  return `cell-${scenario}-${agent}`;
}

// One verdict ribbon slot: a kind plus a normalized cost-bar height (0..1).
export interface SlotView {
  readonly kind: SlotKind;
  readonly height: number;
}

// One row in the detail hover card (one prior run).
export interface CardRow {
  readonly verdict: RunFinal;
  readonly cost: string;
  readonly timestamp: string;
  readonly run_id: string;
}

// The detail hover card: exact age, per-run rows (oldest..newest), and the
// drift explanation line when a drift marker is present.
export interface CardView {
  readonly age: string;
  readonly rows: readonly CardRow[];
  readonly drift_line: string | null;
}

// The render-ready cell. `slots` is always length 5 (ghost-padded left, newest
// rightmost). `bottom` is '$X.XX' | '—' | 'queued' | a phase word. `opacity` is
// 1.0 (running) | 0.5 (queued) | stale-fade (done).
export interface CellView {
  readonly cell_id: string;
  readonly scenario: string;
  readonly agent: string;
  readonly state: CellState;
  readonly slots: readonly SlotView[];
  readonly bottom: string;
  readonly drift: boolean;
  readonly opacity: number;
  readonly card: CardView | null;
  // A hover tooltip for the cell. Set for "not applicable" cells (an empty cell
  // that can never run here — the scenario's coding-agents directive excludes
  // this agent, or it's a draft) to explain why it shows "n/a" rather than "—".
  // Absent for ordinary cells.
  readonly title?: string;
}

// The grid-wide rollup for the header tally line.
export interface HeaderTally {
  readonly scenarios: number;
  readonly agents: number;
  readonly passed: number;
  readonly failed: number;
  readonly indeterminate: number;
  readonly not_run: number;
}

// An SSE message: an event name (a cell id or 'strip') and a one-line HTML body.
export interface SseMessage {
  readonly event: string;
  readonly data: string;
}
