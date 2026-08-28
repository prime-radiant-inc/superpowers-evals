// Contention guard (kernel D3, Decision D-3 — sensors lead): the timer-
// driven sampler + fsynced sidecar + ONE pure edge/coverage/interval/
// overlap/tri-state evaluator shared VERBATIM by the dispatcher (task 8)
// and D4's seal-time audit/backstop. Raw telemetry never enters the
// fsync-per-event journal; the sidecar is retained evidence, decision
// evidence for closed-window mints, and NOT replay-required.
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../scheduler/clock.ts';
import {
  clockNowMs,
  type HostStats,
  type HostStatsProbe,
} from './host-stats.ts';

export const SIDECAR_FILENAME = 'contention-telemetry.jsonl';

export interface TelemetrySample {
  readonly ts_ms: number;
  readonly load1: number;
  readonly mem_available_bytes: number;
  readonly swap_used_bytes: number;
  readonly process_count: number;
  readonly disk_free_bytes: number;
  /** Non-empty while a breach window is open (breached metric names). */
  readonly breach: readonly string[];
}

export interface TelemetryGap {
  readonly ts_ms: number;
  readonly missing: true; // missed sample (probe error, scheduler stall)
}

export type SidecarLine = TelemetrySample | TelemetryGap;

/** Append one JSON line, fsynced per sample (Decision D-3). */
export function appendSidecarLine(
  campaignDir: string,
  line: SidecarLine,
): void {
  const path = join(campaignDir, SIDECAR_FILENAME);
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(line)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Torn-tail tolerant parse: truncate at the last COMPLETE line with a loud
 *  flag; the truncated interval counts as uncovered (the evaluator takes
 *  `truncatedTail` as a required input — C6, tail state is never discarded). */
export function parseSidecar(campaignDir: string): {
  lines: SidecarLine[];
  truncatedTail: boolean;
} {
  const path = join(campaignDir, SIDECAR_FILENAME);
  if (!existsSync(path)) return { lines: [], truncatedTail: false };
  const text = readFileSync(path, 'utf8');
  const rawLines = text.split('\n');
  const lines: SidecarLine[] = [];
  let truncatedTail = false;
  for (const raw of rawLines) {
    if (raw === '') continue;
    try {
      lines.push(JSON.parse(raw) as SidecarLine);
    } catch {
      truncatedTail = true; // crash mid-append: torn tail
    }
  }
  if (truncatedTail) {
    process.stderr.write(
      `contention sidecar at ${path} has a torn tail — truncated at the last complete line; the truncated interval counts as uncovered\n`,
    );
  }
  return { lines, truncatedTail };
}

export interface ResolvedThreshold {
  readonly metric: string;
  readonly op: 'gt' | 'lt';
  readonly value: number;
}

/** The registered threshold -> sample comparison. Metric sources pinned:
 *  load1, mem available, swap used, process count, disk free. `cpuCores` is
 *  the REGISTERED fingerprint's cpu_cores (Decision D-4), never the live
 *  machine's: `load1_per_core` thresholds carry per-core values (default
 *  `gt 2.0`) while samples carry raw load1, so the sample side divides by
 *  the frozen core count (C6). */
export function thresholdViolations(
  // The metric subset both HostStats and sidecar TelemetrySample carry —
  // breachWindows re-evaluates persisted lines through the same predicate.
  sample: Pick<
    HostStats,
    | 'load1'
    | 'mem_available_bytes'
    | 'swap_used_bytes'
    | 'process_count'
    | 'disk_free_bytes'
  >,
  thresholds: readonly ResolvedThreshold[],
  cpuCores: number,
): string[] {
  const metricValue = (metric: string): number | null => {
    switch (metric) {
      case 'load1':
        return sample.load1;
      case 'load1_per_core':
        if (!(Number.isFinite(cpuCores) && cpuCores > 0)) {
          throw new Error(
            `load1_per_core needs the registered fingerprint's positive cpu_cores (got ${cpuCores}) — refusing to compare raw load (fail-closed)`,
          );
        }
        return sample.load1 / cpuCores;
      case 'mem_available_bytes':
        return sample.mem_available_bytes;
      case 'swap_used_bytes':
        return sample.swap_used_bytes;
      case 'process_count':
        return sample.process_count;
      case 'disk_free_bytes':
        return sample.disk_free_bytes;
      default:
        return null;
    }
  };
  const violated: string[] = [];
  for (const t of thresholds) {
    const v = metricValue(t.metric);
    if (v === null) continue;
    if (t.op === 'gt' ? v > t.value : v < t.value) violated.push(t.metric);
  }
  return violated;
}

export interface BreachWindow {
  readonly startTsMs: number;
  /** null = still open. */
  readonly endTsMs: number | null;
  readonly metrics: readonly string[];
}

/** Symmetric K-sustained edges (REV-2 P-6): entry = sustain_k consecutive
 *  threshold crossings; exit = sustain_k consecutive samples back inside
 *  every breached threshold. sustain_k (samples) is the ONLY hysteresis.
 *  Missing-sample gap lines neither extend nor interrupt a sustain run. */
export function breachWindows(
  lines: readonly SidecarLine[],
  thresholds: readonly ResolvedThreshold[],
  sustainK: number,
  cpuCores: number,
): BreachWindow[] {
  const windows: BreachWindow[] = [];
  let crossingRun: { count: number; metrics: string[]; lastTs: number } | null =
    null;
  let openWindow: { startTsMs: number; metrics: string[] } | null = null;
  let inBoundsRun = 0;
  for (const line of lines) {
    if ('missing' in line) continue; // gaps neither extend nor interrupt
    const violated = thresholdViolations(line, thresholds, cpuCores);
    if (openWindow === null) {
      if (violated.length > 0) {
        if (crossingRun === null)
          crossingRun = { count: 0, metrics: violated, lastTs: line.ts_ms };
        crossingRun.count += 1;
        crossingRun.metrics = [
          ...new Set([...crossingRun.metrics, ...violated]),
        ];
        crossingRun.lastTs = line.ts_ms;
        if (crossingRun.count >= sustainK) {
          openWindow = {
            startTsMs: crossingRun.lastTs,
            metrics: crossingRun.metrics,
          };
          crossingRun = null;
          inBoundsRun = 0;
        }
      } else {
        crossingRun = null;
      }
    } else {
      if (violated.length === 0) {
        inBoundsRun += 1;
        if (inBoundsRun >= sustainK) {
          windows.push({
            startTsMs: openWindow.startTsMs,
            endTsMs: line.ts_ms,
            metrics: openWindow.metrics,
          });
          openWindow = null;
          inBoundsRun = 0;
        }
      } else {
        inBoundsRun = 0; // symmetric: crossings reset the in-bounds run
      }
    }
  }
  if (openWindow !== null) {
    windows.push({
      startTsMs: openWindow.startTsMs,
      endTsMs: null,
      metrics: openWindow.metrics,
    });
  }
  return windows;
}

/** Dead-sampler liveness input: age of the newest line — gap lines count,
 *  they prove the sampler itself is alive (infinity when the sidecar is
 *  empty). The dispatcher halts admission above 2 x cadence. */
export function samplerStaleMs(
  lines: readonly SidecarLine[],
  nowMs: number,
): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const line of lines) newest = Math.max(newest, line.ts_ms);
  if (newest === Number.NEGATIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return nowMs - newest;
}

export type BlockContentionVerdict = 'invalid' | 'unknown' | 'clean';

export interface BlockInterval {
  readonly block_id: string;
  /** Earliest roster attempt_created.ts_ms (journal-reconstructable). */
  readonly startTsMs: number;
  /** Latest service-end terminal ts_ms; null = still live (clipped to the
   *  evaluation horizon for a closed-window evaluation). */
  readonly endTsMs: number | null;
}

export interface EvaluateContentionArgs {
  readonly lines: readonly SidecarLine[];
  /** parseSidecar's torn-tail flag — REQUIRED so tail state is never
   *  discarded (C6): true uncovers [last sample, horizon]. */
  readonly truncatedTail: boolean;
  readonly thresholds: readonly ResolvedThreshold[];
  readonly sustainK: number;
  readonly cadenceMs: number;
  readonly coverageN: number;
  /** The REGISTERED fingerprint's cpu_cores (C6) — load1_per_core
   *  normalization, never the live machine's count. */
  readonly cpuCores: number;
  /** The journal's REAL campaign_opened.ts_ms (C6): live evaluation must
   *  pass the actual event timestamp, never 0 or a placeholder — head
   *  coverage is anchored here. */
  readonly campaignOpenedTsMs: number;
  readonly lastTerminalTsMs: number;
  readonly blocks: readonly BlockInterval[];
}

/** THE one pure evaluator (Decision D-3/D-5): breach edges, coverage,
 *  journal-derived conservative block intervals, overlap, and the final
 *  tri-state — shared verbatim by the dispatcher and D4. Precedence: known
 *  breach overlap -> invalid; else uncovered overlap -> unknown (NEVER
 *  contention); else clean. Uncovered intervals come from three sources
 *  (C6): real-sample spacing beyond N x cadence, explicit gap lines
 *  (direct evidence of blindness, regardless of spacing), and a torn tail. */
export function evaluateContention(
  args: EvaluateContentionArgs,
): Map<string, BlockContentionVerdict> {
  const windows = breachWindows(
    args.lines,
    args.thresholds,
    args.sustainK,
    args.cpuCores,
  );
  // Coverage: [campaign_opened.ts_ms, last sample terminal ts_ms] covered
  // within N x cadence by real samples; gaps + torn tail count uncovered.
  const sampleTs = args.lines
    .filter((l) => !('missing' in l))
    .map((l) => l.ts_ms)
    .sort((a, b) => a - b);
  const uncovered: Array<{ start: number; end: number }> = [];
  const horizon = args.lastTerminalTsMs;
  const maxGap = args.coverageN * args.cadenceMs;
  let prev = args.campaignOpenedTsMs;
  for (const ts of sampleTs) {
    if (ts > prev + maxGap) uncovered.push({ start: prev, end: ts });
    prev = ts;
  }
  if (horizon > prev + maxGap) uncovered.push({ start: prev, end: horizon });
  // C6: an explicit gap line is direct evidence the guard was blind at that
  // instant — it uncovers the whole interval between its real-sample
  // neighbors, even when their spacing passes the N x cadence test.
  for (const line of args.lines) {
    if (!('missing' in line)) continue;
    let prevReal = args.campaignOpenedTsMs;
    let nextReal = horizon;
    for (const ts of sampleTs) {
      if (ts < line.ts_ms) prevReal = Math.max(prevReal, ts);
      else if (ts > line.ts_ms) {
        nextReal = Math.min(nextReal, ts);
        break; // sampleTs is sorted; the first later sample is the neighbor
      }
    }
    uncovered.push({ start: prevReal, end: nextReal });
  }
  // C6: a torn tail was truncated at the last complete line — everything
  // from the last surviving sample to the horizon is uncovered.
  if (args.truncatedTail) {
    uncovered.push({
      start: sampleTs[sampleTs.length - 1] ?? args.campaignOpenedTsMs,
      end: horizon,
    });
  }
  // The newest sample ts bounds the horizon for live-block clipping.
  const newestSampleTs =
    sampleTs[sampleTs.length - 1] ?? args.campaignOpenedTsMs;
  const overlaps = (
    aStart: number,
    aEnd: number,
    bStart: number,
    bEnd: number,
  ): boolean => aStart <= bEnd && bStart <= aEnd;

  const verdicts = new Map<string, BlockContentionVerdict>();
  for (const block of args.blocks) {
    // Conservative interval; a still-live block clips to the horizon
    // (breach-closure timestamp for a closed-window evaluation).
    const end = block.endTsMs ?? Math.min(newestSampleTs, horizon);
    let verdict: BlockContentionVerdict = 'clean';
    for (const gap of uncovered) {
      if (overlaps(block.startTsMs, end, gap.start, gap.end))
        verdict = 'unknown';
    }
    for (const window of windows) {
      const windowEnd = window.endTsMs ?? Math.min(newestSampleTs, horizon);
      if (overlaps(block.startTsMs, end, window.startTsMs, windowEnd)) {
        verdict = 'invalid'; // known breach wins over uncovered
      }
    }
    verdicts.set(block.block_id, verdict);
  }
  return verdicts;
}

export interface SamplerArgs {
  readonly campaignDir: string;
  readonly probe: HostStatsProbe;
  readonly clock: Clock;
  readonly thresholds: readonly ResolvedThreshold[];
  readonly sustainK: number;
  readonly cadenceMs: number;
  /** The REGISTERED fingerprint's cpu_cores (C6) — the sampler's live
   *  threshold evaluation normalizes by the frozen count too. */
  readonly cpuCores: number;
  readonly onBreachEntry: (metrics: readonly string[]) => void;
  readonly onBreachExit: (window: BreachWindow) => void;
  readonly onSampleError: (err: unknown) => void;
}

/** The timer-driven sampler: reads the host-stats probe at the registered
 *  cadence, appends one fsynced JSON line per sample, detects symmetric
 *  K-sustained breach edges, and hands closed windows to the dispatcher —
 *  fsyncing the exit sample BEFORE notification (pinned order). */
export class ContentionSampler {
  private readonly args: SamplerArgs;
  private stopping = false;
  private stopResolve: (() => void) | null = null;
  // Resolved by stop(): races the parked cadence sleep so the loop observes
  // stopping promptly — a FakeClock never advances on its own, and stop()
  // must not depend on the test driving time forward.
  private readonly stopSignal = new Promise<void>((resolve) => {
    this.stopResolve = resolve;
  });
  private crossedRun = 0;
  private crossedMetrics: string[] = [];
  private openSince: number | null = null;
  private inBoundsRun = 0;

  constructor(args: SamplerArgs) {
    this.args = args;
  }

  /** Returns the run loop's promise (tests await it after stop()). */
  start(): Promise<void> {
    return this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopResolve?.();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const nowMs = clockNowMs(this.args.clock);
      try {
        const sample = this.args.probe.sample(nowMs);
        const violated = thresholdViolations(
          sample,
          this.args.thresholds,
          this.args.cpuCores,
        );
        // Edge tracking is PURE here; the entry/exit notification is
        // deferred until AFTER the sample line is appended + fsynced —
        // the pinned order: the exit sample is DURABLE before the
        // dispatcher's resolution batch re-reads the sidecar.
        const notify = this.trackEdges(nowMs, violated);
        const breach =
          this.openSince !== null
            ? (this.crossedMetricsAtOpen ?? violated)
            : [];
        appendSidecarLine(this.args.campaignDir, {
          ts_ms: sample.ts_ms,
          load1: sample.load1,
          mem_available_bytes: sample.mem_available_bytes,
          swap_used_bytes: sample.swap_used_bytes,
          process_count: sample.process_count,
          disk_free_bytes: sample.disk_free_bytes,
          breach,
        });
        notify?.();
      } catch (err) {
        // Missing-sample policy: record the gap; the dispatcher sees it via
        // coverage; ENOSPC here reports into the pause path (onSampleError).
        appendSidecarLineSafe(
          this.args.campaignDir,
          { ts_ms: nowMs, missing: true },
          this.args.onSampleError,
        );
        this.args.onSampleError(err);
      }
      await Promise.race([
        this.args.clock.sleepUntil(
          this.args.clock.now() + this.args.cadenceMs / 1000,
        ),
        this.stopSignal,
      ]);
    }
  }

  private crossedMetricsAtOpen: string[] | null = null;

  /** Pure edge tracking: mutates the runs/window state and returns the
   *  DEFERRED notification (entry or exit) for the caller to fire after the
   *  sample line is durable — never notifies inline. */
  private trackEdges(nowMs: number, violated: string[]): (() => void) | null {
    const { sustainK } = this.args;
    if (this.openSince === null) {
      if (violated.length > 0) {
        this.crossedRun += 1;
        this.crossedMetrics = [
          ...new Set([...this.crossedMetrics, ...violated]),
        ];
        if (this.crossedRun >= sustainK) {
          this.openSince = nowMs;
          this.crossedMetricsAtOpen = [...this.crossedMetrics];
          this.inBoundsRun = 0;
          const metrics = this.crossedMetricsAtOpen;
          return () => this.args.onBreachEntry(metrics);
        }
      } else {
        this.crossedRun = 0;
        this.crossedMetrics = [];
      }
      return null;
    }
    if (violated.length === 0) {
      this.inBoundsRun += 1;
      if (this.inBoundsRun >= sustainK) {
        const window: BreachWindow = {
          startTsMs: this.openSince,
          endTsMs: nowMs,
          metrics: this.crossedMetricsAtOpen ?? [],
        };
        this.openSince = null;
        this.crossedMetricsAtOpen = null;
        this.crossedRun = 0;
        this.crossedMetrics = [];
        this.inBoundsRun = 0;
        // Fired by the caller AFTER the exit sample is appended + fsynced
        // (pinned order: fsync-before-closed-window-notify).
        return () => this.args.onBreachExit(window);
      }
    } else {
      this.inBoundsRun = 0;
    }
    return null;
  }
}

function appendSidecarLineSafe(
  campaignDir: string,
  line: SidecarLine,
  onError: (err: unknown) => void,
): void {
  try {
    appendSidecarLine(campaignDir, line);
  } catch (err) {
    onError(err); // the gap could not be recorded — the pause path owns it
  }
}
