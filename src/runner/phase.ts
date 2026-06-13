import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The live phase vocabulary the runner owns. `grade` is intentionally absent
// (build spec: the gauntlet event stream carries no grade-start marker; done is
// signalled by verdict.json appearing, not a phase).
export type RunPhase = 'setup' | 'agent' | 'checks';

// Write <runDir>/phase.json at a boundary the runner owns. `pid` is the
// `quorum run` process id; the dashboard uses it for liveness (phase mtime is
// not a liveness signal — a phase can last tens of minutes). The file stops
// updating once verdict.json is written (verdict.json is the done signal).
export function writePhase(runDir: string, phase: RunPhase): void {
  const body = {
    phase,
    updated_at: new Date().toISOString(),
    pid: process.pid,
  };
  writeFileSync(join(runDir, 'phase.json'), `${JSON.stringify(body)}\n`);
}
