import { expect, test } from 'bun:test';
import { renderCampaignReport } from '../src/appliance/campaign-render.ts';
import {
  foldTransition,
  initialProjection,
} from '../src/campaign/execution-state.ts';
import {
  cellKeyOf,
  primaryBlockId,
  primarySampleId,
} from '../src/campaign/registration.ts';
import { foldComparisonReport } from '../src/campaign/report.ts';
import type { ArtifactRef } from '../src/contracts/campaign/execution.ts';
import {
  type AttemptEvidence,
  type Report,
  ReportSchema,
} from '../src/contracts/campaign/report.ts';
import {
  blockActivation,
  evidenceRef,
  observation,
  sessionTransitions,
  transition,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';
import {
  mixedComparisonFixture,
  singleArmComparisonFixture,
} from './fixtures/core-comparison/report-fixture.ts';

const ref = (path: string, digest = '1'): ArtifactRef => ({
  path,
  sha256: digest.repeat(64),
  bytes: 123,
});

function reportFixture(
  update?: (evidence: AttemptEvidence[]) => void,
  resultsRoot = '/fixture/results',
  fixture: Parameters<
    typeof foldComparisonReport
  >[0] = singleArmComparisonFixture(),
): Report {
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

test('paired comparison readout exposes roles, independent quantity coverage, and elapsed accounting', () => {
  const value = reportFixture(
    undefined,
    '/fixture/results',
    mixedComparisonFixture(),
  );
  const comparison = value.report.comparisons[0]!;

  expect(comparison.roles).toEqual({ baseline: 'b', treatment: 't1' });
  expect(comparison.paired.wall_seconds).toEqual({
    n: 3,
    baseline_mean: 53.3333333333333,
    treatment_mean: 40,
    mean_delta: -13.3333333333333,
  });
  expect(comparison.paired.subject_cost_usd.n).toBe(2);
  expect(value.report.elapsed.seconds).toBe(24);
  expect(value.report.attempts).toHaveLength(12);
  expect(
    value.report.attempts.some((attempt) => !attempt.analysis_usable),
  ).toBe(true);
  expect(value.report.accounting.subject_cost_usd).toEqual({
    known_subtotal: 136,
    observed: 9,
    attempts: 12,
    complete: false,
  });

  const rendered = renderCampaignReport(value);
  expect(rendered).toContain('Baseline: b; treatment: t1');
  expect(rendered).toContain(
    'wall_seconds: pairs 3; baseline 53.3333333333333; treatment 40; delta -13.3333333333333',
  );
  expect(rendered).toContain('subject_cost_usd: pairs 2');
  expect(rendered).toContain(
    'pass_rate: pairs 2; baseline 0.5; treatment 1; rate difference 0.5',
  );
  expect(rendered).toContain('Elapsed: 24 seconds');
  expect(rendered).toContain(
    'Analytical usability authenticates evidence but does not independently certify semantic grading.',
  );
  expect(rendered).toContain('9/12 partial');
});

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
  expect(rendered).toContain('Arm: base');
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

function multiScenarioReport(): Report {
  const experiment = twoArmExperiment();
  const scenarios = ['conversation-pricing', 'conversation-design'];
  experiment.suite.comparisons[0]!.scenarios = scenarios;
  experiment.comparisons[0]!.comparison_id = 'c1';
  experiment.cells = scenarios.map((scenario) => ({
    ...experiment.cells[0]!,
    comparison_id: 'c1',
    scenario,
  }));
  experiment.planned_slots = scenarios.flatMap((scenario) =>
    ['base', 'candidate'].map((arm) => ({
      sample_id: primarySampleId(cellKeyOf('c1', scenario), arm, 1),
      primary_block_id: primaryBlockId(cellKeyOf('c1', scenario), 1),
      comparison_id: 'c1',
      scenario,
      arm,
      replicate: 1,
    })),
  );
  experiment.reserve_slots = [];
  experiment.suite.reserve = 0;
  const intents = blockActivation(experiment).attempts;
  for (const intent of intents)
    intent.container_name = intent.container_name.replaceAll(':', '-');
  const blocks = scenarios.map((_scenario, index) => {
    const attempts = intents.slice(index * 2, index * 2 + 2);
    const blockId = attempts[0]!.primary_block_id;
    for (const attempt of attempts) attempt.identity.block_id = blockId;
    return {
      block_id: blockId,
      primary_block_id: blockId,
      reserve_id: null,
      predecessor_block_id: null,
      attempts,
    };
  });
  const transitions = [
    ...sessionTransitions(experiment),
    ...blocks.map((block, i) =>
      transition('block_activated', block, 3, `activate-${i}`),
    ),
    ...blocks.flatMap((block, i) =>
      block.attempts.map((_attempt, j) =>
        transition(
          'attempt_observed',
          { observation: observation(block, j, 4), excluded_block: null },
          4,
          `observe-${i}-${j}`,
        ),
      ),
    ),
    ...blocks.map((block, i) =>
      transition(
        'block_validated',
        { block_id: block.block_id, evidence_refs: [evidenceRef] },
        5,
        `validate-${i}`,
      ),
    ),
    transition(
      'ended',
      { outcome: 'completed', reason: 'done', cancel_intent: null },
      5,
    ),
  ];
  const value = reportFixture();
  value.report = foldComparisonReport({
    experiment,
    state: transitions.reduce(foldTransition, initialProjection(experiment)),
    evidenceByAttempt: new Map(),
    validityByBlock: new Map(),
  });
  return ReportSchema.parse(value);
}

test('comparison quantity blocks identify scenarios when roles repeat', () => {
  const rendered = renderCampaignReport(multiScenarioReport());

  expect(rendered).toContain('Scenario: conversation-pricing (c1)');
  expect(rendered).toContain('Scenario: conversation-design (c1)');
});

test('folded multi-scenario comparison labels every attempt with its own scenario', () => {
  const report = multiScenarioReport();
  expect(
    report.report.comparisons.map((comparison) => comparison.scenario),
  ).toEqual(['conversation-pricing', 'conversation-design']);
  const headings = renderCampaignReport(report)
    .split('\n')
    .filter((line) => line.includes(' — '));
  expect(headings).toHaveLength(4);
  expect(headings[0]).toContain(' — conversation-pricing / base — ');
  expect(headings[1]).toContain(' — conversation-pricing / candidate — ');
  expect(headings[2]).toContain(' — conversation-design / base — ');
  expect(headings[3]).toContain(' — conversation-design / candidate — ');
});

test('malformed or inconsistent sample identities and duplicate comparisons leave scenario unavailable', () => {
  for (const sample of [
    'single-1',
    'c1:conversation-pricing:base:r0',
    'c1:conversation-pricing:base:r1:extra',
    'c01:conversation-pricing:base:r1',
    'c1:conversation-pricing:base:b1',
    'c2:conversation-pricing:base:r1',
    'c1:conversation-pricing:candidate:r1',
    'c1:missing:base:r1',
  ]) {
    const value = multiScenarioReport();
    value.report.comparisons = [value.report.comparisons[0]!];
    value.report.attempts[0]!.sample_id = sample;
    const first = renderCampaignReport(value)
      .split('\n')
      .find((line) => line.includes(' — '));
    expect(first).toContain(' — scenario unavailable / base — ');
  }
  const duplicate = multiScenarioReport();
  duplicate.report.comparisons = [duplicate.report.comparisons[0]!];
  duplicate.report.comparisons.push(
    structuredClone(duplicate.report.comparisons[0]!),
  );
  const first = renderCampaignReport(duplicate)
    .split('\n')
    .find((line) => line.includes(' — '));
  expect(first).toContain(' — scenario unavailable / base — ');
});

test('reserve sample identity resolves the same authenticated scenario without guessing a verdict path', () => {
  const value = multiScenarioReport();
  value.report.attempts[0]!.sample_id = 'c1:conversation-pricing:base:x2';
  const first = renderCampaignReport(value)
    .split('\n')
    .find((line) => line.includes(' — '));
  expect(first).toContain(' — conversation-pricing / base — ');
  expect(renderCampaignReport(value)).not.toContain("quorum show '");
});
