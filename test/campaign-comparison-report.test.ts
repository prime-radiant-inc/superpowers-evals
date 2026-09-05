import { expect, test } from 'bun:test';
import {
  foldTransition,
  initialProjection,
} from '../src/campaign/execution-state.ts';
import { foldComparisonReport } from '../src/campaign/report.ts';
import { mixedComparisonFixture } from './fixtures/core-comparison/report-fixture.ts';

test('literal twelve-attempt oracle preserves fixed slots and quantity-matched pairs', () => {
  const fixture = mixedComparisonFixture();
  const report = foldComparisonReport(fixture);
  expect(report.comparisons).toEqual(fixture.expected.comparisons);
  expect(report.accounting).toEqual(fixture.expected.accounting);
  expect(
    report.excluded_accounting.superseded.combined_cost_usd.known_subtotal,
  ).toBe(7.7);
  expect(
    report.excluded_accounting.superseded.wall_seconds.known_subtotal,
  ).toBe(70);
  expect(
    report.excluded_accounting.unaccepted.combined_cost_usd.known_subtotal,
  ).toBe(0.9);
  expect(report.attempts).toHaveLength(12);
});

test('active prefixes hide accepted and raw behavioral evidence but retain accounting', () => {
  const f = mixedComparisonFixture();
  f.state = f.transitions
    .slice(0, -1)
    .reduce(foldTransition, initialProjection(f.experiment));
  const report = foldComparisonReport(f);
  expect(report.behavior_available).toBe(false);
  expect(report.comparisons).toEqual([]);
  expect(
    report.attempts.every(
      (a) =>
        a.accepted_outcome === null &&
        a.evidence.observed_outcome === null &&
        a.evidence.gauntlet === null &&
        a.evidence.checks === null,
    ),
  ).toBe(true);
  expect(report.accounting.subject_cost_usd.known_subtotal).toBe(136);
});

test('missing positive validity support excludes analysis without erasing observations or spend', () => {
  const f = mixedComparisonFixture();
  f.validityByBlock.set('c1-r1', {
    available: false,
    reasons: ['digest mismatch'],
  });
  const report = foldComparisonReport(f);
  expect(report.comparisons[0]!.arms[0]!.no_usable_result).toBe(2);
  expect(report.accounting.subject_cost_usd.known_subtotal).toBe(136);
  expect(report.attempts[0]!.accepted_outcome).toBe('pass');
});

test('a partial role retains known spend but cannot enter matched totals', () => {
  const f = mixedComparisonFixture();
  const evidence = f.evidenceByAttempt.get('c1-r1-b-1')!;
  evidence.subject_cost_complete = false;
  const report = foldComparisonReport(f);
  expect(report.accounting.subject_cost_usd).toEqual({
    known_subtotal: 136,
    observed: 8,
    attempts: 12,
    complete: false,
  });
  expect(report.comparisons[0]!.paired.subject_cost_usd).toEqual({
    n: 0,
    baseline_mean: null,
    treatment_mean: null,
    mean_delta: null,
  });
});

test('a determinate accepted observation needs authenticated supporting verdict evidence', () => {
  const f = mixedComparisonFixture();
  f.evidenceByAttempt.get('c1-r1-b-1')!.observed_outcome = null;
  const r = foldComparisonReport(f);
  expect(r.comparisons[0]!.arms[0]!.no_usable_result).toBe(2);
  expect(r.accounting.subject_cost_usd.known_subtotal).toBe(136);
});
test('intentionally indeterminate accepted outcomes cannot be promoted by passing artifacts', () => {
  const f = mixedComparisonFixture();
  f.evidenceByAttempt.get('c1-r3-b-2')!.observed_outcome = 'pass';
  const r = foldComparisonReport(f);
  expect(r.comparisons[0]!.arms[0]!.indeterminate).toBe(1);
  expect(r.comparisons[0]!.paired.pass_rate.n).toBe(2);
});

test('the shared transition fold rejects cross-arm replacement, reused reserves and duplicate attempts', () => {
  for (const damage of ['cross-arm', 'reused', 'duplicate'] as const) {
    const f = mixedComparisonFixture();
    const transitions = structuredClone(f.transitions);
    const replacement = transitions.find((t) => t.type === 'block_replaced')!;
    if (replacement.type !== 'block_replaced') throw new Error('fixture');
    const activation = replacement.payload.activation;
    if (damage === 'cross-arm')
      activation.attempts[1]!.identity.sample_id =
        activation.attempts[0]!.identity.sample_id;
    if (damage === 'duplicate')
      activation.attempts[1]!.identity.execution_attempt_id =
        activation.attempts[0]!.identity.execution_attempt_id;
    if (damage === 'reused') activation.reserve_id = 'c2-reserve';
    expect(() =>
      transitions.reduce(foldTransition, initialProjection(f.experiment)),
    ).toThrow();
  }
});
