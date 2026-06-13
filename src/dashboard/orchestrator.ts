import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { ANTIGRAVITY_RATE_LIMIT_MARKER } from '../agents/antigravity.ts';
import type { ChildResult, MatrixEntry } from '../contracts/batch.ts';
import { runnable } from '../contracts/batch.ts';
import {
  allocateBatchDir,
  appendResultRecord,
  writeBatchFooter,
  writeBatchHeader,
} from '../run-all/batch-index.ts';
import type { InvokeChildArgs, InvokeFn } from '../run-all/index.ts';
import { invokeChild } from '../run-all/index.ts';
import {
  agentLaunchSpacingSeconds,
  agentMaxConcurrency,
  buildMatrix,
} from '../run-all/matrix.ts';
import { RealClock } from '../scheduler/clock.ts';
import type { ScheduleHandle, SchedulerEvent } from '../scheduler/index.ts';
import { runSchedule } from '../scheduler/index.ts';

// Write side of the dashboard (PRI-2207, Spec 5, Task 12). One launch session at
// a time; drives the extracted scheduler (Spec 4) and exposes launch/stop. This
// is a faithful port of .worktrees/dashboard-ref/quorum/dashboard/orchestrator.py
// with two structural simplifications that single-loop Bun makes mandatory:
//
//  - NO background thread. The Python orchestrator spawns a daemon thread for
//    the drive because uvicorn's loop must stay free; here runSchedule is itself
//    an async task on the one loop, so launch() just kicks it off and returns.
//  - NO locks. Event callbacks + completions are serialized by the single loop,
//    so the Python's _lock / _pid_lock / _append_lock have nothing to guard.
//
// The kimi batch preflight the Python ran is intentionally absent: the TS
// run-all deferred it (each kimi child self-preflights via its adapter), so the
// orchestrator inherits that simplification rather than reintroducing the seam.

// A launch was requested while a session is already active (the route maps this
// to HTTP 409). Extends Error directly — no parameter properties.
export class LaunchBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchBusyError';
  }
}

// The kind of launch: a single scenario row, a single agent column, or the whole
// matrix. Maps to the matrix filter the same way the Python orchestrator did.
export type LaunchKind = 'row' | 'column' | 'all';

export interface LaunchArgs {
  readonly kind: LaunchKind;
  readonly scenario?: string;
  readonly agent?: string;
}

export interface OrchestratorArgs {
  readonly resultsRoot: string;
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly jobs: number;
  // Injectable child launcher (tests stub it; defaults to the live invokeChild).
  readonly invoke?: InvokeFn;
  // The SSE sink: every scheduler event is forwarded here AFTER results.jsonl is
  // appended. The server translates these into cell/strip publishes (parity with
  // app.py's _on_schedule_event). Optional — a headless orchestrator is fine.
  readonly onEvent?: (event: SchedulerEvent) => void;
}

// Only the one field the rate-limit latch reads.
const RateLimitViewSchema = z.object({
  error: z.object({ message: z.string().optional() }).nullable().optional(),
});

// The verdict's error message includes the Code Assist rate-limit marker (parity
// with run-all's isRateLimitedVerdict). Missing/unparseable verdict ⇒ not limited.
function readIsRateLimited(runDir: string): boolean {
  const path = join(runDir, 'verdict.json');
  if (!existsSync(path)) {
    return false;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  const parsed = RateLimitViewSchema.safeParse(raw);
  if (!parsed.success) {
    return false;
  }
  const message = parsed.data.error?.message ?? '';
  return message.includes(ANTIGRAVITY_RATE_LIMIT_MARKER);
}

export class Orchestrator {
  private readonly resultsRoot: string;
  private readonly scenariosRoot: string;
  private readonly codingAgentsDir: string;
  private readonly jobs: number;
  private readonly invoke: InvokeFn;
  private readonly onEvent: ((event: SchedulerEvent) => void) | undefined;
  // The live in-flight child OS pids; stop() SIGINTs each. Added via the wrapped
  // invoke's onPid, removed when that child's invoke settles, so the set only
  // ever holds genuinely-live children (the ESRCH guard in stop() is the race net
  // for the window between child exit and removal).
  private readonly childPids = new Set<number>();
  private isActive = false;
  // Set by stop(); polled by the scheduler's shouldAbort so still-queued cells
  // skip 'stopped'. Never auto-cleared mid-session — a fresh launch() resets it.
  private stopRequested = false;
  private handle: ScheduleHandle | null = null;
  // Resolves when the most recent launch's drive (footer write included) settles.
  private drive: Promise<void> = Promise.resolve();
  // Runnable cells in the most recent launch. The /launch route reads this so the
  // run strip's "Running N" is correct from first paint (S4).
  runnableTotal = 0;

  constructor(args: OrchestratorArgs) {
    this.resultsRoot = args.resultsRoot;
    this.scenariosRoot = args.scenariosRoot;
    this.codingAgentsDir = args.codingAgentsDir;
    this.jobs = args.jobs;
    this.invoke = args.invoke ?? invokeChild;
    this.onEvent = args.onEvent;
  }

  // True while a launch session is in flight (the route maps a launch() during
  // this window to 409).
  get active(): boolean {
    return this.isActive;
  }

  // Start a launch session. Throws LaunchBusyError if one is active. Returns the
  // batch id. Sets runnableTotal before spawning so the caller's run strip shows
  // the correct launched total immediately. The drive runs as a detached async
  // task; wait() (tests) awaits its completion.
  launch(args: LaunchArgs): string {
    if (this.isActive) {
      throw new LaunchBusyError('a launch session is already active');
    }
    this.isActive = true;
    this.stopRequested = false;

    const agentFilter =
      args.kind === 'column' && args.agent !== undefined
        ? [args.agent]
        : undefined;
    const scenarioFilter =
      args.kind === 'row' && args.scenario !== undefined
        ? [args.scenario]
        : undefined;

    const entries = buildMatrix({
      scenariosRoot: this.scenariosRoot,
      codingAgentsDir: this.codingAgentsDir,
      ...(agentFilter !== undefined ? { agentFilter } : {}),
      ...(scenarioFilter !== undefined ? { scenarioFilter } : {}),
    });
    const runnableEntries = entries.filter((e) => runnable(e));
    this.runnableTotal = runnableEntries.length;

    const batchDir = allocateBatchDir({ outRoot: this.resultsRoot });
    const agentsInBatch = [
      ...new Set(entries.map((e) => e.codingAgent)),
    ].sort();
    writeBatchHeader({
      batchDir,
      codingAgents: agentsInBatch,
      jobs: this.jobs,
      startedAt: new Date().toISOString(),
    });

    const handle = runSchedule({
      cells: runnableEntries,
      jobs: this.jobs,
      capFor: (h) => agentMaxConcurrency(this.codingAgentsDir, h),
      spacingFor: (h) => agentLaunchSpacingSeconds(this.codingAgentsDir, h),
      clock: new RealClock(),
      invoke: (entry) => this.trackingInvoke(entry),
      isRateLimited: (result) =>
        result.run_id !== null &&
        readIsRateLimited(join(this.resultsRoot, result.run_id)),
      onEvent: (event) => this.handleEvent(batchDir, event),
      shouldAbort: () => this.stopRequested,
    });
    this.handle = handle;

    // The drive resolves when every cell is terminal; write the footer + clear
    // active then. Errors in the drive still release the session.
    this.drive = handle.done.then(
      () => this.finishDrive(batchDir),
      () => this.finishDrive(batchDir),
    );

    return basename(batchDir);
  }

  // Append the results.jsonl record (parity with run-all) for finished/skipped
  // cells, THEN forward the event to the SSE sink. The forward happens after the
  // append so a server-side re-scan in onEvent sees a consistent batch index.
  private handleEvent(batchDir: string, event: SchedulerEvent): void {
    if (event.kind === 'cell_finished') {
      appendResultRecord({
        batchDir,
        scenario: event.entry.scenario,
        codingAgent: event.entry.codingAgent,
        runId: event.run_id,
        skipped: null,
      });
    } else if (event.kind === 'cell_skipped') {
      appendResultRecord({
        batchDir,
        scenario: event.entry.scenario,
        codingAgent: event.entry.codingAgent,
        runId: null,
        skipped: event.skipped_reason,
      });
    }
    this.onEvent?.(event);
  }

  // Wrap the underlying invoke so a child's pid is tracked for the lifetime of
  // its run and dropped the instant it settles. onPid (called synchronously after
  // spawn) adds it; the finally removes it — keeping the set honest so stop()
  // only ever SIGINTs genuinely-live children.
  private async trackingInvoke(entry: MatrixEntry): Promise<ChildResult> {
    const spawned: number[] = [];
    const childArgs: InvokeChildArgs = {
      scenarioDir: entry.scenarioDir,
      codingAgent: entry.codingAgent,
      codingAgentsDir: this.codingAgentsDir,
      outRoot: this.resultsRoot,
      onPid: (pid) => {
        spawned.push(pid);
        this.childPids.add(pid);
      },
    };
    try {
      return await this.invoke(childArgs);
    } finally {
      for (const pid of spawned) {
        this.childPids.delete(pid);
      }
    }
  }

  // Cancel everything still queued and SIGINT every tracked in-flight child,
  // driving the runner's graceful-stop path (the runner's SIGINT handler writes a
  // stopped verdict). SIGTERM is deliberately NOT used — without a handler it
  // kills children verdict-less. ESRCH (process already gone) is swallowed.
  stop(): void {
    this.stopRequested = true;
    this.handle?.requestStop();
    for (const pid of this.childPids) {
      try {
        process.kill(pid, 'SIGINT');
      } catch {
        // ProcessLookupError / ESRCH: the child already exited; nothing to do.
      }
    }
  }

  // Await the most recent launch's drive (footer + active clear included). Tests
  // use this to deterministically wait out a session with no live children.
  async wait(): Promise<void> {
    await this.drive;
  }

  private finishDrive(batchDir: string): void {
    writeBatchFooter({ batchDir, finishedAt: new Date().toISOString() });
    this.isActive = false;
  }
}
