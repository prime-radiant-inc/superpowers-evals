import { expect, test } from 'bun:test';
import { foldComparisonReport } from '../src/campaign/report.ts';
import {
  ComparisonReportSchema,
  ReportSchema,
} from '../src/contracts/campaign/report.ts';
import { mixedComparisonFixture } from './fixtures/core-comparison/report-fixture.ts';

test('strict report rejects unknown keys, nonfinite quantities and zero-valued empty means', () => {
  const r = foldComparisonReport(mixedComparisonFixture());
  expect(
    ComparisonReportSchema.safeParse({ ...r, unexpected: true }).success,
  ).toBe(false);
  r.comparisons[0]!.paired.subject_tokens.baseline_mean = 0;
  expect(ComparisonReportSchema.safeParse(r).success).toBe(false);
  r.comparisons[0]!.paired.subject_tokens.baseline_mean = null;
  r.accounting.subject_cost_usd.known_subtotal = Infinity;
  expect(ComparisonReportSchema.safeParse(r).success).toBe(false);
});
test('coverage cannot claim a complete missing role, extra available samples or duplicate attempt identity', () => {
  const base = foldComparisonReport(mixedComparisonFixture());
  const role = structuredClone(base);
  role.attempts[0]!.evidence.subject_cost_usd = null;
  expect(ComparisonReportSchema.safeParse(role).success).toBe(false);
  const counts = structuredClone(base);
  counts.comparisons[0]!.arms[0]!.available.wall_seconds = 5;
  expect(ComparisonReportSchema.safeParse(counts).success).toBe(false);
  const duplicate = structuredClone(base);
  duplicate.attempts.push(duplicate.attempts[0]!);
  expect(ComparisonReportSchema.safeParse(duplicate).success).toBe(false);
});
test('report identity cannot differ from the immutable anchor', () => {
  const report = foldComparisonReport(mixedComparisonFixture());
  expect(
    ReportSchema.safeParse({
      report,
      anchor: {
        campaign_id: 'foreign',
        input_digest: report.input_digest,
        last_sequence: 1,
        prefix_digest: 'a'.repeat(64),
        roots: { campaign: '/campaign', results: '/results' },
        artifacts: [],
      },
    }).success,
  ).toBe(false);
});
