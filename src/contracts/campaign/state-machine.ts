// src/contracts/campaign/state-machine.ts
// Three-valued transitions (pinned by the D1 spec): apply | ignore-late |
// reject. The parent's retained-evidence design guarantees late events — a
// skew-excluded run still completes, and the innocent arm of a replaced
// block may already be completed when its sibling fails — so a two-valued
// table would make canonical event streams illegal.

import { type CampaignUniverse, sealPredicateHolds } from './crash-windows.ts';
import type { JournalEvent, JournalEventType } from './journal-events.ts';

export const SAMPLE_STATES = [
  'planned',
  'admitted',
  'spawned',
  'exposed',
  'completed',
  'instrument_failed',
  'aborted',
  'skew_excluded',
  'excluded_block_replaced',
  'exhausted',
  'budget_stopped',
] as const;
export type SampleState = (typeof SAMPLE_STATES)[number];

export const TERMINAL_STATES = [
  'completed',
  'instrument_failed',
  'aborted',
  'skew_excluded',
  'excluded_block_replaced',
  'exhausted',
  'budget_stopped',
] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** E7.1 re-entry sources: the three states a live block's samples can hold
 *  at kill time (partial predecessors included). */
export const REENTRY_STATES = [
  'aborted',
  'completed',
  'instrument_failed',
] as const;

export type TransitionResult = 'apply' | 'ignore-late' | 'reject';
export type TransitionOutcome =
  | { result: 'apply'; next: SampleState }
  | { result: 'ignore-late' }
  | { result: 'reject' };

/** The reducer's typed discriminated input: a journal event's {type, payload}
 *  projection, distributed so each type keeps its own payload shape. A full
 *  JournalEvent (envelope included) is structurally assignable. */
type EventInput<E> = E extends {
  type: infer T extends string;
  payload: infer P;
}
  ? { readonly type: T; readonly payload: P }
  : never;
export type JournalEventInput = EventInput<JournalEvent>;

const apply = (next: SampleState): TransitionOutcome => ({
  result: 'apply',
  next,
});
const LATE: TransitionOutcome = { result: 'ignore-late' };
const REJECT: TransitionOutcome = { result: 'reject' };

function isTerminal(state: SampleState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** Advance one sample by one typed journal event. Block-scoped events
 *  (block_admitted, skew_excluded, aborted) apply per sample of the block;
 *  callers fan them out. Payload-sensitive edges (sample_disposition)
 *  discriminate on the payload, never on the event name alone. */
export function applySampleEvent(
  state: SampleState,
  event: JournalEventInput,
): TransitionOutcome {
  switch (event.type) {
    case 'block_admitted':
      // E7.1: rerun re-entry applies per roster sample of the rerun instance.
      if (event.payload.rerun_of !== undefined) {
        return (REENTRY_STATES as readonly string[]).includes(state)
          ? apply('admitted')
          : REJECT;
      }
      return state === 'planned' ? apply('admitted') : REJECT;
    case 'attempt_created':
      // Binding only (sample <-> attempt), no state change — journaled
      // between admission and spawn (parent Identity: attempt ids are
      // journaled before spawn), so admitted is the only legal source.
      return state === 'admitted' ? apply('admitted') : REJECT;
    case 'run_allocated':
      return state === 'admitted' ? apply('spawned') : REJECT;
    case 'exposure_started':
      if (state === 'spawned') return apply('exposed');
      if (state === 'skew_excluded') return LATE; // fast-arm ordering
      return REJECT;
    case 'run_completed':
      if (state === 'exposed') return apply('completed');
      // Retained-evidence semantics: the run dir is kept and
      // journal-referenced either way.
      return isTerminal(state) ? LATE : REJECT;
    case 'instrument_failure':
      if (state === 'spawned' || state === 'exposed') {
        return apply('instrument_failed');
      }
      if (state === 'excluded_block_replaced') return LATE;
      return REJECT;
    case 'sample_disposition': {
      if (event.payload.disposition !== 'excluded_block_replaced') {
        // included: a seal-time inclusion record on a completed sample —
        // a non-mutating bind, never the replacement edge.
        return state === 'completed' ? apply('completed') : REJECT;
      }
      // Defensive re-check of the schema's iff: the replacement edge must
      // name its superseding sample even on a hand-built event.
      const superseded: unknown = (event.payload as { superseded_by?: unknown })
        .superseded_by;
      if (typeof superseded !== 'string' || superseded === '') return REJECT;
      // The innocent arm's override; its run dir is retained. E7.1 adds
      // admitted to the shipped sources (a sibling can fail after spawning
      // while another sample is still admitted).
      if (
        state === 'admitted' ||
        state === 'spawned' ||
        state === 'exposed' ||
        state === 'completed'
      ) {
        return apply('excluded_block_replaced');
      }
      return REJECT;
    }
    case 'skew_excluded':
      // Fail-closed absence: a sample whose exposure never established can
      // still be skew-excluded from spawned (exposure-measurement contract).
      if (state === 'exposed' || state === 'spawned') {
        return apply('skew_excluded');
      }
      // E7.1 terminal-tolerant fan-out: retained-evidence semantics for the
      // completed sibling of a partial-block exclusion.
      if (isTerminal(state)) return LATE;
      return REJECT;
    case 'slot_exhausted':
      return state === 'planned' ? apply('exhausted') : REJECT;
    case 'budget_stopped':
      // planned edge is the parent's; admitted extension is the D1 pin
      // (proposed parent erratum E3).
      if (state === 'planned' || state === 'admitted') {
        return apply('budget_stopped');
      }
      return REJECT;
    case 'aborted':
      if (state === 'admitted' || state === 'spawned' || state === 'exposed') {
        return apply('aborted');
      }
      // E7.1 terminal-tolerant fan-out: the canonical partial-block abort —
      // one arm completes, the dispatcher aborts the block.
      if (isTerminal(state)) return LATE;
      return REJECT;
    default:
      // Campaign-scoped and accounting events never touch sample state.
      return REJECT;
  }
}

export const CAMPAIGN_STATES = [
  'registered',
  'running',
  'sealing',
  'sealed',
  'cancelled',
  'storage_paused',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export type CampaignTransitionOutcome =
  | { result: 'apply'; next: CampaignState }
  | { result: 'reject' };

/** Campaign edge -> event mapping (pinned). `sealing` is a transient
 *  computation state (completeness predicate running) witnessed by `sealed`;
 *  it is entered by beginSealing, not by an event. The crash-window resolver
 *  covers post-predicate pre-report. */
export function applyCampaignEvent(
  state: CampaignState,
  eventType: JournalEventType,
): CampaignTransitionOutcome {
  const applyC = (next: CampaignState): CampaignTransitionOutcome => ({
    result: 'apply',
    next,
  });
  switch (state) {
    case 'registered':
      return eventType === 'campaign_opened'
        ? applyC('running')
        : { result: 'reject' };
    case 'running':
      if (eventType === 'campaign_cancelled') return applyC('cancelled');
      if (eventType === 'storage_paused') return applyC('storage_paused');
      if (
        eventType === 'block_admitted' ||
        eventType === 'attempt_created' ||
        eventType === 'budget_event'
      ) {
        return applyC('running'); // activity keeps it running
      }
      return { result: 'reject' };
    case 'storage_paused':
      // Derivation rule (pinned): first activity resumes; explicit cancel
      // still lands.
      if (
        eventType === 'block_admitted' ||
        eventType === 'attempt_created' ||
        eventType === 'budget_event'
      ) {
        return applyC('running');
      }
      if (eventType === 'campaign_cancelled') return applyC('cancelled');
      return { result: 'reject' };
    case 'sealing':
      return eventType === 'sealed' ? applyC('sealed') : { result: 'reject' };
    case 'sealed':
    case 'cancelled':
      return { result: 'reject' };
  }
}

/** running -> sealing, guarded by the full seal predicate: every registered
 *  sample of the frozen campaign universe is terminal in the journal prefix.
 *  Pure — the D3 sealer calls this before running the report; the edge is
 *  witnessed in the journal by the subsequent `sealed` event. */
export function beginSealing(
  state: CampaignState,
  universe: CampaignUniverse,
  events: readonly JournalEvent[],
): CampaignTransitionOutcome {
  if (state !== 'running') return { result: 'reject' };
  return sealPredicateHolds(universe, events)
    ? { result: 'apply', next: 'sealing' }
    : { result: 'reject' };
}
