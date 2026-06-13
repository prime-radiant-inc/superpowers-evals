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
import {
  allocateBatchDir,
  appendResultRecord,
  writeBatchFooter,
  writeBatchHeader,
} from './batch-index.ts';
import { agentMaxConcurrency, buildMatrix } from './matrix.ts';

// quorum run-all orchestrator. Ports invoke_child + run_batch (run_all.py).
// The run-all COMMAND is wired by the integrator (src/cli/index.ts); this
// module exports the functions its action calls.
//
// DEFER (run_all.py parity gaps left for later specs):
//  - NOTE: the Rich in-place LIVE in-flight panel — plain append-only output is
//    the functional core, so only the plain path is ported here.
//  - NOTE: the kimi batch preflight (prepare_kimi_batch_preflight) — each kimi
//    child self-preflights via its adapter, which avoids coupling run-all into
//    kimi.ts internals.

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
}

// Run one `quorum run` as a child process and capture its run-id line. The
// agents-dir / out-root are forwarded as explicit flags so the child doesn't
// rely on its own cwd-relative defaults (invoke_child). Spawned ASYNC (so the
// batch honors --jobs concurrency) via the bun runtime on the TS CLI entry.
export function invokeChild(args: InvokeChildArgs): Promise<ChildResult> {
  return new Promise<ChildResult>((resolveP) => {
    const env: Record<string, string | undefined> = {
      ...envSnapshot(),
      ...(args.extraEnv ?? {}),
    };
    const child = spawn(
      process.execPath,
      [
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
      { env },
    );

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
// Children run concurrently under the --jobs pool: each runnable cell is driven
// through its agent's lane limiter (buildLanes), so an agent with
// max_concurrency < jobs (e.g. antigravity=1) stays serial against its
// rate-limited backend while the rest of the matrix fills the main pool. Output
// interleaves by completion order (parity with the Python as_completed drain);
// JS is single-threaded so the per-cell record/print between awaits is atomic.
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

  // Concurrency lanes (run_all.py agent_caps/lanes): an agent with
  // max_concurrency < jobs gets a dedicated limiter of that size; every other
  // agent shares the main pool of size jobs. `fallback` is a type-safety guard
  // for the lookup — every runnable agent is in agentsInBatch, so it's a lane.
  const lanes = buildLanes(agentsInBatch, codingAgentsDir, jobs);
  const fallback = pLimit(jobs);

  // Agents that hit their rate-limit window this batch; once latched, their
  // remaining (not-yet-started) cells are recorded skipped:"rate-limited"
  // instead of invoked.
  const rateLimitedAgents = new Set<string>();

  await Promise.all(
    runnableIndexed.map(([idx, entry]) => {
      const limit = lanes.get(entry.codingAgent) ?? fallback;
      return limit(async () => {
        if (rateLimitedAgents.has(entry.codingAgent)) {
          // Agent already exhausted its rate-limit window; don't invoke — a
          // doomed preflight can hang and deepen the lockout (run_all.py skip).
          counts.rate_limited += 1;
          println(rateLimitLine(idx, total, entry));
          appendResultRecord({
            batchDir,
            scenario: entry.scenario,
            codingAgent: entry.codingAgent,
            runId: null,
            skipped: 'rate-limited',
          });
          return;
        }

        const t0 = Date.now();
        const result = await invoke({
          scenarioDir: entry.scenarioDir,
          codingAgent: entry.codingAgent,
          codingAgentsDir,
          outRoot,
        });
        const elapsed = (Date.now() - t0) / 1000;

        // Latch the agent if the child verdict carries the rate-limit marker.
        if (
          result.run_id !== null &&
          isRateLimitedVerdict(readVerdict(join(outRoot, result.run_id)))
        ) {
          rateLimitedAgents.add(entry.codingAgent);
        }

        const final = finalStatusForResult(result, outRoot);
        counts[final] += 1;
        const cost =
          result.run_id !== null ? runCost(join(outRoot, result.run_id)) : null;
        if (cost !== null) {
          batchCostTotal += cost;
        }
        println(doneLine(idx, total, entry, final, elapsed, cost));
        appendResultRecord({
          batchDir,
          scenario: entry.scenario,
          codingAgent: entry.codingAgent,
          runId: result.run_id,
          skipped: null,
        });
      });
    }),
  );

  const finishedAt = new Date();
  writeBatchFooter({ batchDir, finishedAt: finishedAt.toISOString() });

  let summary =
    `batch done · ${counts.pass} ✓ · ${counts.fail} ✗ · ` +
    `${counts.indeterminate} ⊘ · ${counts.skipped} —`;
  if (counts.rate_limited) summary += ` · ${counts.rate_limited} ⏸`;
  if (counts.unknown) summary += ` · ${counts.unknown} ?`;
  summary += ` · wall ${fmtDuration(
    (finishedAt.getTime() - startedAt.getTime()) / 1000,
  )}`;
  if (batchCostTotal > 0) summary += ` · cost $${batchCostTotal.toFixed(2)}`;
  println(summary);
  println(`artifacts: ${relativeToCwd(batchDir)}`);
  return batchDir;
}

// A bounded concurrency runner: at most n promise-returning tasks in flight.
// No external dep. Exported for the deferred async drive (spawn-based) and the
// per-agent lane caps; the current sync runBatch does not await it.
export function pLimit(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    if (active >= n) return;
    const run = queue.shift();
    if (run === undefined) return;
    active += 1;
    run();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolveP, rejectP) => {
      const run = (): void => {
        task().then(
          (value) => {
            active -= 1;
            resolveP(value);
            next();
          },
          (err: unknown) => {
            active -= 1;
            rejectP(err);
            next();
          },
        );
      };
      queue.push(run);
      next();
    });
}

// Map each agent to its lane limiter when its cap is below the global jobs
// pool, else the shared main pool (run_all.py lanes/agent_caps). For the
// deferred async (spawn-based) drive; the sync runBatch does not use it.
export function buildLanes(
  agents: readonly string[],
  codingAgentsDir: string,
  jobs: number,
): Map<string, ReturnType<typeof pLimit>> {
  const main = pLimit(jobs);
  const lanes = new Map<string, ReturnType<typeof pLimit>>();
  for (const agent of agents) {
    const cap = agentMaxConcurrency(codingAgentsDir, agent);
    lanes.set(
      agent,
      cap !== null && cap < jobs ? pLimit(Math.max(1, cap)) : main,
    );
  }
  return lanes;
}

// One skip line for an upfront-skipped cell, with its reason label
// (run_all.py skipped_indexed loop).
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

// One skip line for a runtime rate-limit-latched cell (run_all.py _drain
// sentinel branch).
function rateLimitLine(idx: number, total: number, entry: MatrixEntry): string {
  return (
    `[${idxLabel(idx, total)}] skip   ` +
    `${entry.scenario}  ${entry.codingAgent}  ${GLYPH_SKIP}  (agy rate-limited)`
  );
}

// One done line for a completed cell: glyph + duration + cost (run_all.py
// _drain done branch). Cost is "—" when absent.
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

// Integer-second duration: "Ns" under a minute, else "MmSSs" (run_all.py
// _fmt_duration).
function fmtDuration(seconds: number): string {
  const s = Math.trunc(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.trunc(s / 60);
  const rem = s % 60;
  return `${m}m${String(rem).padStart(2, '0')}s`;
}

function relativeToCwd(path: string): string {
  const rel = relative(process.cwd(), path);
  // relative() returns a ../-prefixed path when outside cwd; the Python falls
  // back to the absolute path in that case.
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

// Read + zod-narrow verdict.json for a run dir; null when missing/unparseable
// (run_all.py _read_verdict).
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

// True when a child's verdict carries the Code Assist rate-limit marker
// (run_all.py _is_rate_limited_verdict).
function isRateLimitedVerdict(verdict: VerdictView | null): boolean {
  if (verdict === null) return false;
  const message = verdict.error?.message ?? '';
  return message.includes(ANTIGRAVITY_RATE_LIMIT_MARKER);
}

// Frozen total est cost for a run from its verdict.json economics block, or
// null (run_all.py _run_cost).
function runCost(runDir: string): number | null {
  const verdict = readVerdict(runDir);
  if (verdict === null) return null;
  return verdict.economics?.total_est_cost_usd ?? null;
}

// Map a child outcome to one of pass / fail / indeterminate / unknown
// (run_all.py _final_status_for_result).
function finalStatusForResult(result: ChildResult, outRoot: string): Final {
  if (result.error !== null || result.run_id === null) return 'unknown';
  const verdict = readVerdict(join(outRoot, result.run_id));
  if (verdict === null) return 'unknown';
  const final = verdict.final ?? 'unknown';
  return final === 'pass' || final === 'fail' || final === 'indeterminate'
    ? final
    : 'unknown';
}
