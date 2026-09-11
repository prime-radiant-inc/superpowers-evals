import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readPinnedNoFollowFile } from '../appliance/credential-scope.ts';
import { jcsCanonicalize } from '../contracts/campaign/digest.ts';
import {
  Sha256Schema,
  TimestampSchema,
} from '../contracts/campaign/experiment.ts';
import type { Report } from '../contracts/campaign/report.ts';
import { readCommittedPrefix } from './execution-journal.ts';
import {
  canonicalReportBytes,
  digestReportBytes,
  publishReportFile,
  publishReportSnapshot,
  readComparisonReport,
} from './report-publication.ts';
import { sealReport } from './seal.ts';

const MeasurementReadinessSchema = z
  .object({
    comparison_id: z.string(),
    scenario: z.string(),
    arm: z.string(),
    kind: z.enum(['detail', 'interaction', 'check', 'criterion']),
    id: z.string(),
    complete: z.boolean(),
    qualification: z
      .enum(['qualified', 'unverified', 'not_calibrated'])
      .nullable(),
    artifacts_published_at: TimestampSchema.nullable(),
  })
  .strict();
export const ReportDeliverySchema = z
  .object({
    report_digest: Sha256Schema,
    registered_at: TimestampSchema.nullable(),
    requested_at: TimestampSchema.nullable(),
    request_accepted_at: TimestampSchema.nullable(),
    execution_started_at: TimestampSchema.nullable(),
    artifacts_published_at: TimestampSchema,
    measurement_readiness: z.array(MeasurementReadinessSchema),
  })
  .strict();
export type ReportDelivery = z.infer<typeof ReportDeliverySchema>;
function terminal(report: Report): boolean {
  return (
    report.report.status === 'completed' &&
    report.report.complete &&
    report.report.termination_verified
  );
}
function readReceipt(directory: string, digest: string): ReportDelivery | null {
  const bytes = readPinnedNoFollowFile(
    directory,
    ['report-delivery.json'],
    'report delivery',
    false,
  );
  if (bytes === null) return null;
  const receipt = ReportDeliverySchema.parse(JSON.parse(bytes));
  if (receipt.report_digest !== digest)
    throw new Error('immutable report publication conflict: delivery digest');
  return receipt;
}
/** Read-only status never advances the delivery clock. */
export function readReportDelivery(report: Report): ReportDelivery | null {
  const digest = digestReportBytes(canonicalReportBytes(report));
  const directory = terminal(report)
    ? report.anchor.roots.campaign
    : join(
        report.anchor.roots.campaign,
        'report-snapshots',
        `${report.anchor.last_sequence}-${digest}`,
      );
  if (!lstatSync(directory, { throwIfNoEntry: false })) return null;
  return readReceipt(directory, digest);
}
/** Publication completes before the independent receipt observes its endpoint. */
export function deliverComparisonReport(
  input: Parameters<typeof readComparisonReport>[0] & {
    processes: Parameters<typeof readComparisonReport>[1];
    now: () => number;
  },
): { report: Report; delivery: ReportDelivery } {
  const report = readComparisonReport(input, input.processes);
  const published = terminal(report)
    ? sealReport({ campaignDir: input.campaignDir, report })
    : publishReportSnapshot({ campaignDir: input.campaignDir, report });
  const existing = readReceipt(published.directory, published.digest);
  if (existing) return { report, delivery: existing };
  const prefix = readCommittedPrefix(input.campaignDir);
  if (prefix.committed.at(-1)?.prefix_digest !== report.anchor.prefix_digest)
    throw new Error('report delivery journal prefix changed');
  const state = prefix.projection;
  const artifactsPublishedAt = new Date(input.now()).toISOString();
  const measurement_readiness: ReportDelivery['measurement_readiness'] = [];
  for (const comparison of report.report.comparisons)
    for (const arm of comparison.arms) {
      const base = {
        comparison_id: comparison.comparison_id,
        scenario: comparison.scenario,
        arm: arm.arm,
      };
      const add = (
        kind: ReportDelivery['measurement_readiness'][number]['kind'],
        id: string,
        complete: boolean,
        qualification: ReportDelivery['measurement_readiness'][number]['qualification'] = null,
      ) =>
        measurement_readiness.push({
          ...base,
          kind,
          id,
          complete,
          qualification,
          artifacts_published_at: complete ? artifactsPublishedAt : null,
        });
      add('detail', 'frozen_obligations', arm.measurements.detail_available);
      for (const [kind, obligations] of [
        ['interaction', [arm.measurements.interaction]],
        ['check', arm.measurements.checks],
        ['criterion', arm.measurements.criteria],
      ] as const)
        for (const obligation of obligations)
          add(
            kind,
            obligation.id,
            arm.measurements.detail_available &&
              obligation.planned > 0 &&
              obligation.unavailable === 0 &&
              obligation.unclear === 0 &&
              (kind !== 'criterion' ||
                obligation.qualification === 'qualified' ||
                obligation.qualification === 'not_calibrated'),
            obligation.qualification ?? null,
          );
    }
  const delivery = ReportDeliverySchema.parse({
    report_digest: published.digest,
    registered_at: state.experiment.registered_at,
    requested_at: state.start?.requested_at ?? null,
    request_accepted_at: state.start?.claimed_at ?? null,
    execution_started_at:
      [...state.attempts.values()].map((a) => a.prepared_at).sort()[0] ?? null,
    artifacts_published_at: artifactsPublishedAt,
    measurement_readiness,
  });
  try {
    publishReportFile(
      published.directory,
      'report-delivery.json',
      `${jcsCanonicalize(delivery)}\n`,
    );
  } catch (error) {
    // Concurrent publishers may have completed the same digest first.
    if (
      !(error instanceof Error) ||
      !error.message.startsWith('immutable report publication conflict:')
    )
      throw error;
    const winner = readReceipt(published.directory, published.digest);
    if (winner) {
      publishReportFile(
        published.directory,
        'report-delivery.json',
        `${jcsCanonicalize(winner)}\n`,
      );
      return { report, delivery: winner };
    }
    throw error;
  }
  return { report, delivery };
}
