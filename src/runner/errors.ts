import type { RunErrorStage } from '../contracts/verdict.ts';

// A staged invariant failure inside the runner pipeline. The stage drives the
// error-stage of the indeterminate verdict (coding standard 6.1); a bug is an
// exception, but a staged one so the composer can attribute it.
// erasableSyntaxOnly forbids constructor parameter properties (5.3), so the
// stage is an explicit field assigned in the body.
//
// Defined here, not in runner/index.ts, so context.ts imports it without a
// runner<->context cycle (mirrors how ProvisionError lives in agents/index.ts).
export class RunnerError extends Error {
  readonly stage: RunErrorStage;
  constructor(message: string, stage: RunErrorStage) {
    super(message);
    this.name = 'RunnerError';
    this.stage = stage;
  }
}
