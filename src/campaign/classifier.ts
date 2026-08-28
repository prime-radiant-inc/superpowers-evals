// Failure classifier (kernel D3, R-CLS-1..6): the CLOSED table-driven map
// ClassificationInput -> { class, cause? }, exhaustive over the product
// verdict outcome x RunErrorStage x exit class x child role x sensor
// evidence. First matching row wins; the final default row makes
// exhaustiveness structural. Unknown stays evidence (indeterminate), NEVER
// instrument — outcome-independence lives or dies on that trigger set.

import type {
  FailureClass,
  InstrumentCause,
} from '../contracts/campaign/typed-failures.ts';
import type { RunErrorStage } from '../contracts/verdict.ts';

export interface ClassificationInput {
  readonly outcome: 'pass' | 'fail' | 'indeterminate';
  readonly stage?: RunErrorStage;
  readonly exitClass: 'clean' | 'signal' | 'crash' | 'spawn-failed';
  readonly role: 'subject' | 'grader';
  readonly sensorEvidence:
    | 'none'
    | '429-match'
    | 'billing-exhaustion'
    | 'manifest-mismatch';
}

export interface Classification {
  readonly class: FailureClass;
  readonly cause?: InstrumentCause;
}

interface Row {
  readonly match: (input: ClassificationInput) => boolean;
  readonly class: FailureClass;
  readonly cause?: InstrumentCause;
}

/** The pinned v1 rows (spec classifier table), first-wins top-down. */
const ROWS: readonly Row[] = [
  {
    match: (i) => i.role === 'grader' && i.sensorEvidence === '429-match',
    class: 'instrument',
    cause: 'grader_rate_limited',
  },
  {
    match: (i) =>
      i.role === 'grader' && i.sensorEvidence === 'billing-exhaustion',
    class: 'instrument',
    cause: 'grader_billing_exhausted',
  },
  {
    match: (i) => i.stage === 'qa-agent-misconfigured',
    class: 'instrument',
    cause: 'grader_misconfigured',
  },
  {
    match: (i) => i.role === 'subject' && i.sensorEvidence === '429-match',
    class: 'instrument',
    cause: 'subject_rate_limited',
  },
  {
    match: (i) => i.stage === 'setup',
    class: 'instrument',
    cause: 'setup_failed',
  },
  {
    match: (i) => i.exitClass === 'spawn-failed',
    class: 'instrument',
    cause: 'subject_spawn_failed',
  },
  {
    match: (i) =>
      i.stage === 'gauntlet' &&
      (i.exitClass === 'signal' || i.exitClass === 'crash'),
    class: 'instrument',
    cause: 'grader_crashed',
  },
  {
    match: (i) =>
      i.role === 'subject' &&
      (i.exitClass === 'signal' || i.exitClass === 'crash') &&
      i.stage === undefined,
    class: 'instrument',
    cause: 'subject_crashed',
  },
  {
    match: (i) => i.stage === 'capture',
    class: 'instrument',
    cause: 'capture_failed',
  },
  {
    match: (i) => i.stage === 'checks',
    class: 'instrument',
    cause: 'checks_crashed',
  },
  {
    // Composer false-pass guard (parent Checks).
    match: (i) =>
      i.stage === 'compose' && i.sensorEvidence === 'manifest-mismatch',
    class: 'instrument',
    cause: 'checks_crashed',
  },
  { match: (i) => i.stage === 'stopped', class: 'aborted' },
  {
    match: (i) =>
      (i.outcome === 'pass' || i.outcome === 'fail') && i.stage === undefined,
    class: 'evidence',
  },
  // Default — every other combination: evidence (indeterminate), NEVER
  // instrument (R-CLS-4).
  { match: () => true, class: 'evidence' },
];

export function classifyFailure(input: ClassificationInput): Classification {
  for (const row of ROWS) {
    if (row.match(input)) {
      return row.cause === undefined
        ? { class: row.class }
        : { class: row.class, cause: row.cause };
    }
  }
  // Unreachable: the final row matches everything. Loud, never defaulted.
  throw new Error(
    'classifier table lost exhaustiveness — the default row must match',
  );
}
