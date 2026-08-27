// src/contracts/campaign/typed-failures.ts
// The closed map composer-outcome -> {instrument (replace), evidence
// (indeterminate/pass/fail), aborted, shortfall} is a published kernel
// deliverable (parent Typed failures). D1 pins the type surface shared by
// the journal schema, the D3 classifier, and D4 report accounting; the D3
// classifier completes the closed cause set table-driven over RunErrorStage.

export const FAILURE_CLASSES = [
  'instrument',
  'evidence',
  'aborted',
  'shortfall',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** The closed instrument-cause vocabulary (D-10 classifier table + R-CLS-5):
 *  D1's six pinned causes plus the four E7 additions. Unknown causes stay
 *  indeterminate and are never replaced. */
export const INSTRUMENT_CAUSES = [
  'grader_billing_exhausted',
  'grader_rate_limited',
  'subject_spawn_failed',
  'subject_crashed',
  'capture_failed',
  'checks_crashed',
  // E7 additions (D3 spec classifier table rows 3, 4, 5, 7 — ratified):
  'grader_crashed',
  'grader_misconfigured',
  'setup_failed',
  'subject_rate_limited',
] as const;
export type InstrumentCause = (typeof INSTRUMENT_CAUSES)[number];

/** E7.2: the closed block-scoped replacement-reason set. The instrument
 *  causes plus the rerun/validity reasons; additions remain platform PRs. */
export const BLOCK_REPLACEMENT_REASONS = [
  ...INSTRUMENT_CAUSES,
  'dispatcher_restart',
  'snapshot_drift',
  'storage_failure',
  'skew_refill',
  'exposure_audit',
  'contention',
] as const;
export type BlockReplacementReason = (typeof BLOCK_REPLACEMENT_REASONS)[number];
