/**
 * Async watcher that tails agy.log and fires teardown on a rate-limit signal.
 *
 * agy.log is the only deterministic continuous rate-limit signal: gauntlet does
 * not stream the agy tmux pane, so polling the log is the sole way to detect
 * RESOURCE_EXHAUSTED / 429 while the agy run is in flight.
 *
 * Port of quorum/agy_watch.py. The Python version is a `threading.Thread`
 * daemon; the TS version is a class with `start()`/`stop()` backed by a bun
 * async poll loop (NOT a busy thread). Semantics preserved: fire teardown once,
 * clean stop, no leaked timer.
 */

import * as fs from "node:fs";
import { killRunTmuxServer } from "./agy-teardown.ts";

// Substrings agy writes to its log/stderr when the Gemini Code Assist backend
// throttles. RESOURCE_EXHAUSTED is the definitive 429 signal; the others
// corroborate. Matched case-insensitively.
const AGY_RATE_LIMIT_SUBSTRINGS = ["resource_exhausted", "ratelimitexceeded"];
// A bare "429" matches hex trace IDs (e.g. 0x...e4291...), ports, and byte counts
// that pepper agy's streaming log, false-tripping the mid-run watcher into killing
// a healthy run. Require a word-boundaried HTTP-status 429 instead.
const AGY_429_RE = /\b429\b/;

/**
 * True if any of *texts* contains an unambiguous Code Assist rate-limit signal.
 *
 * Pure predicate. Joins truthy texts with newlines, lowercases, and matches
 * the rate-limit substrings or a word-boundaried 429.
 *
 * Port of quorum/runner._agy_log_shows_rate_limit.
 */
export function agyLogShowsRateLimit(...texts: string[]): boolean {
  const blob = texts.filter((t) => t).join("\n").toLowerCase();
  if (AGY_RATE_LIMIT_SUBSTRINGS.some((sig) => blob.includes(sig))) return true;
  return AGY_429_RE.test(blob);
}

export type TeardownFn = (target: string) => unknown;

export interface AgyRateLimitWatcherOptions {
  /** Injectable teardown callback. Defaults to killRunTmuxServer. */
  teardown?: TeardownFn;
  /** Poll interval in milliseconds. Defaults to 500. */
  pollIntervalMs?: number;
}

/**
 * Poll *logPath* for rate-limit signals and call *teardown* on the first hit.
 *
 * Tolerates the log file being absent at start — agy creates it late. Assumes a
 * single append-only run log; log rotation / truncation under the watcher is out
 * of scope and would stall detection — acceptable because each run gets its own
 * fresh log.
 */
export class AgyRateLimitWatcher {
  private readonly logPath: string;
  // Opaque arg handed to teardown(); the default teardown expects the run dir
  // and globs to the scratch dir itself, so this is not a scratch dir.
  private readonly teardownTarget: string;
  private readonly teardown: TeardownFn;
  private readonly pollIntervalMs: number;

  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;

  /** Public state, written before `tripped` is set so readers always see it. */
  matchedText = "";
  tripped = false;

  constructor(logPath: string, teardownTarget: string, opts: AgyRateLimitWatcherOptions = {}) {
    this.logPath = logPath;
    this.teardownTarget = teardownTarget;
    this.teardown = opts.teardown ?? ((target: string) => killRunTmuxServer(target));
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
  }

  /** Whether the poll loop is currently active. */
  get running(): boolean {
    return this.loopPromise !== null;
  }

  /** Start the poll loop. Idempotent — a second call while running is a no-op. */
  start(): void {
    if (this.loopPromise !== null) return;
    this.stopRequested = false;
    this.loopPromise = this.runLoop();
  }

  /**
   * Signal the poll loop to exit and await it. Safe to call even if the watcher
   * was never started, and safe to call twice.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    // Wake an in-progress interval wait so stop returns promptly.
    if (this.wakeUp) this.wakeUp();
    const p = this.loopPromise;
    if (p) {
      await p;
    }
  }

  private async runLoop(): Promise<void> {
    let offset = 0;
    try {
      while (!this.stopRequested) {
        try {
          if (fs.existsSync(this.logPath)) {
            const fd = fs.openSync(this.logPath, "r");
            let newBytes: Buffer;
            try {
              const stat = fs.fstatSync(fd);
              const size = stat.size;
              const toRead = size - offset;
              if (toRead > 0) {
                const buf = Buffer.alloc(toRead);
                const read = fs.readSync(fd, buf, 0, toRead, offset);
                newBytes = buf.subarray(0, read);
              } else {
                newBytes = Buffer.alloc(0);
              }
            } finally {
              fs.closeSync(fd);
            }
            if (newBytes.length > 0) {
              const newText = newBytes.toString("utf8");
              offset += newBytes.length;
              if (agyLogShowsRateLimit(newText)) {
                this.matchedText = newText;
                this.teardown(this.teardownTarget);
                // Set flag last so readers always see matchedText and the
                // teardown side-effect before tripped=true.
                this.tripped = true;
                return;
              }
            }
          }
        } catch {
          // file disappeared mid-read; keep waiting
        }
        await this.waitInterval();
      }
    } finally {
      this.loopPromise = null;
    }
  }

  /** Sleep for the poll interval, but return early if stop() wakes us. */
  private waitInterval(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, this.pollIntervalMs);
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }
}
