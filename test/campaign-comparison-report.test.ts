import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { evaluateQualification } from '../src/campaign/assessment-qualification.ts';
import {
  foldTransition,
  initialProjection,
} from '../src/campaign/execution-state.ts';
import { resolveMeasurementRequirements } from '../src/campaign/measurement-requirements.ts';
import { foldComparisonReport } from '../src/campaign/report.ts';
import {
  type AttemptEvidence,
  missingAttemptEvidence,
} from '../src/campaign/report-evidence.ts';
import { renderReportMd } from '../src/campaign/report-publication.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import { ExperimentSchema } from '../src/contracts/campaign/experiment.ts';
import { ComparisonReportSchema } from '../src/contracts/campaign/report.ts';
import { CredentialSchema } from '../src/contracts/credential.ts';
import {
  blockActivation,
  evidenceRef,
  observation,
  replacementFixture,
  sessionTransitions,
  transition,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';
import {
  mixedComparisonFixture,
  singleArmComparisonFixture,
} from './fixtures/core-comparison/report-fixture.ts';

test('literal twelve-attempt oracle preserves fixed slots and quantity-matched pairs', () => {
  const fixture = mixedComparisonFixture();
  const report = foldComparisonReport(fixture);
  expect(report.comparisons).toEqual(fixture.expected.comparisons);
  expect(report.accounting).toEqual(fixture.expected.accounting);
  expect(report.arm_accounting).toEqual(fixture.expected.arm_accounting);
  expect(report.elapsed).toEqual(fixture.expected.elapsed);
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
  f.experiment.assessment_qualification = {
    reference: { path: 'qualification.json', sha256: 'a'.repeat(64) },
    scopes: [
      {
        scenario: 'scenario',
        criterion_ids: ['scenario:1'],
        status: 'qualified',
        reason: 'fixture',
      },
    ],
  };
  for (const e of f.evidenceByAttempt.values()) {
    e.check_execution_complete = true;
    e.conversation = {
      status: 'completed',
      endpoint: 'delivery',
      reason: 'done',
      timestamp: '2026-09-04T00:00:00.000Z',
      evidence: { path: 'visible.json', quote: 'done' },
    };
    e.assessment_report = evidenceRef;
    e.roles = {
      conversation: {
        out_dir: 'conversation/run',
        model: 'm',
        started_at: null,
        finished_at: null,
        process_exit: null,
        stop_cause: null,
      },
      assessment: {
        out_dir: 'assessment/run',
        model: 'm',
        started_at: null,
        finished_at: null,
        process_exit: null,
        stop_cause: null,
      },
    };
  }
  f.state = f.transitions
    .slice(0, -1)
    .reduce(foldTransition, initialProjection(f.experiment));
  const report = foldComparisonReport(f);
  expect(report.behavior_available).toBe(false);
  expect(report.elapsed).toEqual({
    started_at: f.expected.elapsed.started_at,
    ended_at: null,
    seconds: null,
  });
  expect(report.comparisons).toEqual([]);
  expect(report.qualification).toBeNull();
  expect(report.source_refs).toBeNull();
  expect(
    report.attempts.every(
      (a) =>
        a.accepted_outcome === null &&
        a.evidence.observed_outcome === null &&
        a.evidence.gauntlet === null &&
        a.evidence.checks === null &&
        !a.evidence.check_execution_complete &&
        a.evidence.conversation === null &&
        a.evidence.roles === null &&
        a.evidence.assessment_report === null,
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
    n: 1,
    baseline_mean: 5,
    treatment_mean: 6,
    mean_delta: 1,
  });
});

test('a determinate accepted observation needs authenticated supporting verdict evidence', () => {
  const f = mixedComparisonFixture();
  f.evidenceByAttempt.get('c1-r1-b-1')!.observed_outcome = null;
  const r = foldComparisonReport(f);
  expect(r.comparisons[0]!.arms[0]!.no_usable_result).toBe(2);
  expect(r.comparisons[0]!.arms[0]!.available.subject_cost_usd).toBe(3);
  expect(r.comparisons[0]!.paired.subject_cost_usd.n).toBe(2);
  expect(r.comparisons[0]!.paired.pass_rate.n).toBe(1);
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

test('completed replacement analysis is complete even though superseded attempts stay in accounting', () => {
  const f = replacementFixture();
  f.transitions.push(
    transition(
      'block_validated',
      { block_id: 'successor', evidence_refs: [evidenceRef] },
      9,
    ),
    transition(
      'ended',
      { outcome: 'completed', reason: 'done', cancel_intent: null },
      10,
    ),
  );
  const state = f.transitions.reduce(
    foldTransition,
    initialProjection(f.experiment),
  );
  const evidenceByAttempt = new Map(
    [...state.attempts].map(([id, a]) => [
      id,
      {
        ...missingAttemptEvidence(),
        publication_valid: true,
        observed_outcome: a.observation!.outcome,
      },
    ]),
  );
  const report = foldComparisonReport({
    experiment: f.experiment,
    state,
    evidenceByAttempt,
    validityByBlock: new Map([['successor', { available: true, reasons: [] }]]),
  });
  expect(report.complete).toBe(true);
  expect(report.accounting.subject_cost_usd.attempts).toBe(4);
  expect(report.excluded_accounting.superseded.subject_cost_usd.attempts).toBe(
    2,
  );
});

function namedRoleFixture(single = false) {
  const experiment = twoArmExperiment();
  experiment.comparisons = single
    ? [{ comparison_id: 'comparison', arm: 'variant-a' }]
    : [
        {
          comparison_id: 'comparison',
          baseline: 'variant-a',
          treatment: 'variant-b',
        },
      ];
  experiment.suite.comparisons = single
    ? [{ arm: 'variant-a', scenarios: ['scenario'], n: 1 }]
    : [
        {
          baseline: 'variant-a',
          treatment: 'variant-b',
          scenarios: ['scenario'],
          n: 1,
        },
      ];
  experiment.cells[0]!.arms = single
    ? ['variant-a']
    : ['variant-b', 'variant-a'];
  experiment.planned_slots = experiment.planned_slots
    .filter((slot) => !single || slot.arm === 'base')
    .map((slot) => ({
      ...slot,
      arm: slot.arm === 'base' ? 'variant-a' : 'variant-b',
    }));
  experiment.execution_surface = experiment.execution_surface.map((arm) => ({
    ...arm,
    name: arm.name === 'base' ? 'variant-a' : 'variant-b',
  }));
  experiment.refs.superpowers_by_arm = {
    'variant-a': 'b'.repeat(40),
    'variant-b': 'c'.repeat(40),
  };
  const block = blockActivation(experiment);
  const observations = block.attempts.map((_, i) =>
    observation(block, i, 4 + i, { outcome: i === 0 ? 'fail' : 'pass' }),
  );
  const state = [
    ...sessionTransitions(experiment),
    transition('block_activated', block, 3),
    ...observations.map((obs, i) =>
      transition(
        'attempt_observed',
        { observation: obs, excluded_block: null },
        4 + i,
      ),
    ),
    transition(
      'block_validated',
      { block_id: 'primary', evidence_refs: [evidenceRef] },
      6,
    ),
    transition(
      'ended',
      { outcome: 'completed', reason: 'done', cancel_intent: null },
      7,
    ),
  ].reduce(foldTransition, initialProjection(experiment));
  const report = foldComparisonReport({
    experiment,
    state,
    evidenceByAttempt: new Map(
      observations.map((obs, i) => [
        obs.execution_attempt_id,
        {
          ...missingAttemptEvidence(),
          publication_valid: true,
          observed_outcome: obs.outcome,
          subject_cost_usd: i === 0 ? 1 : 4,
          subject_cost_complete: true,
        },
      ]),
    ),
    validityByBlock: new Map([['primary', { available: true, reasons: [] }]]),
  });
  return {
    report,
    anchor: {
      campaign_id: experiment.campaign_id,
      input_digest: experiment.input_digest,
      last_sequence: state.transitions.size,
      prefix_digest: 'a'.repeat(64),
      roots: { campaign: '/fixture', results: '/fixture/results' },
      artifacts: [],
    },
  };
}
test('named baseline and treatment roles survive treatment-first arm rows in JSON and Markdown', () => {
  const value = namedRoleFixture();
  const comparison = value.report.comparisons[0]!;
  expect(comparison.arms.map((arm) => arm.arm)).toEqual([
    'variant-b',
    'variant-a',
  ]);
  expect(comparison.roles).toEqual({
    baseline: 'variant-a',
    treatment: 'variant-b',
  });
  expect(comparison.paired.pass_rate).toEqual({
    n: 1,
    baseline_mean: 0,
    treatment_mean: 1,
    mean_delta: 1,
  });
  expect(comparison.paired.subject_cost_usd).toEqual({
    n: 1,
    baseline_mean: 1,
    treatment_mean: 4,
    mean_delta: 3,
  });
  const md = renderReportMd(value);
  expect(md).toContain('Baseline: **variant-a**; treatment: **variant-b**.');
  expect(md).toContain('| variant-b | treatment |');
  expect(md).toContain('| variant-a | baseline |');
  expect(md).toContain('Baseline mean (variant-a)');
  expect(md).toContain('Treatment mean (variant-b)');
  expect(md).toContain('Mean paired delta (variant-b − variant-a)');
});
test('single-arm reports carry an explicit arm identity and render no paired role claims', () => {
  const value = namedRoleFixture(true);
  expect(value.report.comparisons[0]!.roles).toEqual({ arm: 'variant-a' });
  expect(value.report.comparisons[0]!.paired.pass_rate.n).toBe(0);
  const md = renderReportMd(value);
  expect(md).toContain('Single arm: **variant-a**. No paired comparison.');
  expect(md).toContain('| variant-a | single |');
  expect(md).not.toContain('Baseline mean');
});

test('single-arm quantities include indeterminate work while pass rates require determinate outcomes', () => {
  const fixture = singleArmComparisonFixture();
  const report = foldComparisonReport(fixture);
  const arm = report.comparisons[0]!.arms[0]!;
  expect(arm).toMatchObject({
    denominator: 3,
    pass: 1,
    fail: 1,
    indeterminate: 1,
    pass_rate: { n: 2, rate: 0.5 },
    available: {
      subject_cost_usd: 3,
      grader_cost_usd: 2,
      wall_seconds: 3,
      subject_tokens: 2,
      grader_tokens: 2,
    },
    means: {
      subject_cost_usd: 36.6666666666667,
      grader_cost_usd: 5,
      wall_seconds: 13.3333333333333,
      subject_tokens: 505,
      grader_tokens: 470,
    },
  });
  expect(report.comparisons[0]!.paired.pass_rate.n).toBe(0);
  expect(report.arm_accounting).toEqual([
    { arm: 'base', accounting: report.accounting },
  ]);
  expect(report.accounting.subject_cost_usd).toEqual({
    known_subtotal: 110,
    observed: 3,
    attempts: 3,
    complete: true,
  });
  expect(report.accounting.grader_cost_usd).toEqual({
    known_subtotal: 10.5,
    observed: 2,
    attempts: 3,
    complete: false,
  });
  expect(report.accounting.wall_seconds.known_subtotal).toBe(40);
  expect(report.elapsed.seconds).toBe(24);
  const json = JSON.parse(JSON.stringify(report));
  expect(ComparisonReportSchema.parse(json)).toEqual(report);
  const md = renderReportMd({
    report,
    anchor: {
      campaign_id: report.campaign_id,
      input_digest: report.input_digest,
      last_sequence: fixture.state.transitions.size,
      prefix_digest: 'a'.repeat(64),
      roots: { campaign: '/fixture', results: '/fixture/results' },
      artifacts: [],
    },
  });
  expect(md).toContain('| base | 2 | 0.5 |');
  expect(md).toContain('| base | grader_cost_usd | 2 | 5 |');
  expect(md).toContain('Campaign elapsed (start claim → execution end): 24 s');
  expect(md).toContain('All-attempt arm accounting: base');
});

test('indeterminate grading does not erase authenticated subject cost measurements', () => {
  const f = singleArmComparisonFixture();
  const result = foldComparisonReport(f);
  const arm = result.comparisons[0]!.arms[0]!;
  expect(arm.pass_rate.n).toBe(2);
  expect(arm.available.subject_cost_usd).toBe(3);
  expect(arm.means.subject_cost_usd).toBeCloseTo(110 / 3);
});

test('suite accepts hash-bound measurement requirements for authenticated intake', () => {
  const f = singleArmComparisonFixture();
  const suite = {
    ...f.experiment.suite,
    measurement_requirements: {
      path: 'requirements.json',
      sha256: 'a'.repeat(64),
    },
  };
  expect(ExperimentSchema.safeParse({ ...f.experiment, suite }).success).toBe(
    true,
  );
});

test('requirements freeze rubric and check identity and reject changed consumed bytes', () => {
  const name = 'conversation-code-review';
  const path = 'examples/campaigns/validation/requirements.json';
  const files = Object.fromEntries(
    [
      path,
      `scenarios/${name}/story.md`,
      `scenarios/${name}/checks-manifest.json`,
    ].map((p) => [p, readFileSync(p, 'utf8')]),
  );
  const reference = { path, sha256: sha256Hex(files[path]!) };
  const requirements = resolveMeasurementRequirements({
    files,
    scenarios: [name],
    reference,
  });
  expect(requirements[name]!.criteria).toHaveLength(6);
  expect(requirements[name]!.criteria[5]!.required_artifact_classes).toEqual([
    'visible_delivery',
    'output',
  ]);
  files[`scenarios/${name}/checks-manifest.json`] += '\n';
  expect(() =>
    resolveMeasurementRequirements({ files, scenarios: [name], reference }),
  ).toThrow();
});

test('obligations preserve completed checks and interaction while missing assessment criteria stay unavailable', () => {
  const f = singleArmComparisonFixture();
  f.experiment.measurement_requirements = {
    scenario: {
      mode: 'conversation',
      story_sha256: 'a'.repeat(64),
      rubric_sha256: 'b'.repeat(64),
      check_manifest_sha256: 'c'.repeat(64),
      criteria: [
        {
          id: 'scenario:1',
          ordinal: 1,
          text: 'Grounded review',
          required_artifact_classes: ['visible_delivery', 'output'],
          check_refs: [],
        },
      ],
      checks: [
        {
          ordinal: 0,
          phase: 'post',
          check: 'file-exists',
          args: ['answer'],
          negated: false,
          count: 1,
          authority: { kind: 'output_check', sources: ['checks.sh'] },
        },
      ],
    },
  };
  for (const e of f.evidenceByAttempt.values()) {
    e.gauntlet = null;
    e.checks = [
      {
        phase: 'post',
        check: 'file-exists',
        args: ['answer'],
        negated: false,
        passed: false,
        checker_status: 'completed',
        detail: 'missing',
      },
    ];
  }
  f.state.experiment = f.experiment;
  const arm = foldComparisonReport(f).comparisons[0]!.arms[0]!;
  expect(arm.measurements.checks[0]).toMatchObject({
    planned: 3,
    pass: 0,
    fail: 3,
    unavailable: 0,
  });
  expect(arm.measurements.criteria[0]).toMatchObject({
    planned: 3,
    pass: 0,
    fail: 0,
    unavailable: 3,
  });
});

function qualificationFixture() {
  const experiment = singleArmComparisonFixture().experiment;
  const casePath = 'test/fixtures/assessment-validation/manifest.json';
  const manifestBytes = readFileSync(casePath, 'utf8');
  const cases = JSON.parse(manifestBytes);
  const rubric = cases.cases[0].rubric_sha256;
  experiment.measurement_requirements = {
    scenario: {
      mode: 'conversation',
      story_sha256: 'a'.repeat(64),
      rubric_sha256: rubric,
      check_manifest_sha256: 'b'.repeat(64),
      criteria: Array.from({ length: 6 }, (_, i) => ({
        id: `scenario:${i + 1}`,
        ordinal: i + 1,
        text: `criterion ${i + 1}`,
        required_artifact_classes: [],
        check_refs: [],
        requires_assessment_qualification: true,
      })),
      checks: [],
    },
  };
  experiment.role_budgets = {
    'comparison:scenario': {
      base: {
        subject_ms: 1000,
        assessment_ms: 600000,
        assessment_report_grace_ms: 60000,
        overhead_ms: 900000,
      },
    },
  };
  const credential = CredentialSchema.parse({
    model: experiment.grader.model,
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    api_key_env: 'GRADER_KEY',
  });
  const files: Record<string, string> = {
    'src/a.ts': 'export const a = 1;',
    'package.json': '{}',
    'bun.lock': '{}',
    [casePath]: manifestBytes,
  };
  const semantics = sha256Hex(
    jcsCanonicalize(
      Object.fromEntries(
        ['bun.lock', 'package.json', 'src/a.ts'].map((p) => [
          p,
          sha256Hex(files[p]!),
        ]),
      ),
    ),
  );
  const record = {
    schema_version: 1,
    gauntlet_sha: experiment.refs.gauntlet,
    grader: {
      ...experiment.grader,
      configuration_sha256: sha256Hex(jcsCanonicalize(credential)),
    },
    evidence_semantics_sha256: semantics,
    scopes: [
      {
        scenario: 'scenario',
        rubric_sha256: rubric,
        criterion_ids: Array.from({ length: 6 }, (_, i) => `scenario:${i + 1}`),
        assessment_ms: 600000,
        report_grace_ms: 60000,
        case_manifest: { path: casePath, sha256: sha256Hex(manifestBytes) },
        private_receipt_sha256: 'd'.repeat(64),
        observations: cases.cases.flatMap(
          (c: {
            id: string;
            expected: Array<{ criterion: number; verdict: string }>;
          }) =>
            Array.from({ length: cases.assessments_per_case }, (_, i) => ({
              case_id: c.id,
              replicate: i + 1,
              completed: true,
              criteria: c.expected.map((r) => ({
                criterion: r.criterion,
                verdict: r.verdict,
                reason_support: 'supported',
              })),
              cost: {
                subject: { known_subtotal: 0, complete: false },
                grader: { known_subtotal: 0.1, complete: false },
              },
            })),
        ),
      },
    ],
  };
  const bind = () => {
    files['qualification.json'] = JSON.stringify(record);
    experiment.suite.assessment_qualification = {
      path: 'qualification.json',
      sha256: sha256Hex(files['qualification.json']),
    };
  };
  bind();
  return { experiment, credential, files, record, bind };
}

test('qualification verifies every frozen public case and replicate while unknown costs stay separate', () => {
  const f = qualificationFixture();
  expect(evaluateQualification(f)).toMatchObject({
    scopes: [{ scenario: 'scenario', status: 'qualified' }],
  });
  f.record.scopes[0]!.observations.pop();
  f.bind();
  expect(evaluateQualification(f)).toMatchObject({
    scopes: [{ status: 'unverified' }],
  });
});

test('qualification rejects source/model/budget/reason drift without changing judgment availability', () => {
  for (const damage of [
    'source',
    'model',
    'budget',
    'reason',
    'verdict',
    'digest',
  ] as const) {
    const f = qualificationFixture();
    if (damage === 'source') f.files['src/a.ts'] += '\n';
    if (damage === 'model') f.record.grader.model = 'other';
    if (damage === 'budget') f.record.scopes[0]!.assessment_ms = 500000;
    if (damage === 'reason')
      f.record.scopes[0]!.observations[0]!.criteria[0]!.reason_support =
        'unsupported';
    if (damage === 'verdict')
      f.record.scopes[0]!.observations[0]!.criteria[0]!.verdict = 'fail';
    f.bind();
    if (damage === 'digest') {
      f.files['qualification.json'] += '\n';
      expect(() => evaluateQualification(f)).toThrow();
    } else
      expect(evaluateQualification(f)).toMatchObject({
        scopes: [{ status: 'unverified' }],
      });
  }
});

test('criterion pairs have their own denominator even when aggregate outcomes are indeterminate', () => {
  const f = mixedComparisonFixture();
  f.experiment.measurement_requirements = {
    scenario: {
      mode: 'qa',
      story_sha256: 'a'.repeat(64),
      rubric_sha256: 'b'.repeat(64),
      check_manifest_sha256: 'c'.repeat(64),
      criteria: [
        {
          id: 'scenario:1',
          ordinal: 1,
          text: 'Observed obligation',
          required_artifact_classes: [],
          check_refs: [],
        },
      ],
      checks: [],
    },
  };
  f.state.experiment = f.experiment;
  for (const e of f.evidenceByAttempt.values())
    e.gauntlet = {
      status: 'pass',
      summary: 's',
      reasoning: 'r',
      run_id: 'g',
      criteria: [
        {
          criterion: 'Observed obligation',
          verdict: 'pass',
          evidence: 'accepted report',
        },
      ],
    };
  const result = foldComparisonReport(f);
  expect(result.comparisons[0]!.paired_criteria[0]).toMatchObject({
    planned: 4,
    quantity: { n: 3, mean_delta: 0 },
  });
  expect(result.comparisons[0]!.paired.pass_rate.n).toBe(2);
});

test('unqualified scoped judgments remain visible but cannot become qualified quality claims', () => {
  const f = singleArmComparisonFixture();
  f.experiment.measurement_requirements = {
    scenario: {
      mode: 'qa',
      story_sha256: 'a'.repeat(64),
      rubric_sha256: 'b'.repeat(64),
      check_manifest_sha256: 'c'.repeat(64),
      criteria: [
        {
          id: 'scenario:1',
          ordinal: 1,
          text: 'Grounded review',
          required_artifact_classes: [],
          check_refs: [],
          requires_assessment_qualification: true,
        },
      ],
      checks: [],
    },
  };
  f.state.experiment = f.experiment;
  for (const e of f.evidenceByAttempt.values())
    e.gauntlet = {
      status: 'pass',
      summary: 's',
      reasoning: 'r',
      run_id: 'g',
      criteria: [
        {
          criterion: 'Grounded review',
          verdict: 'pass',
          evidence: 'accepted report',
        },
      ],
    };
  const r = foldComparisonReport(f);
  expect(r.comparisons[0]!.arms[0]!.measurements.criteria[0]).toMatchObject({
    pass: 3,
    qualification: 'unverified',
  });
  const md = renderReportMd({
    report: r,
    anchor: {
      campaign_id: r.campaign_id,
      input_digest: r.input_digest,
      last_sequence: 1,
      prefix_digest: 'a'.repeat(64),
      roots: { campaign: '/fixture', results: '/fixture/results' },
      artifacts: [],
    },
  });
  expect(md).toContain('cannot support a quality conclusion');
  expect(md).toContain(f.experiment.refs.superpowers_by_arm['base']!);
});

test('report schema rejects quantity cohorts larger than eligible arm observations', () => {
  const r = foldComparisonReport(mixedComparisonFixture());
  r.comparisons[0]!.paired.subject_cost_usd.n = 99;
  expect(ComparisonReportSchema.safeParse(r).success).toBe(false);
});

test('undeclared checker authority stays unclassified instead of inventing an oracle scope', () => {
  const name = 'conversation-code-review';
  const files = Object.fromEntries(
    ['story.md', 'checks-manifest.json'].map((file) => [
      `scenarios/${name}/${file}`,
      readFileSync(`scenarios/${name}/${file}`, 'utf8'),
    ]),
  );
  const requirements = resolveMeasurementRequirements({
    files,
    scenarios: [name],
  });
  expect(
    requirements[name]!.checks.every(
      (c) => c.authority.kind === 'unclassified',
    ),
  ).toBe(true);
});

test('incomplete grader usage retains known tokens in accounting but not complete token means', () => {
  const f = singleArmComparisonFixture();
  const last: AttemptEvidence = [...f.evidenceByAttempt.values()].at(-1)!;
  last.missingness.push({
    field: 'grader_tokens',
    reason: 'known subtotal only; request usage incomplete',
  });
  const r = foldComparisonReport(f);
  expect(r.comparisons[0]!.arms[0]!.available.grader_tokens).toBe(1);
  expect(r.accounting.grader_tokens).toEqual({
    known_subtotal: 940,
    observed: 1,
    attempts: 3,
    complete: false,
  });
});
