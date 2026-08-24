// src/contracts/campaign/state-machine.ts
// Three-valued transitions (pinned by the D1 spec): apply | ignore-late |
// reject. The parent's retained-evidence design guarantees late events — a
// skew-excluded run still completes, and the innocent arm of a replaced
// block may already be completed when its sibling fails — so a two-valued
// table would make canonical event streams illegal.

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

export type TransitionResult = 'apply' | 'ignore-late' | 'reject';
export type TransitionOutcome =
  | { result: 'apply'; next: SampleState }
  | { result: 'ignore-late' }
  | { result: 'reject' };

const apply = (next: SampleState): TransitionOutcome => ({
  result: 'apply',
  next,
});
const LATE: TransitionOutcome = { result: 'ignore-late' };
const REJECT: TransitionOutcome = { result: 'reject' };

function isTerminal(state: SampleState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** Advance one sample by one journal event type. Block-scoped events
 *  (block_admitted, skew_excluded, aborted) apply per sample of the block;
 *  callers fan them out. */
export function applySampleEvent(
  state: SampleState,
  eventType: string,
): TransitionOutcome {
  switch (eventType) {
    case 'block_admitted':
      return state === 'planned' ? apply('admitted') : REJECT;
    case 'attempt_created':
      // Binding only (sample <-> attempt); no state change outside terminals.
      return isTerminal(state) ? REJECT : apply(state);
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
    case 'sample_disposition':
      // The innocent arm's override; superseded_by set by the payload.
      if (state === 'spawned' || state === 'exposed' || state === 'completed') {
        return apply('excluded_block_replaced');
      }
      return REJECT;
    case 'skew_excluded':
      // Fail-closed absence: a sample whose exposure never established can
      // still be skew-excluded from spawned (exposure-measurement contract).
      if (state === 'exposed' || state === 'spawned') {
        return apply('skew_excluded');
      }
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
 *  the crash-window resolver covers post-predicate pre-report. */
export function applyCampaignEvent(
  state: CampaignState,
  eventType: string,
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
