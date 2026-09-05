import { jcsCanonicalize } from '../contracts/campaign/digest.ts';
import { type Report, ReportSchema } from '../contracts/campaign/report.ts';
import { readPublishedArtifactBytes } from './attempt-publish.ts';
import { readCommittedPrefix } from './execution-journal.ts';
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
  const prefix = readCommittedPrefix(args.campaignDir);
  const last = prefix.committed.at(-1);
  if (
    prefix.projection.ended?.outcome !== 'completed' ||
    !prefix.projection.termination ||
    last?.sequence !== value.anchor.last_sequence ||
    last.prefix_digest !== value.anchor.prefix_digest ||
    prefix.projection.experiment.input_digest !== value.anchor.input_digest ||
    prefix.projection.experiment.campaign_id !== value.anchor.campaign_id
  )
    throw new Error('seal requires the exact completed final journal prefix');
  for (const ref of value.anchor.artifacts)
    readPublishedArtifactBytes(value.anchor.roots[ref.root], ref);
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
