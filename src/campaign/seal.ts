import { jcsCanonicalize } from '../contracts/campaign/digest.ts';
import { type Report, ReportSchema } from '../contracts/campaign/report.ts';
import { publishReport, publishReportFile } from './report-publication.ts';
/** Completed execution seals the same immutable report anchor. Interrupted
 * reports remain publishable without claiming final termination or a seal. */
export function sealReport(args: { campaignDir: string; report: Report }): {
  digest: string;
} {
  const value = ReportSchema.parse(args.report);
  if (
    value.report.status !== 'completed' ||
    !value.report.complete ||
    !value.report.termination_verified
  )
    throw new Error(
      'seal requires completed analysis and verified termination',
    );
  const published = publishReport(args);
  publishReportFile(
    args.campaignDir,
    'report-seal.json',
    `${jcsCanonicalize({
      schema_version: 'quorum.comparison-seal/v1',
      report_digest: published.digest,
      anchor: value.anchor,
    })}\n`,
  );
  return published;
}
