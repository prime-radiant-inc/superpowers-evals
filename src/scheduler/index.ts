import type { ChildResult, MatrixEntry } from '../contracts/batch.ts';
import type { Clock } from './clock.ts';

// The shared default global slot-pool size ("up to this many of anything"). The
// CLI run-all option default and the dashboard both source this one constant.
export const DEFAULT_JOBS = 8;

// The quorum scheduler. One central dispatcher owning ONE global slot pool of
// size `jobs`, enforcing a TRUE global cap. Per-harness rules (cap, spacing,
// rate-limit latch) gate which queued cells may take a slot, but a cell waiting
// on its harness's cap, spacing, or latch NEVER occupies a global slot — slots
// are consumed only by running work. A single pool (rather than nested per-lane
// pools) is what makes the global cap exact: nested pools let lane work bypass
// the main pool's accounting.
//
// The scheduler is PURE of file I/O. It emits a stream of events; final/cost
// derivation (reading verdict.json) is the consumer's job, done in onEvent off
// the run_id the cell_finished event carries. The event contract is general
// enough to serve both consumers — run-all's Rich readout and the dashboard SSE
// bus (events carry idx/entry/run_id/elapsed_s/skipped_reason; requestStop
// drives /stop).

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// Why a cell was skipped without running. Caller-side directive/draft/tier skips
// never reach the scheduler; it only ever emits these two runtime reasons.
export type SkippedReason = 'rate-limited' | 'stopped';

// The event stream the dispatcher emits. A discriminated union on `kind`.
// Per-cell lifecycle: queued -> started -> finished, or queued -> skipped.
// `idx` is the cell's 1-based position in the input `cells` array (stable id).
export type SchedulerEvent =
  | {
      readonly kind: 'cell_queued';
      readonly idx: number;
      readonly entry: MatrixEntry;
    }
  | {
      readonly kind: 'cell_started';
      readonly idx: number;
      readonly entry: MatrixEntry;
    }
  | {
      readonly kind: 'cell_finished';
      readonly idx: number;
      readonly entry: MatrixEntry;
      // The child's raw outcome; the consumer derives final + cost_usd off its
      // run_id (the scheduler does no verdict.json I/O).
      readonly result: ChildResult;
      readonly run_id: string | null;
      readonly elapsed_s: number;
    }
  | {
      readonly kind: 'cell_skipped';
      readonly idx: number;
      readonly entry: MatrixEntry;
      readonly skipped_reason: SkippedReason;
    }
  | { readonly kind: 'batch_done' };

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface RunScheduleArgs {
  // The runnable cells only — caller-side directive/draft/tier skips are
  // already filtered out by build_matrix.
  readonly cells: readonly MatrixEntry[];
  // The global slot pool size ("up to this many of anything"). Validated >= 1.
  readonly jobs: number;
  // Per-harness in-flight cap. null = unbounded.
  readonly capFor: (harness: string) => number | null;
  // Per-harness minimum start-to-start gap in seconds. 0 = no spacing.
  readonly spacingFor: (harness: string) => number;
  // The single injectable clock governing BOTH eligibility (now >= next_start)
  // AND the dispatcher's sleep target.
  readonly clock: Clock;
  // Launch one child for a cell. Async so children run concurrently under the
  // pool. The scheduler awaits the returned promise and releases the slot on
  // completion.
  readonly invoke: (entry: MatrixEntry) => Promise<ChildResult>;
  // The rate-limit latch hook: true when a finished run's verdict is
  // rate-limited. run-all reads verdict.json here; tests stub it.
  readonly isRateLimited: (result: ChildResult) => boolean;
  // The event sink. Called as the consumer expects — single-threaded here, so
  // callbacks fire synchronously from the dispatcher's task; the consumer
  // serializes its own side effects (run-all appends results; the dashboard
  // marshals onto its loop).
  readonly onEvent: (event: SchedulerEvent) => void;
  // Optional child-pid registration hook (dashboard /stop). Pass-through;
  // called with the cell as a child is launched. Belt-and-suspenders.
  readonly onSpawn?: (entry: MatrixEntry) => void;
  // Optional belt-and-suspenders stop check polled at dispatch time, ALONGSIDE
  // the internal stop_requested flag (which requestStop sets). Either observing
  // a stop intent halts dispatch.
  readonly shouldAbort?: () => boolean;
}

export interface ScheduleHandle {
  // Resolves once every cell has a terminal event and batch_done has fired.
  readonly done: Promise<void>;
  // Request an eager stop (dashboard /stop). All undispatched cells skip
  // 'stopped' immediately; in-flight children are the consumer's concern.
  readonly requestStop: () => void;
}

// Per-cell bookkeeping. status drives the queued/started/terminal lifecycle so a
// cell receives EXACTLY ONE terminal event.
type CellStatus = 'queued' | 'started' | 'terminal';

interface Cell {
  readonly idx: number;
  readonly entry: MatrixEntry;
  readonly harness: string;
  status: CellStatus;
}

// Run the schedule. Returns immediately with a handle; the dispatcher runs as a
// detached async task resolving handle.done at batch_done.
export function runSchedule(args: RunScheduleArgs): ScheduleHandle {
  const scheduler = new Scheduler(args);
  return scheduler.start();
}

class Scheduler {
  private readonly args: RunScheduleArgs;
  private readonly cells: Cell[];
  private freeSlots: number;
  private readonly inflight: Map<string, number>;
  private readonly nextStart: Map<string, number>;
  private readonly latched: Set<string>;
  private stopRequested: boolean;
  private inflightCount: number;
  // A one-shot wakeup the dispatcher awaits when it has parked. Completions and
  // requestStop resolve it to re-run a dispatch pass.
  private wake: (() => void) | null;

  constructor(args: RunScheduleArgs) {
    if (!Number.isInteger(args.jobs) || args.jobs < 1) {
      throw new Error(`jobs must be an integer >= 1, got ${args.jobs}`);
    }
    this.args = args;
    this.cells = args.cells.map((entry, i) => ({
      idx: i + 1,
      entry,
      harness: entry.codingAgent,
      status: 'queued' as CellStatus,
    }));
    this.freeSlots = args.jobs;
    this.inflight = new Map<string, number>();
    // next_start defaults to the epoch (-Infinity): a harness's first start is
    // immediate (now >= -Infinity always holds).
    this.nextStart = new Map<string, number>();
    this.latched = new Set<string>();
    this.stopRequested = false;
    this.inflightCount = 0;
    this.wake = null;
  }

  start(): ScheduleHandle {
    const done = this.run();
    return {
      done,
      requestStop: () => {
        this.stopRequested = true;
        this.signalWake();
      },
    };
  }

  // The dispatcher's main loop. Emits all cell_queued first, then dispatches
  // greedily, parking on the clock / completions until every cell is terminal.
  private async run(): Promise<void> {
    // 1. Every runnable cell emits cell_queued BEFORE any cell starts.
    for (const cell of this.cells) {
      this.emit({ kind: 'cell_queued', idx: cell.idx, entry: cell.entry });
    }

    // 2. Dispatch loop.
    for (;;) {
      // Stop / abort intent eagerly skips every undispatched cell.
      if (this.stopRequested || (this.args.shouldAbort?.() ?? false)) {
        this.skipAllQueued('stopped');
      }

      this.dispatchGreedy();

      if (this.allTerminal()) {
        break;
      }

      // Cells remain non-terminal. Either work is in flight, or queued cells are
      // gated by spacing (a clock wake) — park until a completion or the
      // earliest spacing time, whichever comes first.
      const wakeTarget = this.earliestSpacingWake();

      if (this.inflightCount === 0 && wakeTarget === null) {
        // Nothing in flight and no future time unblocks anything. For valid
        // input this is unreachable (a queued cell with inflight[h]==0 and a
        // free slot is eligible now); guard against a hang regardless.
        break;
      }

      await this.park(wakeTarget);
    }

    // 3. batch_done fires exactly once, strictly last.
    this.emit({ kind: 'batch_done' });
  }

  // Start every cell that is eligible right now, in array order (arbitrary scan
  // order is permitted — no fairness). Each start consumes a slot and launches
  // the child; the slot is released on completion.
  private dispatchGreedy(): void {
    if (this.stopRequested || (this.args.shouldAbort?.() ?? false)) {
      return;
    }
    for (const cell of this.cells) {
      if (this.freeSlots <= 0) {
        return;
      }
      if (cell.status !== 'queued') {
        continue;
      }
      if (this.eligible(cell)) {
        this.startCell(cell);
      }
    }
  }

  // The spec's eligibility predicate, all clauses ANDed.
  private eligible(cell: Cell): boolean {
    const h = cell.harness;
    if (this.freeSlots <= 0) {
      return false;
    }
    if (this.inflightOf(h) >= this.capOf(h)) {
      return false;
    }
    if (this.args.clock.now() < this.nextStartOf(h)) {
      return false;
    }
    if (this.latched.has(h)) {
      return false;
    }
    if (this.stopRequested) {
      return false;
    }
    return true;
  }

  // Consume a slot, mark the cell started, set the harness's next permitted
  // start (start-to-start spacing), emit cell_started, and launch the child.
  private startCell(cell: Cell): void {
    const h = cell.harness;
    const now = this.args.clock.now();
    this.freeSlots -= 1;
    this.inflight.set(h, this.inflightOf(h) + 1);
    this.inflightCount += 1;
    this.nextStart.set(h, now + this.args.spacingFor(h));
    cell.status = 'started';

    this.args.onSpawn?.(cell.entry);
    this.emit({ kind: 'cell_started', idx: cell.idx, entry: cell.entry });

    const startedAt = now;
    // Fire-and-track the child. The completion handler releases counters,
    // applies the latch, emits the terminal event, and wakes the loop.
    void this.args.invoke(cell.entry).then(
      (result) => this.onComplete(cell, result, startedAt),
      // A rejected invoke is treated as a crash result (no run_id). The
      // consumer maps a null run_id to an 'unknown' final.
      (err: unknown) =>
        this.onComplete(
          cell,
          { run_id: null, exit_code: -1, error: String(err) },
          startedAt,
        ),
    );
  }

  // A child finished: release its slot + harness counter, apply the rate-limit
  // latch (eager-skip the harness's undispatched cells), emit cell_finished, and
  // wake the dispatcher to re-fill the freed slot.
  private onComplete(cell: Cell, result: ChildResult, startedAt: number): void {
    const h = cell.harness;
    this.freeSlots += 1;
    this.inflight.set(h, this.inflightOf(h) - 1);
    this.inflightCount -= 1;
    cell.status = 'terminal';

    const elapsed = Math.max(0, this.args.clock.now() - startedAt);
    this.emit({
      kind: 'cell_finished',
      idx: cell.idx,
      entry: cell.entry,
      result,
      run_id: result.run_id,
      elapsed_s: elapsed,
    });

    // Rate-limit latch: this harness joins `latched` and ALL its undispatched
    // cells immediately skip 'rate-limited'. In-flight runs of the harness are
    // left to finish; the latch dominates spacing (next_start never consulted
    // again for a latched harness).
    if (this.args.isRateLimited(result)) {
      this.latched.add(h);
      this.skipQueuedForHarness(h, 'rate-limited');
    }

    this.signalWake();
  }

  // Skip every still-queued cell of harness `h` (eager latch-and-skip).
  private skipQueuedForHarness(harness: string, reason: SkippedReason): void {
    for (const cell of this.cells) {
      if (cell.status === 'queued' && cell.harness === harness) {
        cell.status = 'terminal';
        this.emit({
          kind: 'cell_skipped',
          idx: cell.idx,
          entry: cell.entry,
          skipped_reason: reason,
        });
      }
    }
  }

  // Skip every still-queued cell regardless of harness (eager stop).
  private skipAllQueued(reason: SkippedReason): void {
    for (const cell of this.cells) {
      if (cell.status === 'queued') {
        cell.status = 'terminal';
        this.emit({
          kind: 'cell_skipped',
          idx: cell.idx,
          entry: cell.entry,
          skipped_reason: reason,
        });
      }
    }
  }

  // The earliest next_start among queued cells whose ONLY remaining block is
  // spacing (a slot is free now, the cap allows, not latched, not stopped). Such
  // a cell becomes eligible purely by the passage of time, so it is a valid
  // clock-wake target. Cells blocked by a full slot pool or a full cap are
  // unblocked by completions, not the clock, and contribute no wake target.
  private earliestSpacingWake(): number | null {
    if (this.stopRequested) {
      return null;
    }
    const now = this.args.clock.now();
    let earliest: number | null = null;
    for (const cell of this.cells) {
      if (cell.status !== 'queued') {
        continue;
      }
      const h = cell.harness;
      if (this.latched.has(h)) {
        continue;
      }
      if (this.freeSlots <= 0) {
        continue;
      }
      if (this.inflightOf(h) >= this.capOf(h)) {
        continue;
      }
      const ns = this.nextStartOf(h);
      if (now >= ns) {
        // Eligible NOW (not spacing-blocked) — dispatchGreedy handles it; this
        // shouldn't occur post-dispatch, but skip it as a non-wake.
        continue;
      }
      if (earliest === null || ns < earliest) {
        earliest = ns;
      }
    }
    return earliest;
  }

  // Park until a completion wakes us OR the clock reaches `wakeTarget` (spacing),
  // whichever first. With no spacing target, await the completion signal alone.
  private park(wakeTarget: number | null): Promise<void> {
    const completion = new Promise<void>((resolveP) => {
      this.wake = resolveP;
    });
    if (wakeTarget === null) {
      return completion;
    }
    const timer = this.args.clock.sleepUntil(wakeTarget);
    return Promise.race([completion, timer]);
  }

  // Resolve the parked completion promise (if any) so the loop re-dispatches.
  private signalWake(): void {
    const w = this.wake;
    if (w !== null) {
      this.wake = null;
      w();
    }
  }

  private allTerminal(): boolean {
    return this.cells.every((c) => c.status === 'terminal');
  }

  private inflightOf(harness: string): number {
    return this.inflight.get(harness) ?? 0;
  }

  private nextStartOf(harness: string): number {
    return this.nextStart.get(harness) ?? Number.NEGATIVE_INFINITY;
  }

  private capOf(harness: string): number {
    const cap = this.args.capFor(harness);
    return cap === null ? Number.POSITIVE_INFINITY : cap;
  }

  private emit(event: SchedulerEvent): void {
    this.args.onEvent(event);
  }
}
