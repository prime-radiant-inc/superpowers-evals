import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FinalVerdict } from '../contracts/verdict.ts';

export interface StoppedIdentity {
  readonly scenario: string;
  readonly codingAgent: string;
  readonly startedAt: string;
}

// The verdict written when a run is interrupted by SIGINT (dashboard Stop).
// indeterminate + error.stage "stopped" (a valid RUN_ERROR_STAGES member). The
// cell resolves to indeterminate instead of vanishing under the dead-pid rule.
export function buildStoppedVerdict(id: StoppedIdentity): FinalVerdict {
  return {
    schema: 1,
    final: 'indeterminate',
    final_reason: 'run stopped before completion',
    gauntlet: null,
    checks: [],
    error: { stage: 'stopped', message: 'run interrupted by SIGINT' },
    economics: null,
    scenario: id.scenario,
    coding_agent: id.codingAgent,
    started_at: id.startedAt,
    finished_at: new Date().toISOString(),
  };
}

export function writeStoppedVerdict(runDir: string, id: StoppedIdentity): void {
  writeFileSync(
    join(runDir, 'verdict.json'),
    `${JSON.stringify(buildStoppedVerdict(id), null, 2)}\n`,
  );
}
