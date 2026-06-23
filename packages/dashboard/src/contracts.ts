import { z } from 'zod';

// Dashboard read-side contracts. The literal unions and zod schemas here are the
// single source of truth for the grid model; scan.ts, view.ts, templates.ts,
// and server.ts all import from here.

// The three cell display states. Closed union so renders + state machines stay
// exhaustive (assertNever on the default).
export const CELL_STATES = ['empty', 'done', 'running'] as const;
export type CellState = (typeof CELL_STATES)[number];

// The five outcome statuses for a (scenario, agent, credential, os) cell.
// Orthogonal to `state` (empty/done/running), which drives slot/shimmer
// rendering.
export const CELL_STATUSES = [
  'pass',
  'failed',
  'incomplete',
  'not_run',
  'ineligible',
] as const;
export type CellStatus = (typeof CELL_STATUSES)[number];

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

// phase.json, written by the runner at each boundary it owns. `pid` is the
// `quorum run` process id — required, since liveness comes from it (phase mtime
// is NOT a liveness signal: a phase can last tens of minutes). `identity` is the
// run's self-identity, so the dashboard can place an in-flight run in its cell
// without parsing the run-dir name. It is optional (a pre-identity phase.json
// still parses); an in-flight run with no identity cannot be placed and is
// skipped by the scanner.
export const PhaseIdentitySchema = z.object({
  scenario: z.string(),
  agent: z.string(),
  credential: z.string(),
  os: z.string(),
});
export type PhaseIdentity = z.infer<typeof PhaseIdentitySchema>;

export const PhaseJsonSchema = z.object({
  phase: z.string(),
  updated_at: z.string(),
  pid: z.number(),
  identity: PhaseIdentitySchema.optional(),
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
      coding_agent: z
        .object({
          est_cost_usd: z.number().nullable().optional().catch(null),
          duration_ms: z.number().nullable().optional().catch(null),
          tokens: z
            .object({ total: z.number().nullable().optional().catch(null) })
            .nullable()
            .optional()
            .catch(null),
        })
        .nullable()
        .optional()
        .catch(null),
    })
    .nullable()
    .optional()
    .catch(null),
  finished_at: z.string().nullable().optional().catch(null),
  scenario: z.string().optional().catch(undefined),
  coding_agent: z.string().optional().catch(undefined),
  credential: z.string().optional().catch(undefined),
  os: z.string().optional().catch(undefined),
  started_at: z.string().optional().catch(undefined),
  error: z
    .object({ stage: z.string().optional().catch(undefined) })
    .nullable()
    .optional()
    .catch(null),
});
export type DashboardVerdict = z.infer<typeof DashboardVerdictSchema>;

// One resolved run in a cell's window. started_at is the dir-name stamp
// (YYYYMMDDTHHMMSSZ); finished_at is the verdict's ISO-8601 value or null.
// cost_usd is agent-scoped (economics.coding_agent.est_cost_usd), falling back
// to economics.total_est_cost_usd when the agent block is absent. Use
// run_total_cost_usd for the run-total (gauntlet + agent combined).
export interface RunRecord {
  readonly run_id: string;
  readonly started_at: string;
  readonly final: RunFinal;
  /** Agent-scoped cost (falls back to run total when agent cost absent). */
  readonly cost_usd: number | null;
  /** Run-total cost (gauntlet QA + coding agent). For labeled display only. */
  readonly run_total_cost_usd: number | null;
  /** Coding-agent wall-clock duration in ms, or null when not reported. */
  readonly duration_ms: number | null;
  /** Total tokens consumed by the coding agent, or null when not reported. */
  readonly total_tokens: number | null;
  readonly finished_at: string | null;
  readonly error_stage: string | null;
}

// An in-flight run: a dir with phase.json + a live pid and no verdict yet.
export interface RunningRun {
  readonly run_id: string;
  readonly phase: string;
}

// One (scenario, agent, credential, os) cell. `window` is oldest..newest,
// length <= 5.
export interface Cell {
  readonly scenario: string;
  readonly agent: string;
  readonly credential: string;
  readonly os: string;
  readonly window: readonly RunRecord[];
  readonly running: RunningRun | null;
}

// A scan snapshot. Key = `${scenario}\t${agent}\t${credential}\t${os}` (tab is
// absent from names). Never-run cells are absent from the map (not null entries).
export interface Grid {
  readonly cells: Map<string, Cell>;
}

// The cell map key helper — the one place the composite key is formed. Tab is
// absent from every identity segment, so it is a safe composite separator.
export function cellKey(
  scenario: string,
  agent: string,
  credential: string,
  os: string,
): string {
  return `${scenario}\t${agent}\t${credential}\t${os}`;
}

// The DOM id / SSE event name for a cell. Both the `id` and `sse-swap`
// attributes equal this; cell events are addressed to it.
export function cellId(
  scenario: string,
  agent: string,
  credential: string,
  os: string,
): string {
  return `cell-${scenario}-${agent}-${credential}-${os}`;
}

// One verdict ribbon slot: a kind plus a normalized cost-bar height (0..1).
export interface SlotView {
  readonly kind: SlotKind;
  readonly height: number;
}

// One row in the detail hover card (one prior run).
export interface CardRow {
  readonly verdict: RunFinal;
  /** Agent-scoped cost for this run ('$X.XX' or '$—'). */
  readonly cost: string;
  /** Formatted duration ('2m41s', '—' when unavailable). */
  readonly time: string;
  /** Formatted token count ('48.2k', '—' when unavailable). */
  readonly tokens: string;
  readonly timestamp: string;
  readonly run_id: string;
}

// The detail hover card: exact age, per-run rows (oldest..newest), the
// drift explanation line when a drift marker is present, and the labeled
// run-total cost of the newest run (gauntlet + agent; distinct from the
// agent-scoped per-run cost in CardRow.cost).
export interface CardView {
  readonly age: string;
  readonly rows: readonly CardRow[];
  readonly drift_line: string | null;
  /** Run-total cost of the newest run ('$X.XX' or '$—'). Labeled in the template. */
  readonly run_total: string;
}

// The render-ready cell. `slots` is always length 5 (ghost-padded left, newest
// rightmost). `bottom` is a phase word (running) | '—' (empty). `opacity` is
// 1.0 (running) | stale-fade (done).
// For done cells, the two-line face is driven by `face_time` (time headline,
// line 1) and `face_cost` (agent-scoped cost, line 2).
export interface CellView {
  readonly cell_id: string;
  readonly scenario: string;
  readonly agent: string;
  readonly credential: string;
  readonly os: string;
  readonly state: CellState;
  readonly slots: readonly SlotView[];
  /** Phase word for running cells; '—' for empty cells. Not used for done cells. */
  readonly bottom: string;
  readonly drift: boolean;
  readonly opacity: number;
  readonly card: CardView | null;
  // The outcome status for this cell: pass/failed/incomplete/not_run/ineligible.
  // Orthogonal to `state` (empty/done/running). Set for all cells.
  readonly status: CellStatus;
  // The error stage from the newest run's verdict, when status is 'incomplete'.
  // null for all other statuses.
  readonly error_stage: string | null;
  /** Two-line face: time headline (line 1). '—' for non-done cells. */
  readonly face_time: string;
  /** Two-line face: agent-scoped cost (line 2). '—' for non-done cells. */
  readonly face_cost: string;
  // A hover tooltip for the cell. Set for "not applicable" cells (an empty cell
  // that can never run here — the scenario's coding-agents directive excludes
  // this agent, or it's a draft) to explain why it shows "n/a" rather than "—".
  // Absent for ordinary cells.
  readonly title?: string;
}

// One (credential, os) sub-column under an agent group. One body cell renders
// per sub-column.
export interface AgentSubColumn {
  readonly credential: string;
  readonly os: string;
}

// One agent column group in the two-tier header: an agent and the sorted list
// of (credential, os) sub-columns it occupies (one body cell per sub-column).
export interface AgentColumns {
  readonly agent: string;
  readonly subcols: readonly AgentSubColumn[];
}

// The grid-wide rollup for the header tally line. `columns` is the flattened
// (agent, os) sub-column count (the grid's true width). `ineligible` is counted
// separately from `not_run` so excluded cells don't inflate the not-run figure.
export interface HeaderTally {
  readonly scenarios: number;
  readonly agents: number;
  readonly columns: number;
  readonly passed: number;
  readonly failed: number;
  readonly indeterminate: number;
  readonly not_run: number;
  readonly ineligible: number;
}

// An SSE message: an event name (a cell id or 'strip') and a one-line HTML body.
export interface SseMessage {
  readonly event: string;
  readonly data: string;
}
