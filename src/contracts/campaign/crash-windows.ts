// src/contracts/campaign/crash-windows.ts
// Crash-window resolutions (parent Appendix B) as a pure function over the
// frozen campaign universe plus a journal prefix: pre-run_allocated ->
// attempt void, re-admit; post-run_allocated without terminal -> kill pgid,
// block rerun; post-seal-predicate pre-report -> regenerate report
// (idempotent). The resolver must know the registered block/sample universe
// — judging only observed attempts would claim the report window on any
// one-attempt prefix and rerun blocks that block-terminal events (aborted,
// skew_excluded) already retired.

import type { JournalEvent } from './journal-events.ts';

/** The registered campaign's frozen block/sample mapping. A parsed Campaign
 *  document (src/contracts/campaign/campaign.ts) satisfies this
 *  structurally. */
export interface CampaignUniverse {
  readonly samples: ReadonlyArray<{ readonly sample_id: string }>;
  readonly blocks: ReadonlyArray<{
    readonly block_id: string;
    readonly sample_ids: readonly string[];
  }>;
}

export interface AttemptCrashWindow {
  readonly attempt_id: string;
  readonly resolution: 'void_attempt_readmit' | 'kill_pgid_rerun_block';
  readonly pgid?: number;
}

export interface CrashWindowReport {
  readonly attempts: AttemptCrashWindow[];
  /** 'regenerate_report' when EVERY registered sample is terminal but no
   *  sealed event exists (process died post-predicate pre-report). A
   *  cancelled campaign never regenerates. */
  readonly campaign: 'regenerate_report' | 'none';
}

interface PrefixFold {
  /** Attempt ids in creation order. */
  readonly created: Set<string>;
  readonly attemptSample: Map<string, string>;
  readonly allocated: Map<string, number>; // attempt_id -> pgid
  /** sample_id -> its latest-created attempt: the sample's current attempt
   *  under the parent Identity contract. */
  readonly currentAttempt: Map<string, string>;
  /** Attempts retired by their own terminal event (run_completed,
   *  instrument_failure). Attempt-scoped: a stale terminal for a superseded
   *  attempt is quarantined here and never widens to the sample. */
  readonly terminalAttempts: Set<string>;
  /** Samples retired by sample/block-terminal facts (slot_exhausted,
   *  budget_stopped, aborted, skew_excluded, replacement disposition) —
   *  independent of attempt ordering. */
  readonly terminalSamples: Set<string>;
  readonly sealed: boolean;
  readonly cancelled: boolean;
}

/** One pass over the prefix: attempt bindings, allocations, attempt-terminal
 *  and sample/block-terminal facts kept separate (block-scoped terminals fan
 *  out through the universe's block -> samples map), and campaign-terminal
 *  markers. Events naming unknown samples, blocks, or attempts are no-ops,
 *  never throws. */
function foldPrefix(
  universe: CampaignUniverse,
  events: readonly JournalEvent[],
): PrefixFold {
  const blockSamples = new Map<string, readonly string[]>(
    universe.blocks.map((block) => [block.block_id, block.sample_ids]),
  );
  const created = new Set<string>();
  const attemptSample = new Map<string, string>();
  const allocated = new Map<string, number>();
  const currentAttempt = new Map<string, string>();
  const terminalAttempts = new Set<string>();
  const terminalSamples = new Set<string>();
  let sealed = false;
  let cancelled = false;

  for (const event of events) {
    switch (event.type) {
      case 'attempt_created':
        created.add(event.payload.attempt_id);
        attemptSample.set(event.payload.attempt_id, event.payload.sample_id);
        currentAttempt.set(event.payload.sample_id, event.payload.attempt_id);
        break;
      case 'run_allocated':
        allocated.set(event.payload.attempt_id, event.payload.pgid);
        break;
      case 'run_completed':
      case 'instrument_failure':
        // Attempt-scoped terminality; unbound attempt ids stay no-ops.
        if (attemptSample.has(event.payload.attempt_id)) {
          terminalAttempts.add(event.payload.attempt_id);
        }
        break;
      case 'sample_disposition':
        // Payload-sensitive: only the replacement disposition is terminal;
        // included is a seal-time inclusion record.
        if (event.payload.disposition === 'excluded_block_replaced') {
          terminalSamples.add(event.payload.sample_id);
        }
        break;
      case 'slot_exhausted':
        terminalSamples.add(event.payload.sample_id);
        break;
      case 'budget_stopped':
        for (const sampleId of event.payload.sample_ids) {
          terminalSamples.add(sampleId);
        }
        break;
      case 'aborted':
      case 'skew_excluded':
        // Block-terminal: every sample of the block is terminal, so its
        // attempts must never be rerun.
        for (const sampleId of blockSamples.get(event.payload.block_id) ?? []) {
          terminalSamples.add(sampleId);
        }
        break;
      case 'campaign_cancelled':
        cancelled = true;
        break;
      case 'sealed':
        sealed = true;
        break;
      default:
        break;
    }
  }

  return {
    created,
    attemptSample,
    allocated,
    currentAttempt,
    terminalAttempts,
    terminalSamples,
    sealed,
    cancelled,
  };
}

/** A sample is terminal when a sample/block-terminal fact retired it, or when
 *  its CURRENT (latest-created) attempt reached a terminal event. A stale
 *  terminal for a superseded attempt never retires the newer attempt (parent
 *  Identity: stale late events are quarantined by attempt-id mismatch). */
function sampleTerminal(fold: PrefixFold, sampleId: string): boolean {
  if (fold.terminalSamples.has(sampleId)) return true;
  const current = fold.currentAttempt.get(sampleId);
  return current !== undefined && fold.terminalAttempts.has(current);
}

function allSamplesTerminal(
  universe: CampaignUniverse,
  fold: PrefixFold,
): boolean {
  return (
    universe.samples.length > 0 &&
    universe.samples.every((sample) => sampleTerminal(fold, sample.sample_id))
  );
}

/** The full seal predicate over a journal prefix: every registered sample of
 *  the frozen universe reached a terminal state. Vacuously-empty universes
 *  never satisfy it. */
export function sealPredicateHolds(
  universe: CampaignUniverse,
  events: readonly JournalEvent[],
): boolean {
  return allSamplesTerminal(universe, foldPrefix(universe, events));
}

export function resolveCrashWindows(
  universe: CampaignUniverse,
  events: readonly JournalEvent[],
): CrashWindowReport {
  const fold = foldPrefix(universe, events);

  const attempts: AttemptCrashWindow[] = [];
  // A cancelled campaign is terminal: nothing re-admits or reruns (D3's
  // recovery still kills journaled pgids first, unconditionally).
  if (!fold.cancelled) {
    for (const attemptId of fold.created) {
      const sampleId = fold.attemptSample.get(attemptId);
      if (sampleId === undefined) continue;
      // Only the sample's current (latest-created) attempt drives recovery;
      // a superseded attempt gets no action of its own — D3's recovery kills
      // journaled pgids first, unconditionally.
      if (fold.currentAttempt.get(sampleId) !== attemptId) continue;
      if (sampleTerminal(fold, sampleId)) continue;
      const pgid = fold.allocated.get(attemptId);
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
  }

  const campaign =
    !fold.sealed && !fold.cancelled && allSamplesTerminal(universe, fold)
      ? 'regenerate_report'
      : 'none';
  return { attempts, campaign };
}
