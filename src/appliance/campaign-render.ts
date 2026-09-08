import { isAbsolute, join } from 'node:path';
import type { ArtifactRef } from '../contracts/campaign/execution.ts';
import { type Report, ReportSchema } from '../contracts/campaign/report.ts';
import { ID_COMPONENT_RE } from '../contracts/campaign/suite.ts';

type AccountingQuantity = Report['report']['accounting']['subject_cost_usd'];

function plain(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function table(header: readonly string[], rows: readonly string[][]): string[] {
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (row: readonly string[]) =>
    `  ${row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()}`;
  return [line(header), ...rows.map(line)];
}

function dollars(value: number | null): string {
  return value === null ? 'unavailable' : `$${value.toFixed(2)}`;
}

function priceCoverage(quantity: AccountingQuantity): string {
  return `${quantity.observed}/${quantity.attempts} ${quantity.complete ? 'complete' : 'partial'}`;
}

function attemptPrice(
  label: string,
  value: number | null,
  complete: boolean,
): string {
  if (value === null) return `${label} unavailable`;
  return complete
    ? `${label} ${dollars(value)}`
    : `${label} ${dollars(value)} known (pricing incomplete)`;
}

function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.path === b.path && a.sha256 === b.sha256 && a.bytes === b.bytes;
}

function isRootVerdict(ref: ArtifactRef): boolean {
  const parts = ref.path.split('/');
  return parts.length === 2 && parts[1] === 'verdict.json';
}

function drilldownTarget(
  value: Report,
  attempt: Report['report']['attempts'][number],
): string | null {
  if (!attempt.evidence.publication_valid) return null;
  if (!isAbsolute(value.anchor.roots.results)) return null;
  const candidates = attempt.evidence.artifacts.filter(isRootVerdict);
  const candidate = candidates[0];
  if (candidates.length !== 1 || candidate === undefined) return null;
  if (
    attempt.evidence.missingness.some(
      (missing) => missing.field === candidate.path,
    )
  )
    return null;
  const anchored = value.anchor.artifacts.filter(
    (ref) => ref.root === 'results' && ref.path === candidate.path,
  );
  if (
    anchored.length !== 1 ||
    anchored[0] === undefined ||
    !sameArtifact(candidate, anchored[0])
  )
    return null;
  return join(value.anchor.roots.results, candidate.path);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function scenarioForAttempt(
  report: Report['report'],
  attempt: Report['report']['attempts'][number],
): string {
  // Registration's injective sample grammar identifies the scenario within a comparison.
  const parts = attempt.sample_id.split(':');
  const [comparisonId, scenario, arm, slot] = parts;
  if (
    parts.length !== 4 ||
    comparisonId === undefined ||
    !/^c[1-9][0-9]*$/.test(comparisonId) ||
    scenario === undefined ||
    !ID_COMPONENT_RE.test(scenario) ||
    arm === undefined ||
    !ID_COMPONENT_RE.test(arm) ||
    slot === undefined ||
    !/^[rx][1-9][0-9]*$/.test(slot) ||
    comparisonId !== attempt.comparison_id ||
    arm !== attempt.arm
  )
    return 'scenario unavailable';
  const matches = report.comparisons.filter(
    (comparison) =>
      comparison.comparison_id === comparisonId &&
      comparison.scenario === scenario &&
      comparison.arms.some((member) => member.arm === arm),
  );
  return matches.length === 1 ? plain(scenario) : 'scenario unavailable';
}

/** Human-only terminal presentation over the authenticated report envelope. */
export function renderCampaignReport(input: Report): string {
  const value = ReportSchema.parse(input);
  const { report } = value;
  const lines = [
    `Campaign report: ${plain(report.campaign_id)}`,
    `Status: ${report.status} · analysis ${report.complete ? 'complete' : 'incomplete'} · termination ${report.termination_verified ? 'verified' : 'unverified'} · behavior ${report.behavior_available ? 'available' : 'hidden'}`,
    '',
    'Outcomes',
  ];

  const outcomeRows = report.comparisons.flatMap((comparison) =>
    comparison.arms.map((arm) => [
      plain(comparison.scenario),
      plain(arm.arm),
      String(arm.denominator),
      String(arm.pass),
      String(arm.fail),
      String(arm.indeterminate),
      String(arm.no_usable_result),
    ]),
  );
  lines.push(
    ...(outcomeRows.length === 0
      ? ['  (behavior unavailable)']
      : table(
          [
            'scenario',
            'arm',
            'planned',
            'pass',
            'fail',
            'indeterminate',
            'no usable',
          ],
          outcomeRows,
        )),
    '',
    'Prices and coverage',
    ...table(
      ['price', 'known subtotal', 'coverage'],
      [
        [
          'Coding-Agent cost',
          dollars(report.accounting.subject_cost_usd.known_subtotal),
          priceCoverage(report.accounting.subject_cost_usd),
        ],
        [
          'Gauntlet-Agent driver/assessor cost',
          dollars(report.accounting.grader_cost_usd.known_subtotal),
          priceCoverage(report.accounting.grader_cost_usd),
        ],
        [
          'Combined cost',
          dollars(report.accounting.combined_cost_usd.known_subtotal),
          priceCoverage(report.accounting.combined_cost_usd),
        ],
      ],
    ),
    '',
    'Attempts',
    'Accepted outcomes do not establish conversation completion.',
    'Use quorum show for completion and role-specific details when a drilldown is available.',
  );

  for (const attempt of report.attempts) {
    lines.push(
      '',
      `${plain(attempt.execution_attempt_id)} — ${scenarioForAttempt(report, attempt)} / ${plain(attempt.arm)} — accepted ${attempt.accepted_outcome ?? 'unavailable'}; ${attempt.analysis_usable ? 'analytically usable' : 'not analytically usable'}`,
    );
    for (const reason of attempt.reasons)
      lines.push(`  Reason: ${plain(reason)}`);

    const gauntlet = attempt.evidence.gauntlet;
    if (gauntlet === null) {
      lines.push('  Assessment: unavailable');
    } else {
      lines.push(
        `  Assessment ${plain(gauntlet.status)}: ${plain(gauntlet.summary)}`,
      );
      for (const criterion of gauntlet.criteria ?? []) {
        lines.push(
          `  Criterion ${plain(criterion.verdict)}: ${plain(criterion.criterion)}`,
          `    Evidence: ${plain(criterion.evidence)}`,
        );
      }
    }

    const checks = attempt.evidence.checks;
    if (checks === null) {
      lines.push('  Checks: unavailable');
    } else {
      const failed = checks.filter((check) => !check.passed);
      if (failed.length === 0) lines.push('  Checks: no failures');
      for (const check of failed) {
        const invocation = [
          check.negated ? 'not' : '',
          check.check,
          ...check.args,
        ]
          .filter((part) => part !== '')
          .map(plain)
          .join(' ');
        lines.push(
          `  Failed check ${check.phase} ${invocation}${check.detail === null ? '' : `: ${plain(check.detail)}`}`,
        );
      }
    }

    for (const missing of attempt.evidence.missingness)
      lines.push(`  Missing ${plain(missing.field)}: ${plain(missing.reason)}`);
    lines.push(
      `  Costs: ${attemptPrice('Coding-Agent', attempt.evidence.subject_cost_usd, attempt.evidence.subject_cost_complete)}; ${attemptPrice('Gauntlet-Agent driver/assessor', attempt.evidence.grader_cost_usd, attempt.evidence.grader_cost_complete)}`,
    );

    const target = drilldownTarget(value, attempt);
    lines.push(
      target === null
        ? '  Drilldown unavailable: one authenticated root-level verdict artifact was not available.'
        : `  Run on the machine where ${shellQuote(value.anchor.roots.results)} exists: quorum show ${shellQuote(target)}`,
    );
  }

  for (const caveat of report.caveats)
    lines.push('', `Caveat: ${plain(caveat)}`);
  return `${lines.join('\n')}\n`;
}
