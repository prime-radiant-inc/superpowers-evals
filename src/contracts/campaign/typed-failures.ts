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

/** Initial instrument-cause vocabulary (pinned here). The grader causes are
 *  the ones the parent names explicitly; the D3 classifier's RunErrorStage
 *  table closes the set. Unknown causes stay indeterminate and are never
 *  replaced. */
export const INSTRUMENT_CAUSES = [
  'grader_billing_exhausted',
  'grader_rate_limited',
  'subject_spawn_failed',
  'subject_crashed',
  'capture_failed',
  'checks_crashed',
] as const;
export type InstrumentCause = (typeof INSTRUMENT_CAUSES)[number];
