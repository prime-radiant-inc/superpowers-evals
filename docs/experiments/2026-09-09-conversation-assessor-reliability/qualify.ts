import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SuiteSchema } from '../../../src/contracts/campaign/suite.ts';
import {
  authenticateQualificationRef,
  QualificationMeasurementSchema,
  type QualificationRef,
  qualificationRef,
  readQualificationFile,
  writeQualificationJson,
} from '../../../src/runner/qualification-evidence.ts';
import { executeQualificationRole } from '../../../src/runner/qualification-role.ts';
import {
  type QualificationSettlement,
  runQualificationSessions,
} from '../../../src/runner/qualification-set.ts';
import { checkCriterionAgreement } from '../2026-09-08-conversation-routine-use/cases.ts';
import benchmark from './benchmark-version.json';
import {
  type QualificationInputs,
  qualificationBenchmark,
} from './qualification-inputs.ts';
import {
  assertQualificationSchedule,
  type QualificationObservation,
  summarizeQualification,
  verifyQualificationReview,
  writeQualificationReviewInput,
} from './qualification-review.ts';

const SettlementSchema = z.object({
  knownUsd: z.number().finite().nonnegative(),
  complete: z.boolean(),
  semanticMatch: z.boolean(),
  fault: z.string().nullable(),
});
function collectObservations(
  input: QualificationInputs,
  outputRoot: string,
  stage: 'assessment' | 'driver',
): QualificationObservation[] {
  const schedule = stage === 'assessment' ? input.assessments : input.drivers;
  const directories = readdirSync(outputRoot)
    .filter((p) => /^\d+$/.test(p))
    .sort();
  return directories.map((directory, i) => {
    const session = schedule[i];
    if (!session || directory !== String(i + 1).padStart(2, '0'))
      throw Error('unexpected qualification ordinal');
    const root = join(outputRoot, directory);
    const launch = qualificationRef(join(root, 'launch.json'));
    const launched = JSON.parse(
      authenticateQualificationRef(launch).toString('utf8'),
    );
    if (
      launched.ordinal !== i + 1 ||
      launched.id !== session.id ||
      launched.repetition !== session.repetition
    )
      throw Error('qualification launch identity mismatch');
    const policy = input.role(session);
    const observation: QualificationObservation = {
      session,
      judgments: policy.kind === 'assessment' ? policy.expected.length : 0,
      settlement: null,
      measurement: null,
      matchingJudgments: null,
      refs: [launch],
    };
    try {
      const ref = qualificationRef(join(root, 'settled.json'));
      observation.refs.push(ref);
      observation.settlement = SettlementSchema.parse(
        JSON.parse(authenticateQualificationRef(ref).toString('utf8')),
      );
    } catch {
      /* An admitted, unsettled session stays in the overall denominator. */
    }
    try {
      const ref = qualificationRef(join(root, 'qualification-role.json'));
      observation.refs.push(ref);
      const measured = QualificationMeasurementSchema.parse(
        JSON.parse(authenticateQualificationRef(ref).toString('utf8')),
      );
      for (const binding of [
        ...measured.inputs,
        ...measured.artifacts,
        measured.expectation,
        ...(measured.result ? [measured.result] : []),
      ])
        authenticateQualificationRef(binding);
      if (measured.kind !== policy.kind)
        throw Error('qualification measurement role mismatch');
      const expected = JSON.parse(
        authenticateQualificationRef(measured.expectation).toString('utf8'),
      );
      if (
        !isDeepStrictEqual(
          expected,
          policy.kind === 'assessment'
            ? {
                expected: policy.expected,
                groups: policy.groups,
                originalVerdicts: policy.originalVerdicts,
              }
            : { expectedCompletion: policy.expectedCompletion },
        )
      )
        throw Error('qualification expectation mismatch');
      observation.measurement = measured;
      if (measured.accepted) {
        if (
          !observation.settlement?.complete ||
          observation.settlement.fault !== null ||
          measured.knownUsd !== observation.settlement.knownUsd ||
          !measured.result
        )
          throw Error('qualification settlement mismatch');
        if (policy.kind === 'assessment') {
          if (!measured.actual)
            throw Error('accepted assessment has no vector');
          const agreement = checkCriterionAgreement(
            policy.groups,
            policy.expected,
            policy.originalVerdicts,
            measured.actual,
          );
          if (agreement.match !== observation.settlement.semanticMatch)
            throw Error('qualification agreement mismatch');
          observation.matchingJudgments = measured.actual.filter(
            (v, j) => v === policy.expected[j],
          ).length;
        } else observation.matchingJudgments = 0;
      }
    } catch {
      observation.measurement = null;
      observation.matchingJudgments = null;
    }
    return observation;
  });
}

/** Finite role wrapper only. Task 8's owner supplies fresh allocation, identity,
 * lease, stop and fit checks; none are inferred from historical envelopes. */
export async function runReliabilityQualification(d: {
  inputs: QualificationInputs;
  stage: 'assessment' | 'driver';
  outputRoot: string;
  author: string;
  candidate: { qSha: string; gSha: string };
  gRoot: string;
  env: Record<string, string | undefined>;
  now(): number;
  fits(): boolean;
  stopped(): boolean;
  validate(): void;
  assessmentReview?: QualificationRef;
}) {
  if (d.stage === 'driver') {
    if (!d.assessmentReview)
      throw Error(
        'independent assessment review required before driver admission',
      );
    verifyQualificationReview({
      receipt: d.assessmentReview,
      stage: 'assessment',
      candidate: d.candidate,
      benchmark: d.inputs.benchmark,
    });
    // Persist the exact independently issued receipt before the first launch.
    writeQualificationJson(join(d.outputRoot, 'assessment-review.json'), {
      ref: d.assessmentReview,
      receipt: JSON.parse(
        authenticateQualificationRef(d.assessmentReview).toString('utf8'),
      ),
    });
  }
  const sessions =
    d.stage === 'assessment' ? d.inputs.assessments : d.inputs.drivers;
  const declared = sessions.map((session) => {
    const role = d.inputs.role(session);
    return {
      session,
      judgments: role.kind === 'assessment' ? role.expected.length : 0,
    };
  });
  assertQualificationSchedule(d.stage, declared);
  const prepared = writeQualificationJson(
    join(d.outputRoot, 'qualification-inputs.json'),
    {
      candidate: d.candidate,
      benchmark: d.inputs.benchmark,
      benchmarkVersion: d.inputs.benchmarkVersion,
      refs: d.inputs.refs,
      declared,
    },
  );
  let settlement: (QualificationSettlement & { consumed: number }) | null =
    null;
  let reviewInput: QualificationRef | null = null;
  try {
    settlement = await runQualificationSessions({
      sessions,
      outputRoot: d.outputRoot,
      now: d.now,
      fits: d.fits,
      stopped: d.stopped,
      validate() {
        d.validate();
        d.inputs.validate();
        if (d.assessmentReview)
          verifyQualificationReview({
            receipt: d.assessmentReview,
            stage: 'assessment',
            candidate: d.candidate,
            benchmark: d.inputs.benchmark,
          });
      },
      execute: (session, runDir) =>
        executeQualificationRole({
          gRoot: d.gRoot,
          runDir,
          model: 'anthropic.claude-sonnet-5',
          env: d.env,
          stopped: d.stopped,
          role: d.inputs.role(session),
        }),
    });
    return settlement;
  } finally {
    const rows = collectObservations(d.inputs, d.outputRoot, d.stage);
    for (const row of rows) row.refs.push(prepared);
    reviewInput = writeQualificationReviewInput({
      outputRoot: d.outputRoot,
      stage: d.stage,
      author: d.author,
      candidate: d.candidate,
      benchmark: d.inputs.benchmark,
      benchmarkVersion: d.inputs.benchmarkVersion,
      declared,
      rows,
      priorReview: d.assessmentReview ?? null,
    });
    writeQualificationJson(join(d.outputRoot, 'readout.json'), {
      ...summarizeQualification(declared, rows),
      settlement,
      reviewInput,
      independentReviewComplete: false,
      executionAuthorized: false,
    });
  }
}

/** Produces an immutable input proposal, never a registration or execution grant. */
export function prepareFreshCohort(d: {
  qRoot: string;
  outputRoot: string;
  candidate: { qSha: string; gSha: string };
  assessmentReview: QualificationRef;
  driverReview: QualificationRef;
}): QualificationRef {
  const ref = qualificationBenchmark(d.qRoot);
  verifyQualificationReview({
    receipt: d.assessmentReview,
    stage: 'assessment',
    candidate: d.candidate,
    benchmark: ref,
  });
  const driver = verifyQualificationReview({
    receipt: d.driverReview,
    stage: 'driver',
    candidate: d.candidate,
    benchmark: ref,
  });
  if (!isDeepStrictEqual(driver.reviewed.priorReview, d.assessmentReview))
    throw Error('driver review does not bind the admitted assessment review');
  const suite = qualificationRef(
    join(d.qRoot, 'suites/conversation_routine_use.yaml'),
  );
  const { grader, ...fields } = z
    .record(z.unknown())
    .parse(parseYaml(readQualificationFile(suite.path).toString('utf8')));
  z.object({
    credential: z.literal('sonnet5_bedrock'),
    model: z.literal('anthropic.claude-sonnet-5'),
  })
    .strict()
    .parse(grader);
  const specification = SuiteSchema.parse(fields);
  const ids = new Set<string>();
  let attempts = 0;
  for (const comparison of specification.comparisons) {
    if (
      !Array.isArray(comparison.scenarios) ||
      !('baseline' in comparison) ||
      comparison.n !== 2
    )
      throw Error(
        'fresh cohort must retain explicit paired scenarios and repetitions',
      );
    for (const id of comparison.scenarios) ids.add(id);
    attempts += comparison.scenarios.length * comparison.n * 2;
  }
  if (
    attempts !== 36 ||
    specification.reserve !== 0 ||
    specification.attempt_bounds.max_attempts !== 1
  )
    throw Error('fresh cohort allocation shape changed');
  const scenarios = [...ids].map((id) => ({
    id,
    files: ['story.md', 'setup.sh', 'checks.sh', 'checks-manifest.json'].map(
      (file) => qualificationRef(join(d.qRoot, 'scenarios', id, file)),
    ),
  }));
  const design = qualificationRef(
    join(d.qRoot, benchmark.scenario.current.path),
  );
  if (design.sha256 !== benchmark.scenario.current.sha256)
    throw Error('fresh benchmark scenario changed');
  return writeQualificationJson(
    join(d.outputRoot, 'fresh-cohort-inputs.json'),
    {
      attempts: 36,
      benchmarkVersion: benchmark.id,
      benchmark: ref,
      candidate: d.candidate,
      assessmentReview: d.assessmentReview,
      driverReview: d.driverReview,
      scenarios,
      suite,
      executionAuthorized: false,
      comparisonPolicy:
        'Do not pool this benchmark version with historical scenario inputs as one treatment effect.',
    },
  );
}
