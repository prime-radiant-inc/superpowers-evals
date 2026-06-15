import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ANTIGRAVITY_RATE_LIMIT_MARKER } from '../agents/antigravity.ts';
import { parseCodingAgentsDirective } from '../checks/index.ts';
import type { ChildResult, MatrixEntry } from '../contracts/batch.ts';
import { runnable } from '../contracts/batch.ts';
import { envSnapshot } from '../env.ts';
import type { Clock } from '../scheduler/clock.ts';
import { RealClock } from '../scheduler/clock.ts';
import type { SchedulerEvent } from '../scheduler/index.ts';
import { runSchedule } from '../scheduler/index.ts';
import {
  allocateBatchDir,
  appendResultRecord,
  writeBatchFooter,
  writeBatchHeader,
} from './batch-index.ts';
import {
  agentLaunchSpacingSeconds,
  agentMaxConcurrency,
  buildMatrix,
} from './matrix.ts';

// quorum run-all orchestrator: invokeChild + runBatch.
// The run-all COMMAND is wired by the integrator (src/cli/index.ts); this
// module exports the functions its action calls.
//
// The batch is driven through the central scheduler (src/scheduler/index.ts):
// runBatch builds the matrix + renders the directive/draft/tier skips
// caller-side, then hands the runnable cells to runSchedule and becomes its
// event consumer. The scheduler owns ONE global slot pool of size `jobs` and a
// TRUE global cap.
//
// Output is plain append-only: a cell_started line is a live-panel concern, so
// plain mode prints only on completion and cell_started is a no-op
// consumer-side. There is no kimi batch preflight here — each kimi child
// self-preflights via its adapter, which avoids coupling run-all into kimi.ts
// internals. The dashboard consumes the same scheduler events (onSpawn pid
// registration, requestStop /stop), but wires them itself, not here.

const RUN_ID_PREFIX = 'run-id: ';

// The CLI entry the child invokes (src/cli/index.ts), resolved from this module.
const CLI_ENTRY = fileURLToPath(new URL('../cli/index.ts', import.meta.url));

function parseRunId(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith(RUN_ID_PREFIX)) {
      return line.slice(RUN_ID_PREFIX.length).trim();
    }
  }
  return null;
}

export interface InvokeChildArgs {
  readonly scenarioDir: string;
  readonly codingAgent: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  readonly timeoutSeconds?: number;
  readonly extraEnv?: Readonly<Record<string, string>>;
  // Called once with the spawned child's OS pid, right after spawn. The
  // dashboard orchestrator registers the pid here so /stop can SIGINT in-flight
  // children; run-all leaves it unset.
  readonly onPid?: (pid: number) => void;
}

// The spawn-and-collect core shared by invokeChild (and exercisable directly in
// tests). Spawns `command args`, captures the run-id line from stdout, and
// DRAINS stderr so a child writing more than the OS pipe buffer (~64KB) never
// blocks on its stderr write. Without the stderr drain a verbose child deadlocks
// on write() and the scheduler slot hangs forever.
export interface SpawnCollectArgs {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly timeoutSeconds?: number;
  readonly onPid?: (pid: number) => void;
  // Called with each stderr chunk's byte length as it is drained. Lets tests
  // assert stderr is actively consumed (not ignored); unused in production.
  readonly onStderr?: (byteLength: number) => void;
}

export function spawnCollectRunId(
  args: SpawnCollectArgs,
): Promise<ChildResult> {
  return new Promise<ChildResult>((resolveP) => {
    const child = spawn(args.command, [...args.args], { env: args.env });

    // Report the OS pid to the optional dashboard hook the instant it exists,
    // before any child output, so /stop can target in-flight children.
    if (child.pid !== undefined) {
      args.onPid?.(child.pid);
    }

    let stdout = '';
    let timedOut = false;
    const timer =
      args.timeoutSeconds !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, args.timeoutSeconds * 1000)
        : undefined;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // Drain stderr too. We don't keep its contents in the result, but the bytes
    // MUST be actively consumed — attaching a 'data' listener switches the stream
    // to flowing mode and reads it — or the child can block once the OS pipe
    // buffer fills (pipe-buffer deadlock). The optional onStderr hook lets tests
    // observe that consumption happens.
    child.stderr?.on('data', (chunk: Buffer | string) => {
      args.onStderr?.(chunk.length);
    });
    child.on('error', () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolveP({ run_id: null, exit_code: -1, error: 'child failed to spawn' });
    });
    child.on('close', (code: number | null) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (timedOut) {
        resolveP({ run_id: null, exit_code: -1, error: 'child timed out' });
        return;
      }
      const runId = parseRunId(stdout);
      const exitCode = code ?? -1;
      if (runId === null) {
        resolveP({
          run_id: null,
          exit_code: exitCode,
          error: `child did not print run-id (exit ${exitCode})`,
        });
        return;
      }
      resolveP({ run_id: runId, exit_code: exitCode, error: null });
    });
  });
}

// Run one `quorum run` as a child process and capture its run-id line. The
// agents-dir / out-root are forwarded as explicit flags so the child doesn't
// rely on its own cwd-relative defaults (invoke_child). Spawned ASYNC (so the
// batch honors --jobs concurrency) via the bun runtime on the TS CLI entry.
export function invokeChild(args: InvokeChildArgs): Promise<ChildResult> {
  const env: Record<string, string | undefined> = {
    ...envSnapshot(),
    ...(args.extraEnv ?? {}),
  };
  return spawnCollectRunId({
    command: process.execPath,
    args: [
      CLI_ENTRY,
      'run',
      args.scenarioDir,
      '--coding-agent',
      args.codingAgent,
      '--coding-agents-dir',
      args.codingAgentsDir,
      '--out-root',
      args.outRoot,
    ],
    env,
    ...(args.timeoutSeconds !== undefined
      ? { timeoutSeconds: args.timeoutSeconds }
      : {}),
    ...(args.onPid !== undefined ? { onPid: args.onPid } : {}),
  });
}

// The invokeChild signature, so tests can inject a fake. Async so children run
// concurrently under the --jobs pool.
export type InvokeFn = (args: InvokeChildArgs) => Promise<ChildResult>;

export interface RunBatchArgs {
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  readonly jobs: number;
  readonly agentFilter?: readonly string[];
  readonly scenarioFilter?: readonly string[];
  readonly tier?: 'sentinel' | 'full' | 'adhoc' | null;
  readonly includeDrafts?: boolean;
  readonly invoke?: InvokeFn;
  readonly useCursor?: boolean;
  readonly stream?: { write(s: string): void };
  // The scheduler clock; defaults to RealClock. Tests inject a FakeClock to
  // drive spacing deterministically — but run-all's own behavior tests use the
  // real clock with instant fake invokes (no spacing configured).
  readonly clock?: Clock;
}

type Final = 'pass' | 'fail' | 'indeterminate' | 'unknown';

const GLYPH_FOR_FINAL: Readonly<Record<Final, string>> = {
  pass: '✓',
  fail: '✗',
  indeterminate: '⊘',
  unknown: '?',
};
const GLYPH_SKIP = '—';

// Run the full batch; returns the batch dir path (run_batch). Plain
// append-only output only (Rich Live in-place panel deferred). `invoke`
// defaults to the live (async) invokeChild; tests inject a fake.
//
// The runnable cells are driven through the central scheduler (runSchedule),
// which owns ONE global slot pool of size `jobs` and enforces a TRUE global cap
// plus per-harness caps + launch spacing. run-all is the event consumer: it
// renders the completion / skip lines, appends results.jsonl records, and
// tallies cost as the scheduler emits events. JS is single-threaded so the
// per-event record/print is atomic against the dispatcher's task.
export async function runBatch(args: RunBatchArgs): Promise<string> {
  const {
    scenariosRoot,
    codingAgentsDir,
    outRoot,
    jobs,
    agentFilter,
    scenarioFilter,
    tier = null,
    includeDrafts = false,
    invoke = invokeChild,
    stream = process.stdout,
    clock = new RealClock(),
  } = args;
  // NOTE: useCursor / the Rich Live panel are deferred; only plain mode runs.

  if (jobs < 1) {
    throw new Error(`jobs must be >= 1, got ${jobs}`);
  }

  const entries = buildMatrix({
    scenariosRoot,
    codingAgentsDir,
    ...(agentFilter !== undefined ? { agentFilter } : {}),
    ...(scenarioFilter !== undefined ? { scenarioFilter } : {}),
    tierFilter: tier,
    includeDrafts,
  });

  const batchDir = allocateBatchDir({ outRoot });
  const startedAt = new Date();
  const total = entries.length;
  const indexed = entries.map((e, i): readonly [number, MatrixEntry] => [
    i + 1,
    e,
  ]);
  const runnableIndexed = indexed.filter(([, e]) => runnable(e));
  const skippedIndexed = indexed.filter(([, e]) => !runnable(e));
  const agentsInBatch = [...new Set(entries.map((e) => e.codingAgent))].sort();

  writeBatchHeader({
    batchDir,
    codingAgents: agentsInBatch,
    jobs,
    startedAt: startedAt.toISOString(),
  });

  const counts = {
    pass: 0,
    fail: 0,
    indeterminate: 0,
    unknown: 0,
    skipped: skippedIndexed.length,
    rate_limited: 0,
    stopped: 0,
  };
  let batchCostTotal = 0;

  const println = (s: string): void => {
    stream.write(`${s}\n`);
  };

  // Header banner (run_batch console.print).
  println(
    `batch ${basename(batchDir)} · ${total} pairs ` +
      `(${runnableIndexed.length} runnable, ${skippedIndexed.length} skipped) ` +
      `· --jobs ${jobs}`,
  );

  // Skips render first, synchronously, with their reason label.
  for (const [idx, entry] of skippedIndexed) {
    println(skipLine(idx, total, entry));
    appendResultRecord({
      batchDir,
      scenario: entry.scenario,
      codingAgent: entry.codingAgent,
      runId: null,
      skipped: entry.skippedReason,
    });
  }

  // The cell's 1-based idx in the scheduler's view is its position among the
  // RUNNABLE cells. run-all's display labels are the matrix's global 1..total
  // indices, so map the scheduler idx back to the matrix idx via this array.
  const runnableEntries = runnableIndexed.map(([, entry]) => entry);
  const matrixIdxForRunnable = runnableIndexed.map(([idx]) => idx);
  const matrixIdxFor = (schedulerIdx: number): number =>
    matrixIdxForRunnable[schedulerIdx - 1] ?? schedulerIdx;

  // The scheduler invokes a cell; adapt the MatrixEntry to invoke_child's args.
  const invokeCell = (entry: MatrixEntry): Promise<ChildResult> =>
    invoke({
      scenarioDir: entry.scenarioDir,
      codingAgent: entry.codingAgent,
      codingAgentsDir,
      outRoot,
    });

  // The rate-limit latch hook: a finished child whose verdict.json carries the
  // Code Assist marker latches its harness.
  const isRateLimited = (result: ChildResult): boolean =>
    result.run_id !== null &&
    isRateLimitedVerdict(readVerdict(join(outRoot, result.run_id)));

  // run-all consumes the scheduler's event stream: render the completion / skip
  // line, append the results.jsonl record, and tally cost. cell_queued /
  // cell_started are no-ops in plain mode (the start line is a live-panel
  // concern); batch_done's summary is printed after the drive resolves.
  const onEvent = (event: SchedulerEvent): void => {
    if (event.kind === 'cell_finished') {
      const idx = matrixIdxFor(event.idx);
      const final = finalStatusForResult(event.result, outRoot);
      counts[final] += 1;
      const cost =
        event.run_id !== null ? runCost(join(outRoot, event.run_id)) : null;
      if (cost !== null) {
        batchCostTotal += cost;
      }
      println(doneLine(idx, total, event.entry, final, event.elapsed_s, cost));
      appendResultRecord({
        batchDir,
        scenario: event.entry.scenario,
        codingAgent: event.entry.codingAgent,
        runId: event.run_id,
        skipped: null,
      });
      return;
    }
    if (event.kind === 'cell_skipped') {
      const idx = matrixIdxFor(event.idx);
      if (event.skipped_reason === 'rate-limited') {
        counts.rate_limited += 1;
        println(rateLimitLine(idx, total, event.entry));
        appendResultRecord({
          batchDir,
          scenario: event.entry.scenario,
          codingAgent: event.entry.codingAgent,
          runId: null,
          skipped: 'rate-limited',
        });
      } else {
        counts.stopped += 1;
        println(stoppedLine(idx, total, event.entry));
        appendResultRecord({
          batchDir,
          scenario: event.entry.scenario,
          codingAgent: event.entry.codingAgent,
          runId: null,
          skipped: 'stopped',
        });
      }
    }
  };

  const { done } = runSchedule({
    cells: runnableEntries,
    jobs,
    capFor: (h) => agentMaxConcurrency(codingAgentsDir, h),
    spacingFor: (h) => agentLaunchSpacingSeconds(codingAgentsDir, h),
    clock,
    invoke: invokeCell,
    isRateLimited,
    onEvent,
  });
  await done;

  const finishedAt = new Date();
  writeBatchFooter({ batchDir, finishedAt: finishedAt.toISOString() });

  let summary =
    `batch done · ${counts.pass} ✓ · ${counts.fail} ✗ · ` +
    `${counts.indeterminate} ⊘ · ${counts.skipped} —`;
  if (counts.rate_limited) summary += ` · ${counts.rate_limited} ⏸`;
  if (counts.stopped) summary += ` · ${counts.stopped} ⏹`;
  if (counts.unknown) summary += ` · ${counts.unknown} ?`;
  summary += ` · wall ${fmtDuration(
    (finishedAt.getTime() - startedAt.getTime()) / 1000,
  )}`;
  if (batchCostTotal > 0) summary += ` · cost $${batchCostTotal.toFixed(2)}`;
  println(summary);
  println(`artifacts: ${relativeToCwd(batchDir)}`);
  return batchDir;
}

// One skip line for an upfront-skipped cell, with its reason label.
function skipLine(idx: number, total: number, entry: MatrixEntry): string {
  let reason: string;
  if (entry.skippedReason === 'directive') {
    const directive =
      parseCodingAgentsDirective(join(entry.scenarioDir, 'checks.sh')) ?? [];
    reason = `(requires ${directive.join(', ')})`;
  } else if (entry.skippedReason === 'draft') {
    reason = '(draft)';
  } else if (entry.skippedReason === 'tier') {
    reason = `(tier: ${entry.tier})`;
  } else {
    reason = `(${String(entry.skippedReason)})`;
  }
  return (
    `[${idxLabel(idx, total)}] skip   ` +
    `${entry.scenario}  ${entry.codingAgent}  ${GLYPH_SKIP}  ${reason}`
  );
}

// One skip line for a runtime rate-limit-latched cell.
function rateLimitLine(idx: number, total: number, entry: MatrixEntry): string {
  return (
    `[${idxLabel(idx, total)}] skip   ` +
    `${entry.scenario}  ${entry.codingAgent}  ${GLYPH_SKIP}  (agy rate-limited)`
  );
}

// One skip line for a cell skipped by an eager stop (dashboard /stop). The
// scheduler emits cell_skipped('stopped') for every undispatched cell once stop
// is requested; in-flight children are the consumer's concern.
function stoppedLine(idx: number, total: number, entry: MatrixEntry): string {
  return (
    `[${idxLabel(idx, total)}] skip   ` +
    `${entry.scenario}  ${entry.codingAgent}  ${GLYPH_SKIP}  (stopped)`
  );
}

// One done line for a completed cell: glyph + duration + cost. Cost is "—" when
// absent.
function doneLine(
  idx: number,
  total: number,
  entry: MatrixEntry,
  final: Final,
  elapsed: number,
  cost: number | null,
): string {
  const costCell = cost !== null ? `$${cost.toFixed(2)}` : '—';
  return (
    `[${idxLabel(idx, total)}] done   ` +
    `${entry.scenario}  ${entry.codingAgent}  ${GLYPH_FOR_FINAL[final]}  ` +
    `${fmtDuration(elapsed)}  ${costCell}`
  );
}

function idxLabel(idx: number, total: number): string {
  return `${String(idx).padStart(String(total).length, '0')}/${total}`;
}

// Integer-second duration: "Ns" under a minute, else "MmSSs".
function fmtDuration(seconds: number): string {
  const s = Math.trunc(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.trunc(s / 60);
  const rem = s % 60;
  return `${m}m${String(rem).padStart(2, '0')}s`;
}

function relativeToCwd(path: string): string {
  const rel = relative(process.cwd(), path);
  // relative() returns a ../-prefixed path when outside cwd; fall back to the
  // absolute path in that case.
  return rel.startsWith('..') ? path : rel;
}

// Only the one field the renderer reads; the rest of economics is opaque here.
const VerdictViewSchema = z.object({
  final: z.string().optional(),
  error: z.object({ message: z.string().optional() }).nullable().optional(),
  economics: z
    .object({ total_est_cost_usd: z.number().nullable().optional() })
    .nullable()
    .optional(),
});
type VerdictView = z.infer<typeof VerdictViewSchema>;

// Read + zod-narrow verdict.json for a run dir; null when missing/unparseable.
function readVerdict(runDir: string): VerdictView | null {
  const path = join(runDir, 'verdict.json');
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const parsed = VerdictViewSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// True when a child's verdict carries the Code Assist rate-limit marker.
function isRateLimitedVerdict(verdict: VerdictView | null): boolean {
  if (verdict === null) return false;
  const message = verdict.error?.message ?? '';
  return message.includes(ANTIGRAVITY_RATE_LIMIT_MARKER);
}

// Frozen total est cost for a run from its verdict.json economics block, or
// null when absent.
function runCost(runDir: string): number | null {
  const verdict = readVerdict(runDir);
  if (verdict === null) return null;
  return verdict.economics?.total_est_cost_usd ?? null;
}

// Map a child outcome to one of pass / fail / indeterminate / unknown.
function finalStatusForResult(result: ChildResult, outRoot: string): Final {
  if (result.error !== null || result.run_id === null) return 'unknown';
  const verdict = readVerdict(join(outRoot, result.run_id));
  if (verdict === null) return 'unknown';
  const final = verdict.final ?? 'unknown';
  return final === 'pass' || final === 'fail' || final === 'indeterminate'
    ? final
    : 'unknown';
}
