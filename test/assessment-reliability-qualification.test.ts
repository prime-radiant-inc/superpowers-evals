import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAdditionalControls,
  loadQualificationInputs,
} from '../docs/experiments/2026-09-09-conversation-assessor-reliability/qualification-inputs.ts';
import {
  summarizeQualification,
  verifyQualificationReview,
  writeQualificationReviewInput,
} from '../docs/experiments/2026-09-09-conversation-assessor-reliability/qualification-review.ts';
import {
  prepareFreshCohort,
  runReliabilityQualification,
} from '../docs/experiments/2026-09-09-conversation-assessor-reliability/qualify.ts';
import { getEnv } from '../src/env.ts';
import {
  type QualificationMeasurement,
  qualificationRef,
  writeQualificationJson,
} from '../src/runner/qualification-evidence.ts';
import { executeQualificationRole } from '../src/runner/qualification-role.ts';
import {
  type QualificationSession,
  runQualificationSessions,
} from '../src/runner/qualification-set.ts';

const roots: string[] = [];
function temporary(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'reliability-qualification-')),
  );
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('additional control approval cannot be replaced by caller-authored JSON', () => {
  expect(() => loadAdditionalControls(temporary())).toThrow();
});

const privateRoot = getEnv('RELIABILITY_PRIVATE_ROOT');
const retainedRoot = getEnv('ROUTINE_PRIVATE_CASE_ROOT');
const supplementalRoot = getEnv('ASSESSMENT_CONTROL_ROOT');
const gRoot = getEnv('GAUNTLET_ROOT');
test.skipIf(!privateRoot)(
  'corrected v2 receipt authenticates additional inputs and preserves its review provenance',
  () => {
    const controls = loadAdditionalControls(privateRoot!);
    expect(controls.map((c) => c.id)).toEqual([
      'additional-01',
      'additional-02',
    ]);
    expect(controls.map((c) => c.expected)).toEqual([
      ['pass', 'pass'],
      ['fail', 'fail'],
    ]);
    expect(controls.every((c) => c.evidenceRoot.endsWith('/evidence'))).toBe(
      true,
    );
  },
);
test.skipIf(!privateRoot || !retainedRoot || !supplementalRoot || !gRoot)(
  'authenticated schedule keeps 18/180, 8/16 and 2/4 separate and reuses twelve driver situations',
  async () => {
    const inputs = await loadQualificationInputs({
      qRoot: privateRoot!,
      gRoot: gRoot!,
      retainedRoot: retainedRoot!,
      supplementalRoot: supplementalRoot!,
    });
    expect(
      inputs.assessments.filter((s) => s.group === 'retained'),
    ).toHaveLength(18);
    expect(
      inputs.assessments.filter((s) => s.group === 'supplemental'),
    ).toHaveLength(8);
    expect(
      inputs.assessments.filter((s) => s.group === 'additional'),
    ).toHaveLength(2);
    for (const [group, judgments] of [
      ['retained', 180],
      ['supplemental', 16],
      ['additional', 4],
    ] as const) {
      expect(
        inputs.assessments
          .filter((s) => s.group === group)
          .reduce((sum, s) => {
            const role = inputs.role(s);
            expect(role.kind).toBe('assessment');
            return (
              sum + (role.kind === 'assessment' ? role.expected.length : 0)
            );
          }, 0),
      ).toBe(judgments);
    }
    expect(inputs.drivers).toHaveLength(12);
    const preference = inputs.role(inputs.drivers[0]!);
    expect(preference).toMatchObject({
      kind: 'driver',
      subjectCase: 'preferences',
    });
    if (preference.kind !== 'driver') throw Error('wrong role');
    expect(preference.briefPath).toContain(
      '2026-09-09-conversation-assessor-reliability/driver/briefs/preferences.md',
    );
    expect(preference.subjectScriptPath).toContain(
      '2026-09-08-conversation-routine-use/driver/subject.ts',
    );
    expect(() =>
      inputs.role({ id: 'additional-01', group: 'retained', repetition: 1 }),
    ).toThrow();
    inputs.validate();
  },
);

function assessmentFixture(mode: string, criterionCount = 2) {
  const root = temporary();
  const gRoot = join(root, 'g');
  mkdirSync(join(gRoot, 'src/format'), { recursive: true });
  mkdirSync(join(gRoot, 'src/util'));
  const criteria = Array.from(
    { length: criterionCount },
    (_, i) => `Criterion ${i + 1}`,
  );
  writeFileSync(
    join(gRoot, 'src/format/story-card.ts'),
    `export const parseStoryCard = () => ({ id: 'fixture', acceptanceCriteria: ${JSON.stringify(criteria)} });`,
  );
  writeFileSync(
    join(gRoot, 'src/util/id.ts'),
    `export const makeRunId = id => id + '_20260909T000000Z_abcd';`,
  );
  writeFileSync(
    join(gRoot, 'src/index.ts'),
    `
    import { createHash } from 'node:crypto';
    import { writeFileSync } from 'node:fs';
    import { basename, join } from 'node:path';
    const mode = ${JSON.stringify(mode)};
    const args = process.argv.slice(2), get = key => args[args.indexOf(key) + 1];
    if (args[0] !== 'assess' || get('--max-time') !== '2m' || !get('--hard-deadline-at-ms') || args.some(s => /expectation|gold|receipt/.test(s))) throw Error('wrong assessor boundary');
    const out = get('--out');
    const write = (name, rows) => writeFileSync(join(out, name), rows.map(r => JSON.stringify(r)).join('\\n') + '\\n');
    const model = mode === 'wrong-model' ? 'claude-opus-4-8' : 'anthropic.claude-sonnet-5';
    const identity = { assessment_request_id: '001', assessment_attempt_id: '001' };
    const run = [
      { type: 'llm_request', turn: 1, assessment_request_id: '001' },
      { type: 'llm_response', turn: 1, assessment_request_id: '001' },
      { type: 'tool_call', name: 'report_result', turn: 1, toolUseId: 'bad', arguments: { criteria: '<draft>' } },
      { type: 'tool_result', name: 'report_result', turn: 1, toolUseId: 'bad', error: true },
      { type: 'llm_request', turn: 2, assessment_request_id: '002' },
      { type: 'llm_response', turn: 2, assessment_request_id: '002' },
      { type: 'tool_call', name: 'report_result', turn: 2, toolUseId: 'good' },
      { type: 'run_end', usage: { turns: 2 } },
    ];
    if (mode === 'pending') run.splice(5);
    write('run.jsonl', run);
    const admissions = [], usage = [];
    for (let i = 1; i <= 3; i++) {
      const id = String(i).padStart(3, '0');
      const ids = { assessment_request_id: i === 3 ? '002' : '001', assessment_attempt_id: id };
      admissions.push({ ...ids, schema_version: 1, event: 'admission', timestamp_ms: i, outcome: 'admitted', provider: 'anthropic', model });
      admissions.push({ ...ids, schema_version: 1, event: 'settlement', timestamp_ms: i + 1, outcome: i === 1 ? 'transport_error' : 'response', usage: i === 1 ? 'not_returned' : 'recorded', ...(i === 1 ? { usage_unavailable: 'api_error' } : {}), accounting_failure: mode === 'accounting' && i === 3, capture: 'disabled' });
      if (i > 1) usage.push({ ...ids, type: 'obol.usage', v: '2026-06-08', provider: 'anthropic', model, cost_usd: 0.1, usage: { input_tokens: 3, output_tokens: 2 } });
    }
    if (mode === 'invalid-usage') usage[1].usage.input_tokens = -1;
    write('assessment-attempts.jsonl', admissions);
    write('usage.jsonl', usage);
    const result = { runId: basename(out), scenario: 'fixture', status: 'pass', summary: 'Complete', reasoning: 'Because evidence', criteria: ${JSON.stringify(criteria)}.map(criterion => ({criterion, verdict: 'pass', evidence: 'Observed synthetic evidence'})), usage: { turns: 2 } };
    if (mode === 'wrong-criterion') result.criteria[1].criterion = 'Changed';
    writeFileSync(join(out, 'result.json'), JSON.stringify(result));
    if (mode !== 'no-completion') writeFileSync(join(out, 'assessment-completion.json'), JSON.stringify({ schema_version: 1, run_id: basename(out), status: 'completed', reason: 'valid native report', terminal_at: new Date().toISOString(), accepted_report_sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') }));
    if (mode === 'wrong-exit') process.exitCode = 1;
    if (mode === 'publication') writeFileSync(join(process.cwd(), 'qualification-role.json'), 'existing private artifact');
  `,
  );
  const evidenceRoot = join(root, 'evidence');
  mkdirSync(evidenceRoot);
  writeFileSync(
    join(evidenceRoot, 'index.json'),
    '{"files":["conversation.md"]}',
  );
  writeFileSync(join(evidenceRoot, 'conversation.md'), 'Evidence only');
  const rubricPath = join(root, 'rubric.md');
  writeFileSync(rubricPath, 'Rubric only');
  return {
    gRoot,
    runDir: root,
    model: 'anthropic.claude-sonnet-5' as const,
    env: {},
    stopped: () => false,
    role: {
      kind: 'assessment' as const,
      rubricPath,
      evidenceRoot,
      evidenceIndexPath: join(evidenceRoot, 'index.json'),
      expected: criteria.map(() => 'pass' as const),
      groups: [
        { originalOrdinal: 1, atomicOrdinals: criteria.map((_, i) => i + 1) },
      ],
      originalVerdicts: ['pass'] as ('pass' | 'fail' | 'unclear')[],
    },
  };
}

test('closed unknown retry usage permits a corrected accepted report and remains unknown in metrics', async () => {
  const f = assessmentFixture('valid');
  const result = await executeQualificationRole(f);
  expect(result).toMatchObject({
    complete: true,
    semanticMatch: true,
    fault: null,
  });
  expect(result.knownUsd).toBeGreaterThan(0);
  const metrics = JSON.parse(
    readFileSync(join(f.runDir, 'qualification-role.json'), 'utf8'),
  );
  expect(metrics).toMatchObject({
    accepted: true,
    firstReportValid: false,
    eventualReportCompletion: true,
    logicalAttempts: 2,
    logicalResponses: 2,
    physicalAttempts: 3,
    corrections: 1,
    unknownUsageAttemptIds: ['001'],
    costComplete: false,
    totalUsd: null,
  });
  expect(metrics.latencyMs).toBeGreaterThanOrEqual(0);
});

test('measurement publication failure stops admission without erasing settled known cost', async () => {
  const f = assessmentFixture('publication');
  const result = await executeQualificationRole(f);
  expect(result.complete).toBe(false);
  expect(result.knownUsd).toBeGreaterThan(0);
  expect(result.fault).not.toBeNull();
  expect(readFileSync(join(f.runDir, 'qualification-role.json'), 'utf8')).toBe(
    'existing private artifact',
  );
});

test.each([
  'accounting',
  'pending',
  'wrong-criterion',
  'no-completion',
  'invalid-usage',
  'wrong-exit',
  'wrong-model',
])('%s rejects acceptance and retains valid known cost', async (mode) => {
  const f = assessmentFixture(mode);
  const result = await executeQualificationRole(f);
  expect(result.complete).toBe(false);
  expect(result.fault).not.toBeNull();
  expect(result.knownUsd).toBeGreaterThan(0);
  const metrics = JSON.parse(
    readFileSync(join(f.runDir, 'qualification-role.json'), 'utf8'),
  );
  expect(metrics.accepted).toBe(false);
  expect(metrics.actual).toBeNull();
  if (mode === 'wrong-exit')
    expect(metrics.eventualReportCompletion).toBe(true);
});
const retainedIds = [
  'claude-design',
  'known-claude-design',
  'known-codex-review',
  'codex-design',
  'known-claude-review',
  'claude-debugging-history',
  'codex-debugging-history',
  'control-e',
  'control-f',
];
const supplementalIds = Array.from(
  { length: 8 },
  (_, i) => `control-0${i + 1}`,
);
const sessions: QualificationSession[] = [
  ...retainedIds.flatMap((id) =>
    [1, 2].map((repetition) => ({
      id,
      repetition,
      group: 'retained' as const,
    })),
  ),
  ...supplementalIds.map((id) => ({
    id,
    repetition: 1,
    group: 'supplemental' as const,
  })),
  ...['additional-01', 'additional-02'].map((id) => ({
    id,
    repetition: 1,
    group: 'additional' as const,
  })),
];
const settled = {
  knownUsd: 0.1,
  complete: true,
  semanticMatch: true,
  fault: null,
};

function readoutRow(
  session: QualificationSession,
  judgments: number,
  accepted = true,
  semanticMatch = true,
) {
  return {
    session,
    judgments,
    matchingJudgments: accepted ? (semanticMatch ? judgments : 0) : null,
    refs: [] as ReturnType<typeof qualificationRef>[],
    settlement: { ...settled, complete: accepted, semanticMatch },
    measurement: {
      accepted,
      actual: accepted
        ? Array.from({ length: judgments }, () => 'pass' as const)
        : null,
      firstReportValid: false,
      eventualReportCompletion: accepted,
      logicalAttempts: 3,
      logicalResponses: accepted ? 3 : 2,
      physicalAttempts: 3,
      corrections: 1,
      unknownUsageAttemptIds: ['001'],
      costComplete: false,
      knownUsd: 0.1,
      totalUsd: null,
      latencyMs: 10,
    } as QualificationMeasurement,
  };
}
test('readout separates declared and admitted denominators and excludes failed drafts from semantic accuracy', () => {
  const declared = sessions.map((session) => ({
    session,
    judgments: session.group === 'retained' ? 10 : 2,
  }));
  const rows = [
    readoutRow(sessions[0]!, 10, false),
    readoutRow(sessions[1]!, 10, true, false),
    readoutRow(sessions[18]!, 2),
  ];
  const result = summarizeQualification(declared, rows);
  expect(result.groups.retained).toMatchObject({
    declaredSessions: 18,
    declaredJudgments: 180,
    admittedSessions: 2,
    acceptedReports: 1,
    acceptedJudgments: 10,
    correctSessions: 0,
    semanticAgreement: 0,
    overallCorrectSessions: 0,
    eventualReportCompletions: 1,
  });
  expect(result.groups.supplemental).toMatchObject({
    declaredSessions: 8,
    declaredJudgments: 16,
    admittedSessions: 1,
    acceptedReports: 1,
    acceptedJudgments: 2,
    correctSessions: 1,
    semanticAgreement: 1,
  });
  expect(result.groups.additional).toMatchObject({
    declaredSessions: 2,
    declaredJudgments: 4,
    admittedSessions: 0,
    semanticAgreement: null,
  });
  expect(result).toMatchObject({
    admittedSessions: 3,
    logicalAttempts: 9,
    physicalAttempts: 9,
    corrections: 3,
    knownUsd: 0.3,
    totalUsd: null,
    unknownUsageAttempts: 3,
    latencyMs: 30,
  });
});
test('zero accepted reports has undefined semantic agreement and keeps interrupted sessions in overall denominator', () => {
  const row = readoutRow(sessions[0]!, 10, false);
  expect(
    summarizeQualification([{ session: row.session, judgments: 10 }], [row])
      .groups.retained,
  ).toMatchObject({
    acceptedReports: 0,
    acceptedJudgments: 0,
    semanticAgreement: null,
    overallCorrectSessions: 0,
    admittedSessions: 1,
  });
});

function syntheticReviewFixture(
  stage: 'assessment' | 'driver' = 'assessment',
  prior?: {
    benchmark: ReturnType<typeof qualificationRef>;
    receiptPath: string;
  },
) {
  const root = temporary();
  const benchmark =
    prior?.benchmark ??
    qualificationRef(
      join(
        import.meta.dir,
        '../docs/experiments/2026-09-09-conversation-assessor-reliability/benchmark-version.json',
      ),
    );
  const candidate = { qSha: 'a'.repeat(40), gSha: 'b'.repeat(40) };
  const declared =
    stage === 'assessment'
      ? sessions.map((session) => ({
          session,
          judgments:
            session.group === 'retained'
              ? [10, 10, 6, 10, 6, 11, 11, 13, 13][
                  retainedIds.indexOf(session.id)
                ]!
              : 2,
        }))
      : [
          'preferences',
          'engineering',
          'authorization',
          'plan-delivery',
          'feedback-endpoint',
          'partial-refusal',
        ].flatMap((id) =>
          [1, 2].map((repetition) => ({
            session: { id, repetition, group: 'driver' as const },
            judgments: 0,
          })),
        );
  const rows = declared.map(({ session, judgments }, i) => {
    const directory = join(root, String(i + 1));
    mkdirSync(directory);
    const evidence = writeQualificationJson(join(directory, 'evidence.json'), {
      fixture: 'synthetic decisive evidence',
    });
    const vector = Array.from({ length: judgments }, () => 'pass');
    const result = writeQualificationJson(join(directory, 'result.json'), {
      criteria: vector.map((verdict) => ({ verdict })),
      fixture: 'synthetic accepted result',
    });
    const expectation = writeQualificationJson(
      join(directory, 'expectation.json'),
      {
        expected: vector,
        groups: vector.map((_, j) => ({
          originalOrdinal: j + 1,
          atomicOrdinals: [j + 1],
        })),
        originalVerdicts: vector,
      },
    );
    const row = readoutRow(session, judgments);
    row.measurement = {
      ...row.measurement,
      kind: stage,
      result,
      inputs: [evidence],
      artifacts: [result],
      expectation,
    };
    return {
      ...row,
      refs: [
        writeQualificationJson(join(directory, 'launch.json'), {
          ordinal: i + 1,
          id: session.id,
          repetition: session.repetition,
        }),
        writeQualificationJson(join(directory, 'settled.json'), row.settlement),
        writeQualificationJson(
          join(directory, 'qualification-role.json'),
          row.measurement,
        ),
      ],
    };
  });
  const input = writeQualificationReviewInput({
    outputRoot: root,
    stage,
    author: 'synthetic-author',
    candidate,
    benchmark,
    benchmarkVersion: 'conversation-design-selective-notifications-v2',
    declared,
    rows,
    priorReview: prior ? qualificationRef(prior.receiptPath) : null,
  });
  const receipt = {
    kind: 'qualification-review',
    schemaVersion: 1,
    input,
    reviewer: 'synthetic-independent-reviewer',
    independent: true,
    rows: rows.map((row, i) => ({
      ordinal: i + 1,
      confirmed: true,
      rationale: 'Synthetic fixture rationale only',
      criteria: Array.from({ length: row.judgments }, (_, j) => ({
        ordinal: j + 1,
        decisive: true,
        rationale: 'Synthetic fixture decisive reasoning',
        evidence: [
          { path: row.measurement.inputs[0]!.path, locator: 'fixture line 1' },
        ],
      })),
      evidence: [
        {
          path: row.measurement.inputs[0]!.path,
          locator: 'synthetic fixture line 1',
        },
      ],
      preferenceActs:
        stage === 'driver' && row.session.id === 'preferences'
          ? [
              {
                question: 'channel',
                act: { kind: 'answer', facts: ['in-page', 'local-browser'] },
              },
              {
                question: 'remaining-preferences',
                act: {
                  kind: 'answer',
                  facts: [
                    'in-page',
                    'selective-notifications',
                    'local-browser',
                  ],
                },
              },
              { question: 'delivery', act: { kind: 'stop', facts: [] } },
            ].map((a) => ({
              ...a,
              evidence: [
                {
                  path: row.measurement.inputs[0]!.path,
                  locator: 'synthetic fixture line 1',
                },
              ],
            }))
          : [],
    })),
  };
  const receiptPath = join(root, 'synthetic-review.json');
  writeQualificationJson(receiptPath, receipt);
  return { root, candidate, benchmark, rows, receipt, receiptPath, input };
}
test('preparing review input does not pass the gate; a separately bound complete independent review does', () => {
  const f = syntheticReviewFixture();
  expect(() =>
    verifyQualificationReview({
      receipt: f.input,
      stage: 'assessment',
      candidate: f.candidate,
      benchmark: f.benchmark,
    }),
  ).toThrow();
  expect(() =>
    verifyQualificationReview({
      receipt: qualificationRef(f.receiptPath),
      stage: 'assessment',
      candidate: f.candidate,
      benchmark: f.benchmark,
    }),
  ).not.toThrow();
});

test('partial wrapper execution retains the accepted result and all readout bindings before a later admission stop', async () => {
  const f = assessmentFixture('valid', 10);
  const outputRoot = temporary();
  const inputs = {
    benchmark: qualificationRef(
      join(
        import.meta.dir,
        '../docs/experiments/2026-09-09-conversation-assessor-reliability/benchmark-version.json',
      ),
    ),
    benchmarkVersion: 'conversation-design-selective-notifications-v2',
    refs: [],
    assessments: sessions,
    drivers: [],
    validate() {},
    role(session: QualificationSession) {
      const count =
        session.group === 'retained'
          ? [10, 10, 6, 10, 6, 11, 11, 13, 13][retainedIds.indexOf(session.id)]!
          : 2;
      return {
        ...f.role,
        expected: Array.from({ length: count }, () => 'pass' as const),
      };
    },
  };
  let checks = 0;
  const result = await runReliabilityQualification({
    inputs,
    stage: 'assessment',
    outputRoot,
    author: 'synthetic-author',
    candidate: { qSha: 'a'.repeat(40), gSha: 'b'.repeat(40) },
    gRoot: f.gRoot,
    env: {},
    now: () => 0,
    fits: () => checks++ === 0,
    stopped: () => false,
    validate() {},
  });
  expect(result).toMatchObject({ consumed: 1, complete: false });
  const readout = JSON.parse(
    readFileSync(join(outputRoot, 'readout.json'), 'utf8'),
  );
  expect(readout.groups.retained).toMatchObject({
    declaredSessions: 18,
    declaredJudgments: 180,
    admittedSessions: 1,
    acceptedReports: 1,
    matchingJudgments: 10,
  });
  const review = JSON.parse(
    readFileSync(join(outputRoot, 'rationale-review-input.json'), 'utf8'),
  );
  expect(review.rows[0].measurement.result.sha256).toHaveLength(64);
  expect(review.rows[0].measurement.inputs).toHaveLength(3);
  expect(review.independentReviewComplete).toBe(false);
  await expect(
    runReliabilityQualification({
      inputs: { ...inputs, assessments: sessions.slice(0, -1) },
      stage: 'assessment',
      outputRoot: temporary(),
      author: 'synthetic-author',
      candidate: { qSha: 'a'.repeat(40), gSha: 'b'.repeat(40) },
      gRoot: f.gRoot,
      env: {},
      now: () => 0,
      fits: () => false,
      stopped: () => false,
      validate() {},
    }),
  ).rejects.toThrow('fixed qualification schedule');
});
test('the complete twelve-session independent act review gates the versioned fresh 36-attempt proposal', () => {
  const assessment = syntheticReviewFixture();
  const driver = syntheticReviewFixture('driver', assessment);
  const proposal = prepareFreshCohort({
    qRoot: join(import.meta.dir, '..'),
    outputRoot: temporary(),
    candidate: assessment.candidate,
    assessmentReview: qualificationRef(assessment.receiptPath),
    driverReview: qualificationRef(driver.receiptPath),
  });
  const value = JSON.parse(readFileSync(proposal.path, 'utf8'));
  expect(value).toMatchObject({
    attempts: 36,
    benchmarkVersion: 'conversation-design-selective-notifications-v2',
    executionAuthorized: false,
  });
  expect(value.scenarios).toHaveLength(4);
  expect(value.scenarios.map((s: { id: string }) => s.id)).toEqual([
    'conversation-design',
    'conversation-code-review',
    'conversation-review-feedback',
    'conversation-config-repair',
  ]);
});
test.each([
  'missing-session',
  'wrong-preference',
  'wrong-version',
])('fresh gate rejects %s in the independently reviewed driver', (mode) => {
  const assessment = syntheticReviewFixture();
  const driver = syntheticReviewFixture('driver', assessment);
  if (mode === 'missing-session') driver.receipt.rows.pop();
  if (mode === 'wrong-preference')
    driver.receipt.rows[0]!.preferenceActs[0]!.act.facts = ['all-tasks'];
  if (mode === 'wrong-version') {
    const value = JSON.parse(readFileSync(driver.input.path, 'utf8'));
    value.benchmarkVersion = 'old-v1';
    writeFileSync(driver.input.path, JSON.stringify(value));
    driver.receipt.input = qualificationRef(driver.input.path);
  }
  writeFileSync(driver.receiptPath, JSON.stringify(driver.receipt));
  expect(() =>
    prepareFreshCohort({
      qRoot: join(import.meta.dir, '..'),
      outputRoot: temporary(),
      candidate: assessment.candidate,
      assessmentReview: qualificationRef(assessment.receiptPath),
      driverReview: qualificationRef(driver.receiptPath),
    }),
  ).toThrow();
});
test('driver cannot be admitted with automatic vector equality alone', async () => {
  const f = syntheticReviewFixture();
  await expect(
    runReliabilityQualification({
      stage: 'driver',
      outputRoot: temporary(),
      author: 'synthetic-author',
      candidate: f.candidate,
      inputs: { benchmark: f.benchmark } as Awaited<
        ReturnType<typeof loadQualificationInputs>
      >,
      gRoot: temporary(),
      env: {},
      now: () => 0,
      fits: () => true,
      stopped: () => false,
      validate() {},
    }),
  ).rejects.toThrow('independent assessment review');
});

test('driver admission revalidates the reviewed evidence after ownership validation and before launch', async () => {
  const f = syntheticReviewFixture();
  const outputRoot = temporary();
  const drivers = (
    [
      'preferences',
      'engineering',
      'authorization',
      'plan-delivery',
      'feedback-endpoint',
      'partial-refusal',
    ] as const
  ).flatMap((id) =>
    [1, 2].map((repetition) => ({ id, repetition, group: 'driver' as const })),
  );
  const inputs = {
    benchmark: f.benchmark,
    benchmarkVersion: 'conversation-design-selective-notifications-v2',
    refs: [],
    assessments: sessions,
    drivers,
    validate() {},
    role() {
      return {
        kind: 'driver' as const,
        briefPath: '/unused',
        subjectScriptPath: '/unused',
        subjectCase: 'preferences',
        expectedCompletion: 'delivery' as const,
      };
    },
  };
  await expect(
    runReliabilityQualification({
      inputs,
      stage: 'driver',
      outputRoot,
      author: 'synthetic-author',
      candidate: f.candidate,
      gRoot: temporary(),
      env: {},
      assessmentReview: qualificationRef(f.receiptPath),
      now: () => 0,
      fits: () => true,
      stopped: () => false,
      validate() {
        writeFileSync(
          f.rows[0]!.measurement.result!.path,
          'changed after initial gate',
        );
      },
    }),
  ).rejects.toThrow('digest mismatch');
  expect(existsSync(join(outputRoot, 'assessment-review.json'))).toBe(true);
  expect(existsSync(join(outputRoot, '01'))).toBe(false);
});
test.each([
  'self-review',
  'missing-criterion',
  'rejected',
  'wrong-source',
  'changed-result',
  'changed-measurement',
])('review gate rejects %s', (mode) => {
  const f = syntheticReviewFixture();
  if (mode === 'self-review') f.receipt.reviewer = 'synthetic-author';
  if (mode === 'missing-criterion') f.receipt.rows[0]!.criteria.pop();
  if (mode === 'rejected') f.receipt.rows[0]!.criteria[0]!.decisive = false;
  if (mode === 'changed-result')
    writeFileSync(f.rows[0]!.measurement.result!.path, 'changed');
  if (mode === 'changed-measurement') {
    const value = JSON.parse(readFileSync(f.input.path, 'utf8'));
    value.rows[0].measurement.logicalAttempts = 999;
    writeFileSync(f.input.path, JSON.stringify(value));
    f.receipt.input = qualificationRef(f.input.path);
  }
  writeFileSync(f.receiptPath, JSON.stringify(f.receipt));
  expect(() =>
    verifyQualificationReview({
      receipt: qualificationRef(f.receiptPath),
      stage: 'assessment',
      candidate:
        mode === 'wrong-source'
          ? { ...f.candidate, qSha: 'c'.repeat(40) }
          : f.candidate,
      benchmark: f.benchmark,
    }),
  ).toThrow();
});

test('declared assessments retain group counts and all later admissions after semantic misses', async () => {
  const root = temporary();
  const calls: QualificationSession[] = [];
  const result = await runQualificationSessions({
    sessions,
    outputRoot: root,
    now: () => 123,
    fits: () => true,
    stopped: () => false,
    validate() {},
    async execute(session, out) {
      expect(existsSync(join(out, 'launch.json'))).toBe(true);
      calls.push(session);
      return {
        ...settled,
        semanticMatch:
          session.id !== 'claude-design' && session.id !== 'control-01',
      };
    },
  });
  expect(calls.filter((s) => s.group === 'retained')).toHaveLength(18);
  expect(calls.filter((s) => s.group === 'supplemental')).toHaveLength(8);
  expect(calls.filter((s) => s.group === 'additional')).toHaveLength(2);
  expect(calls).toEqual(sessions);
  expect(result).toEqual({
    ...settled,
    knownUsd: 2.8,
    semanticMatch: false,
    consumed: 28,
  });
  expect(
    JSON.parse(readFileSync(join(root, '28/launch.json'), 'utf8')),
  ).toEqual({
    ordinal: 28,
    id: 'additional-02',
    repetition: 1,
    atMs: 123,
  });
});

test.each([
  'accounting',
  'evidence',
  'ownership',
])('%s failure preserves cost and stops the next assessment', async (fault) => {
  const root = temporary();
  let calls = 0;
  const result = await runQualificationSessions({
    sessions,
    outputRoot: root,
    now: () => 0,
    fits: () => true,
    stopped: () => false,
    validate() {},
    async execute() {
      calls++;
      return { ...settled, complete: false, fault };
    },
  });
  expect(calls).toBe(1);
  expect(result).toEqual({ ...settled, complete: false, fault, consumed: 1 });
  expect(existsSync(join(root, '02'))).toBe(false);
});

test('validation runs before stopped/fit checks and before an ordinal can be consumed', async () => {
  const root = temporary();
  const events: string[] = [];
  const result = await runQualificationSessions({
    sessions,
    outputRoot: root,
    now: () => 0,
    validate() {
      events.push('validate');
    },
    stopped() {
      events.push('stopped');
      return false;
    },
    fits() {
      events.push('fits');
      return false;
    },
    async execute() {
      throw Error('must not run');
    },
  });
  expect(events).toEqual(['validate', 'stopped', 'fits']);
  expect(result.consumed).toBe(0);
  expect(result.complete).toBe(false);
  expect(existsSync(join(root, '01'))).toBe(false);
  mkdirSync(join(root, '01'));
  await expect(
    runQualificationSessions({
      sessions,
      outputRoot: root,
      now: () => 0,
      fits: () => true,
      stopped: () => false,
      validate() {},
      async execute() {
        throw Error('must not run');
      },
    }),
  ).rejects.toThrow();
});
