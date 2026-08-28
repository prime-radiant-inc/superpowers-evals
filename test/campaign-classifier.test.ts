import { expect, test } from 'bun:test';
import {
  type ClassificationInput,
  classifyFailure,
} from '../src/campaign/classifier.ts';
import type {
  FailureClass,
  InstrumentCause,
} from '../src/contracts/campaign/typed-failures.ts';

import {
  RUN_ERROR_STAGES,
  type RunErrorStage,
} from '../src/contracts/verdict.ts';

const OUTCOMES = ['pass', 'fail', 'indeterminate'] as const;
const EXIT_CLASSES = ['clean', 'signal', 'crash', 'spawn-failed'] as const;
const ROLES = ['subject', 'grader'] as const;
const EVIDENCE = [
  'none',
  '429-match',
  'billing-exhaustion',
  'manifest-mismatch',
] as const;

function inputs(): ClassificationInput[] {
  const all: ClassificationInput[] = [];
  const stages: (RunErrorStage | undefined)[] = [
    undefined,
    ...RUN_ERROR_STAGES,
  ];
  for (const outcome of OUTCOMES) {
    for (const stage of stages) {
      for (const exitClass of EXIT_CLASSES) {
        for (const role of ROLES) {
          for (const sensorEvidence of EVIDENCE) {
            all.push({
              outcome,
              ...(stage !== undefined ? { stage } : {}),
              exitClass,
              role,
              sensorEvidence,
            });
          }
        }
      }
    }
  }
  return all;
}

test('the pinned 14 rows, first-match-wins', () => {
  // Row 1: grader 429 -> grader_rate_limited.
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      stage: 'gauntlet',
      exitClass: 'clean',
      role: 'grader',
      sensorEvidence: '429-match',
    }),
  ).toEqual({ class: 'instrument', cause: 'grader_rate_limited' });
  // Row 2: grader billing exhaustion.
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      stage: 'gauntlet',
      exitClass: 'clean',
      role: 'grader',
      sensorEvidence: 'billing-exhaustion',
    }),
  ).toEqual({ class: 'instrument', cause: 'grader_billing_exhausted' });
  // Row 3: qa-agent-misconfigured.
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      stage: 'qa-agent-misconfigured',
      exitClass: 'clean',
      role: 'grader',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'instrument', cause: 'grader_misconfigured' });
  // Row 4: throttled SUBJECT — outcome-independent (a recovered/pass outcome
  // does not condition the instrument fault; ratified Round-4 S-13).
  expect(
    classifyFailure({
      outcome: 'pass',
      exitClass: 'clean',
      role: 'subject',
      sensorEvidence: '429-match',
    }),
  ).toEqual({ class: 'instrument', cause: 'subject_rate_limited' });
  // Row 5: setup.
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      stage: 'setup',
      exitClass: 'clean',
      role: 'subject',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'instrument', cause: 'setup_failed' });
  // Row 6: spawn-failed.
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      exitClass: 'spawn-failed',
      role: 'subject',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'instrument', cause: 'subject_spawn_failed' });
  // Row 7: gauntlet stage + signal/crash exit -> grader_crashed.
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      stage: 'gauntlet',
      exitClass: 'crash',
      role: 'grader',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'instrument', cause: 'grader_crashed' });
  // Row 8: subject signal/crash without a stage -> subject_crashed.
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      exitClass: 'signal',
      role: 'subject',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'instrument', cause: 'subject_crashed' });
  // Row 9 + 10: capture, checks.
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      stage: 'capture',
      exitClass: 'clean',
      role: 'subject',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'instrument', cause: 'capture_failed' });
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      stage: 'checks',
      exitClass: 'crash',
      role: 'subject',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'instrument', cause: 'checks_crashed' });
  // Row 11: composer false-pass guard.
  expect(
    classifyFailure({
      outcome: 'pass',
      stage: 'compose',
      exitClass: 'clean',
      role: 'subject',
      sensorEvidence: 'manifest-mismatch',
    }),
  ).toEqual({ class: 'instrument', cause: 'checks_crashed' });
  // Row 12: stopped -> aborted class.
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      stage: 'stopped',
      exitClass: 'clean',
      role: 'subject',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'aborted' });
  // Row 13: determinate outcomes with no stage error -> evidence.
  expect(
    classifyFailure({
      outcome: 'pass',
      exitClass: 'clean',
      role: 'subject',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'evidence' });
  expect(
    classifyFailure({
      outcome: 'fail',
      exitClass: 'clean',
      role: 'subject',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'evidence' });
  // Row 14 default: unknown stays evidence — NEVER instrument (R-CLS-4).
  expect(
    classifyFailure({
      outcome: 'indeterminate',
      stage: 'unknown',
      exitClass: 'clean',
      role: 'subject',
      sensorEvidence: 'none',
    }),
  ).toEqual({ class: 'evidence' });
});

// Test-local mirror of the pinned v1 table (spec failure-classifier
// table, first-wins top-down). Deliberately NOT shared with the
// implementation: the test owns the expectation, so reordering or editing
// the row array in src/campaign/classifier.ts cannot silently change
// which row a given input selects.
const PINNED_ROWS: readonly {
  readonly match: (input: ClassificationInput) => boolean;
  readonly expected: {
    readonly class: FailureClass;
    readonly cause?: InstrumentCause;
  };
}[] = [
  {
    match: (i) => i.role === 'grader' && i.sensorEvidence === '429-match',
    expected: { class: 'instrument', cause: 'grader_rate_limited' },
  },
  {
    match: (i) =>
      i.role === 'grader' && i.sensorEvidence === 'billing-exhaustion',
    expected: { class: 'instrument', cause: 'grader_billing_exhausted' },
  },
  {
    match: (i) => i.stage === 'qa-agent-misconfigured',
    expected: { class: 'instrument', cause: 'grader_misconfigured' },
  },
  {
    match: (i) => i.role === 'subject' && i.sensorEvidence === '429-match',
    expected: { class: 'instrument', cause: 'subject_rate_limited' },
  },
  {
    match: (i) => i.stage === 'setup',
    expected: { class: 'instrument', cause: 'setup_failed' },
  },
  {
    match: (i) => i.exitClass === 'spawn-failed',
    expected: { class: 'instrument', cause: 'subject_spawn_failed' },
  },
  {
    match: (i) =>
      i.stage === 'gauntlet' &&
      (i.exitClass === 'signal' || i.exitClass === 'crash'),
    expected: { class: 'instrument', cause: 'grader_crashed' },
  },
  {
    match: (i) =>
      i.role === 'subject' &&
      (i.exitClass === 'signal' || i.exitClass === 'crash') &&
      i.stage === undefined,
    expected: { class: 'instrument', cause: 'subject_crashed' },
  },
  {
    match: (i) => i.stage === 'capture',
    expected: { class: 'instrument', cause: 'capture_failed' },
  },
  {
    match: (i) => i.stage === 'checks',
    expected: { class: 'instrument', cause: 'checks_crashed' },
  },
  {
    match: (i) =>
      i.stage === 'compose' && i.sensorEvidence === 'manifest-mismatch',
    expected: { class: 'instrument', cause: 'checks_crashed' },
  },
  { match: (i) => i.stage === 'stopped', expected: { class: 'aborted' } },
  {
    match: (i) =>
      (i.outcome === 'pass' || i.outcome === 'fail') && i.stage === undefined,
    expected: { class: 'evidence' },
  },
  { match: () => true, expected: { class: 'evidence' } },
];

test('exhaustive product: every input selects the pinned first-match row (class + cause)', () => {
  for (const input of inputs()) {
    const row = PINNED_ROWS.find((r) => r.match(input));
    if (row === undefined) {
      throw new Error('test-local pinned table lost its default row');
    }
    const result = classifyFailure(input);
    expect(result.class).toBe(row.expected.class);
    expect(result.cause).toBe(row.expected.cause);
    // Codomain closed, independent of the mirror's own vocabulary.
    expect(['instrument', 'evidence', 'aborted', 'shortfall']).toContain(
      result.class,
    );
    if (result.class === 'instrument') expect(result.cause).toBeDefined();
    // R-CLS-4: no stage, clean exit, no sensor evidence -> never instrument.
    if (
      input.stage === undefined &&
      input.exitClass === 'clean' &&
      input.sensorEvidence === 'none'
    ) {
      expect(result.class).toBe('evidence');
    }
  }
});
