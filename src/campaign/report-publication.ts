import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readPinnedNoFollowFile } from '../appliance/credential-scope.ts';
import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import type { ArtifactRef } from '../contracts/campaign/execution.ts';
import { type Report, ReportSchema } from '../contracts/campaign/report.ts';
import {
  type CampaignLifecycleArgs,
  type CampaignProcessControl,
  campaignProcesses,
  observeCampaignStatus,
} from './cancellation.ts';
import { readCommittedPrefix } from './execution-journal.ts';
import { createDurableMarker, fsyncDir } from './journal.ts';
import { foldComparisonReport } from './report.ts';
import { readAttemptEvidence, readBlockValidity } from './report-evidence.ts';

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
export interface ReadComparisonArgs extends CampaignLifecycleArgs {
  resultsRoot: string;
}
/** Shared status/cost/report measurement read. Lifecycle observation may read the
 * journal, but only this single committed prefix supplies measurement and anchor. */
export function readComparisonReadout(
  args: ReadComparisonArgs,
  processes: Pick<CampaignProcessControl, 'observe'> = campaignProcesses,
): Report {
  const status = observeCampaignStatus(args, processes);
  const prefix = readCommittedPrefix(args.campaignDir);
  const state = prefix.projection;
  const sessionProcess = state.controller ?? state.start?.launcher;
  return readComparisonFromPrefix({
    campaignDir: args.campaignDir,
    resultsRoot: args.resultsRoot,
    prefix,
    interrupted:
      !state.ended &&
      status.state === 'interrupted' &&
      sessionProcess !== undefined &&
      processes.observe(sessionProcess) === 'dead',
  });
}
/** Authenticate evidence and derive the complete report from one supplied
 * committed-prefix read. Readout and sealing share this exact measurement path. */
export function readComparisonFromPrefix(args: {
  campaignDir: string;
  resultsRoot: string;
  prefix: ReturnType<typeof readCommittedPrefix>;
  interrupted?: boolean;
}): Report {
  if (!isAbsolute(args.resultsRoot) || !isAbsolute(args.campaignDir))
    throw new Error('report storage roots must be explicit absolute paths');
  const { projection: state, committed } = args.prefix;
  const artifacts: Report['anchor']['artifacts'] = [];
  const evidenceByAttempt = new Map(
    [...state.attempts].map(([id, a]) => {
      const refs = new Map<string, ArtifactRef>();
      for (const ref of [
        ...(a.observation?.artifacts ?? []),
        ...(a.accounting?.artifacts ?? []),
      ])
        refs.set(jcsCanonicalize(ref), ref);
      const sorted = [...refs.values()].sort((a, b) =>
        compareText(a.path, b.path),
      );
      artifacts.push(
        ...sorted.map((ref) => ({ ...ref, root: 'results' as const })),
      );
      return [
        id,
        readAttemptEvidence({
          resultsRoot: args.resultsRoot,
          expectedIdentity: a.intent.identity,
          artifacts: sorted,
        }),
      ];
    }),
  );
  const validityByBlock = new Map(
    [...state.blocks].map(([id, block]) => {
      for (const ref of [
        ...(block.validity_receipt?.evidence_refs ?? []),
        ...(block.invalidation?.evidence_refs ?? []),
      ])
        artifacts.push({ ...ref, root: 'campaign' });
      return [
        id,
        readBlockValidity({ campaignDir: args.campaignDir, state, block }),
      ];
    }),
  );
  if (state.ended?.cancel_intent)
    artifacts.push({ ...state.ended.cancel_intent, root: 'campaign' });
  for (const ref of state.termination?.process_evidence ?? [])
    artifacts.push({ ...ref, root: 'campaign' });
  const unique = [
    ...new Map(artifacts.map((ref) => [jcsCanonicalize(ref), ref])).values(),
  ].sort(
    (a, b) =>
      compareText(a.root, b.root) ||
      compareText(a.path, b.path) ||
      compareText(a.sha256, b.sha256) ||
      a.bytes - b.bytes,
  );
  const last = committed.at(-1);
  return ReportSchema.parse({
    report: foldComparisonReport({
      experiment: state.experiment,
      state,
      evidenceByAttempt,
      validityByBlock,
      interrupted: args.interrupted ?? false,
    }),
    anchor: {
      campaign_id: state.experiment.campaign_id,
      input_digest: state.experiment.input_digest,
      last_sequence: last?.sequence ?? 0,
      prefix_digest: last?.prefix_digest ?? sha256Hex(''),
      roots: { campaign: args.campaignDir, results: args.resultsRoot },
      artifacts: unique,
    },
  });
}
export function readComparisonReport(
  args: ReadComparisonArgs,
  processes: Pick<CampaignProcessControl, 'observe'> = campaignProcesses,
): Report {
  const readout = readComparisonReadout(args, processes);
  if (!readout.report.behavior_available)
    throw new Error(
      'behavioral report unavailable for active, registered or unresolved session; use status/costs',
    );
  return readout;
}
export function canonicalReportBytes(report: Report): Buffer {
  return Buffer.from(`${jcsCanonicalize(ReportSchema.parse(report))}\n`);
}
export const digestReportBytes = (bytes: Buffer): string =>
  Bun.SHA256.hash(bytes, 'hex');
const escapeMarkdown = (s: string) =>
  s
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const number = (n: number | null) => (n === null ? 'missing' : String(n));
/** Human-readable rendering has no authority separate from the frozen JSON. */
export function renderReportMd(value: Report): string {
  const { report: r, anchor } = ReportSchema.parse(value);
  const lines = [
    `# Comparison report: ${escapeMarkdown(r.campaign_id)}`,
    '',
    `Status: ${r.status}; ${r.complete ? 'complete' : 'incomplete'}; behavior ${r.behavior_available ? 'available' : 'hidden'}.`,
    `Journal prefix: sequence ${anchor.last_sequence}, SHA-256 \`${anchor.prefix_digest}\`.`,
    `Input SHA-256: \`${anchor.input_digest}\`.`,
    '',
  ];
  for (const c of r.comparisons) {
    lines.push(
      `## ${escapeMarkdown(c.comparison_id)} / ${escapeMarkdown(c.scenario)}`,
      '',
      '| Arm | Planned | Pass | Fail | Indeterminate | No usable result | Subject $ available | Grader $ available | Wall s available | Subject tokens available | Grader tokens available |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    );
    for (const a of c.arms)
      lines.push(
        `| ${escapeMarkdown(a.arm)} | ${a.denominator} | ${a.pass} | ${a.fail} | ${a.indeterminate} | ${a.no_usable_result} | ${a.available.subject_cost_usd} | ${a.available.grader_cost_usd} | ${a.available.wall_seconds} | ${a.available.subject_tokens} | ${a.available.grader_tokens} |`,
      );
    lines.push(
      '',
      'Complete determinate pairs only; each quantity uses its own matched cohort.',
      '',
      '| Quantity | Pairs n | Baseline mean | Treatment mean | Mean paired delta (treatment − baseline) |',
      '|---|---:|---:|---:|---:|',
    );
    for (const [key, q] of Object.entries(c.paired))
      lines.push(
        `| ${key} | ${q.n} | ${number(q.baseline_mean)} | ${number(q.treatment_mean)} | ${number(q.mean_delta)} |`,
      );
    lines.push('');
  }
  const totals = (title: string, accounting: typeof r.accounting) => {
    lines.push(
      `## ${title}`,
      '',
      '| Quantity | Known subtotal | Complete observations / attempts | Complete |',
      '|---|---:|---:|---|',
    );
    for (const [key, q] of Object.entries(accounting))
      lines.push(
        `| ${key} | ${q.known_subtotal} | ${q.observed}/${q.attempts} | ${q.complete ? 'yes' : 'no'} |`,
      );
    lines.push('');
  };
  totals('All-attempt accounting', r.accounting);
  for (const [key, values] of Object.entries(r.excluded_accounting))
    totals(`Excluded accounting: ${key}`, values);
  lines.push(
    '## Caveats',
    '',
    ...r.caveats.map((c) => `- ${escapeMarkdown(c)}`),
    '',
    '## Execution attempts',
    '',
  );
  for (const a of r.attempts) {
    lines.push(
      `- ${escapeMarkdown(a.execution_attempt_id)} (${escapeMarkdown(a.comparison_id)} / ${escapeMarkdown(a.arm)}): accepted ${a.accepted_outcome ?? 'unavailable'}, ${a.analysis_usable ? 'analytically usable' : 'not analytically usable'}. Subject USD ${number(a.evidence.subject_cost_usd)}${a.evidence.subject_cost_complete ? '' : ' (incomplete)'}; grader USD ${number(a.evidence.grader_cost_usd)}${a.evidence.grader_cost_complete ? '' : ' (incomplete)'}; run wall ${number(a.evidence.wall_seconds)} s.`,
    );
    for (const reason of a.reasons) lines.push(`  - ${escapeMarkdown(reason)}`);
    for (const missing of a.evidence.missingness)
      lines.push(
        `  - ${escapeMarkdown(missing.field)}: ${escapeMarkdown(missing.reason)}`,
      );
  }
  lines.push('', '## Referenced artifacts', '');
  for (const ref of anchor.artifacts) {
    const path = join(anchor.roots[ref.root], ref.path);
    lines.push(
      `- [${escapeMarkdown(`${ref.root}:${ref.path}`)}](<${encodeURI(path)}>) — ${ref.bytes} bytes; SHA-256 \`${ref.sha256}\`.`,
    );
  }
  return `${lines.join('\n')}\n`;
}
/** Exclusive durable publication: identical bytes are idempotent; another
 * prefix is a concrete conflict. JSON fixes the anchor before Markdown lands. */
export function publishReport(args: { campaignDir: string; report: Report }): {
  digest: string;
} {
  if (args.report.anchor.roots.campaign !== args.campaignDir)
    throw new Error('report publication directory differs from anchor');
  if (!args.report.report.behavior_available)
    throw new Error('cannot publish an active behavioral report');
  const json = canonicalReportBytes(args.report);
  const md = renderReportMd(args.report);
  publishReportFile(args.campaignDir, 'report.json', json.toString());
  publishReportFile(args.campaignDir, 'report.md', md);
  return { digest: digestReportBytes(json) };
}
export function publishReportFile(
  campaignDir: string,
  name: 'report.json' | 'report.md' | 'report-seal.json',
  body: string,
): void {
  const path = join(campaignDir, name);
  const confirm = () => {
    if (
      readPinnedNoFollowFile(campaignDir, [name], 'immutable report', true) !==
      body
    )
      throw new Error(`immutable report publication conflict: ${path}`);
    fsyncDir(campaignDir);
  };
  if (lstatSync(path, { throwIfNoEntry: false })) {
    confirm();
    return;
  }
  try {
    createDurableMarker(path, body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') confirm();
    else throw error;
  }
}
