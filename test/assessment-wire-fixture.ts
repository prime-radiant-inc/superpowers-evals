import { appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Test-only ownership of responses deliberately left pending during assessment.
export class DeferredResponses {
  private readonly pending = new Set<(response: Response) => void>();
  private released = false;

  response(): Promise<Response> {
    if (this.released)
      return Promise.resolve(new Response(null, { status: 503 }));
    return new Promise((resolve) => this.pending.add(resolve));
  }

  release(): void {
    this.released = true;
    for (const resolve of this.pending)
      resolve(new Response(null, { status: 503 }));
    this.pending.clear();
  }

  async stop(server: {
    stop(closeActiveConnections: boolean): Promise<void> | void;
  }): Promise<void> {
    // Explicit settlement removes the dependency on handler garbage collection.
    this.release();
    await server.stop(true);
  }
}

// Capture the real monotonic clock before individual fixtures spy on performance.
const monotonicNow = performance.now.bind(performance);
export class AssessmentFixtureEvidence {
  private readonly origin: number;
  private readonly watchdog: ReturnType<typeof setTimeout>;
  private watchdogFired = false;
  private readonly runDir: string;
  private readonly mode: string;
  private readonly now: () => number;

  constructor(
    runDir: string,
    mode: string,
    now = monotonicNow,
    watchdogMs = 13000,
  ) {
    this.runDir = runDir;
    this.mode = mode;
    this.now = now;
    this.origin = now();
    this.phase('fixture-created');
    this.watchdog = setTimeout(() => {
      this.watchdogFired = true;
      this.phase('pre-bound-watchdog');
      process.stderr.write(
        `Retained slow ${mode} assessment fixture: ${runDir}\n`,
      );
    }, watchdogMs);
    this.watchdog.unref();
  }

  phase(phase: string): void {
    appendFileSync(
      join(this.runDir, 'fixture-phases.jsonl'),
      `${JSON.stringify({
        phase,
        mode: this.mode,
        elapsedMs: this.now() - this.origin,
      })}\n`,
      { mode: 0o600 },
    );
  }

  // Called only after the awaited cleanup settles, including rejection.
  finish(assertionsCompleted: boolean, cleanupCompleted: boolean): void {
    this.phase(cleanupCompleted ? 'cleanup-completed' : 'cleanup-failed');
    clearTimeout(this.watchdog);
    const late = this.now() - this.origin >= 15000;
    if (assertionsCompleted && cleanupCompleted && !late && !this.watchdogFired)
      rmSync(this.runDir, { recursive: true, force: true });
    else {
      this.phase(
        late
          ? 'retained-after-deadline'
          : this.watchdogFired
            ? 'retained-after-watchdog'
            : 'retained-failure',
      );
      process.stderr.write(
        `Retained ${this.mode} assessment fixture: ${this.runDir}\n`,
      );
      // A successful wrapper removes its entire temp root. Fail a slow fixture
      // after cleanup so that wrapper cannot erase the retained evidence.
      if (assertionsCompleted && cleanupCompleted)
        throw new Error(
          `Assessment fixture crossed its evidence retention boundary: ${this.runDir}`,
        );
    }
  }
}
