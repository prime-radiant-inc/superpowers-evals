import { expect, test } from 'bun:test';
import {
  type ClassificationInput,
  classifyFailure,
} from '../src/campaign/classifier.ts';
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

test('exhaustive product: every combination classifies, codomain closed, default never instrument', () => {
  for (const input of inputs()) {
    const result = classifyFailure(input);
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
