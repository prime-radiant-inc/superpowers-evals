// src/contracts/campaign/crash-windows.ts
// Crash-window resolutions (parent Appendix B) as a pure function over a
// journal prefix: pre-run_allocated -> attempt void, re-admit;
// post-run_allocated without terminal -> kill pgid, block rerun;
// post-seal-predicate pre-report -> regenerate report (idempotent).

import type { JournalEvent } from './journal-events.ts';

export interface AttemptCrashWindow {
  readonly attempt_id: string;
  readonly resolution: 'void_attempt_readmit' | 'kill_pgid_rerun_block';
  readonly pgid?: number;
}

export interface CrashWindowReport {
  readonly attempts: AttemptCrashWindow[];
  /** 'regenerate_report' when every journaled attempt is terminal but no
   *  sealed event exists (process died post-predicate pre-report). */
  readonly campaign: 'regenerate_report' | 'none';
}

export function resolveCrashWindows(events: JournalEvent[]): CrashWindowReport {
  const allocated = new Map<string, number>(); // attempt_id -> pgid
  const created = new Set<string>();
  const sampleToAttempt = new Map<string, string>(); // sample_id -> attempt_id
  const terminal = new Set<string>();
  let sealed = false;

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case 'attempt_created':
        created.add(String(payload['attempt_id']));
        sampleToAttempt.set(
          String(payload['sample_id']),
          String(payload['attempt_id']),
        );
        break;
      case 'run_allocated':
        allocated.set(String(payload['attempt_id']), Number(payload['pgid']));
        break;
      case 'run_completed':
      case 'instrument_failure':
        terminal.add(String(payload['attempt_id']));
        break;
      case 'budget_stopped': {
        // Sample-scoped terminal: retire each stopped sample's attempt via
        // the attempt_created binding (misses are no-ops, not throws).
        const sampleIds = payload['sample_ids'];
        if (Array.isArray(sampleIds)) {
          for (const sampleId of sampleIds) {
            const attemptId = sampleToAttempt.get(String(sampleId));
            if (attemptId !== undefined) terminal.add(attemptId);
          }
        }
        break;
      }
      case 'sample_disposition': {
        // Sample-scoped terminal (the innocent arm's override): retire the
        // disposed sample's attempt (misses are no-ops, not throws).
        const attemptId = sampleToAttempt.get(String(payload['sample_id']));
        if (attemptId !== undefined) terminal.add(attemptId);
        break;
      }
      case 'aborted':
      case 'skew_excluded':
        // Block-scoped payloads (block_id only): this layer has no
        // block->samples map, so these cannot resolve to attempts here. D3's
        // block rule covers them during recovery.
        break;
      case 'sealed':
        sealed = true;
        break;
      default:
        break;
    }
  }

  const attempts: AttemptCrashWindow[] = [];
  for (const attemptId of created) {
    if (terminal.has(attemptId)) continue;
    const pgid = allocated.get(attemptId);
    if (pgid !== undefined) {
      attempts.push({
        attempt_id: attemptId,
        resolution: 'kill_pgid_rerun_block',
        pgid,
      });
    } else {
      attempts.push({
        attempt_id: attemptId,
        resolution: 'void_attempt_readmit',
      });
    }
  }

  const campaign =
    !sealed && created.size > 0 && attempts.length === 0
      ? 'regenerate_report'
      : 'none';
  return { attempts, campaign };
}
