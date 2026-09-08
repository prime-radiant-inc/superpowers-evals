import { expect, test } from 'bun:test';
import { renderCampaignReport } from '../src/appliance/campaign-render.ts';
import { foldComparisonReport } from '../src/campaign/report.ts';
import type { ArtifactRef } from '../src/contracts/campaign/execution.ts';
import {
  type AttemptEvidence,
  type Report,
  ReportSchema,
} from '../src/contracts/campaign/report.ts';
import { singleArmComparisonFixture } from './fixtures/core-comparison/report-fixture.ts';

const ref = (path: string, digest = '1'): ArtifactRef => ({
  path,
  sha256: digest.repeat(64),
  bytes: 123,
});

function reportFixture(
  update?: (evidence: AttemptEvidence[]) => void,
  resultsRoot = '/fixture/results',
): Report {
  const fixture = singleArmComparisonFixture();
  const evidence = [...fixture.evidenceByAttempt.values()];
  update?.(evidence);
  return ReportSchema.parse({
    report: foldComparisonReport(fixture),
    anchor: {
      campaign_id: fixture.experiment.campaign_id,
      input_digest: fixture.experiment.input_digest,
      last_sequence: fixture.state.transitions.size,
      prefix_digest: 'a'.repeat(64),
      roots: { campaign: '/fixture/campaign', results: resultsRoot },
      artifacts: evidence.flatMap((attempt) =>
        attempt.artifacts.map((artifact) => ({
          ...artifact,
          root: 'results' as const,
        })),
      ),
    },
  });
}

function assessment(
  verdict: 'pass' | 'fail',
  criterion: string,
  evidence: string,
): NonNullable<AttemptEvidence['gauntlet']> {
  return {
    status: verdict,
    summary: `${verdict} summary`,
    reasoning: `${verdict} reasoning`,
    run_id: 'grader-1',
    process_exit: { code: 0, signal: null },
    criteria: [{ criterion, verdict, evidence }],
  };
}

function check(passed: boolean, detail: string | null) {
  return {
    check: 'command-succeeds',
    args: ['bun', 'test'],
    negated: false,
    passed,
    detail,
    phase: 'post' as const,
  };
}

test('pass readout shows accepted grade, criterion evidence, and exact authenticated drilldown without claiming completion', () => {
  const verdict = ref('run-pass/verdict.json');
  const rendered = renderCampaignReport(
    reportFixture((evidence) => {
      evidence[0]!.gauntlet = assessment(
        'pass',
        'writes the requested receipt',
        'receipt.json contains the requested total',
      );
      evidence[0]!.checks = [check(true, null)];
      evidence[0]!.artifacts = [verdict];
    }),
  );

  expect(rendered).toContain('scenario');
  expect(rendered).toContain('base');
  expect(rendered).toContain('accepted pass');
  expect(rendered).toContain('writes the requested receipt');
  expect(rendered).toContain('receipt.json contains the requested total');
  expect(rendered).toContain(
    "quorum show '/fixture/results/run-pass/verdict.json'",
  );
  expect(rendered).toContain(
    'Accepted outcomes do not establish conversation completion.',
  );
});

test('failed criterion and failed check retain their decisive detail', () => {
  const rendered = renderCampaignReport(
    reportFixture((evidence) => {
      evidence[1]!.gauntlet = assessment(
        'fail',
        'preserves the original ordering',
        'the delivered list reverses the required order',
      );
      evidence[1]!.checks = [check(false, 'expected exit 0, observed exit 1')];
    }),
  );

  expect(rendered).toContain('accepted fail');
  expect(rendered).toContain('Criterion fail: preserves the original ordering');
  expect(rendered).toContain(
    'Evidence: the delivered list reverses the required order',
  );
  expect(rendered).toContain(
    'Failed check post command-succeeds bun test: expected exit 0, observed exit 1',
  );
});

test('indeterminate later-stage failure remains separate from conversation completion', () => {
  const rendered = renderCampaignReport(
    reportFixture((evidence) => {
      evidence[2]!.gauntlet = null;
      evidence[2]!.checks = null;
      evidence[2]!.missingness = [
        {
          field: 'gauntlet',
          reason: 'assessment capture failed after the interaction',
        },
      ];
    }),
  );

  expect(rendered).toContain('accepted indeterminate');
  expect(rendered).toContain(
    'Missing gauntlet: assessment capture failed after the interaction',
  );
  expect(rendered).toContain(
    'Use quorum show for completion and role-specific details when a drilldown is available.',
  );
});

test('missing publication states that evidence and drilldown are unavailable', () => {
  const rendered = renderCampaignReport(
    reportFixture((evidence) => {
      evidence[0]!.publication_valid = false;
      evidence[0]!.observed_outcome = null;
      evidence[0]!.artifacts = [];
      evidence[0]!.missingness = [
        { field: 'publication', reason: 'no authenticated publication' },
      ];
    }),
  );

  expect(rendered).toContain(
    'Missing publication: no authenticated publication',
  );
  expect(rendered).toContain(
    'Drilldown unavailable: one authenticated root-level verdict artifact was not available.',
  );
  expect(rendered).not.toContain("quorum show '");
});

test('partial prices show known amounts and explicit coverage', () => {
  const rendered = renderCampaignReport(reportFixture());

  expect(rendered).toContain('Gauntlet-Agent driver/assessor cost');
  expect(rendered).toContain('$10.50');
  expect(rendered).toContain('2/3 partial');
  expect(rendered).toContain(
    'Gauntlet-Agent driver/assessor $0.50 known (pricing incomplete)',
  );
});

test('ambiguous verdict references never produce a guessed drilldown target', () => {
  const rendered = renderCampaignReport(
    reportFixture((evidence) => {
      evidence[0]!.artifacts = [
        ref('run-one/verdict.json', '1'),
        ref('run-two/verdict.json', '2'),
      ];
    }),
  );

  expect(rendered).toContain(
    'Drilldown unavailable: one authenticated root-level verdict artifact was not available.',
  );
  expect(rendered).not.toContain("quorum show '");
});

test('a verdict reference with failed artifact authentication has no drilldown', () => {
  const verdict = ref('run-damaged/verdict.json');
  const rendered = renderCampaignReport(
    reportFixture((evidence) => {
      evidence[0]!.artifacts = [verdict];
      evidence[0]!.missingness = [
        {
          field: verdict.path,
          reason: 'artifact authentication failed',
        },
      ];
    }),
  );

  expect(rendered).toContain(
    'Missing run-damaged/verdict.json: artifact authentication failed',
  );
  expect(rendered).toContain(
    'Drilldown unavailable: one authenticated root-level verdict artifact was not available.',
  );
  expect(rendered).not.toContain("quorum show '");
});
