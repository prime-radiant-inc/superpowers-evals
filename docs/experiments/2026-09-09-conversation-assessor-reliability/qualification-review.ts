import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  authenticateQualificationRef,
  type QualificationMeasurement,
  QualificationMeasurementSchema,
  type QualificationRef,
  QualificationRefSchema,
  writeQualificationJson,
} from '../../../src/runner/qualification-evidence.ts';
import type {
  QualificationSession,
  QualificationSettlement,
} from '../../../src/runner/qualification-set.ts';
import { checkCriterionAgreement } from '../2026-09-08-conversation-routine-use/cases.ts';
import { driverCases, preferenceActAllowed } from './driver/cases.ts';

const SessionSchema = z.object({
  id: z.string().min(1),
  repetition: z.number().int().positive(),
  group: z.enum(['retained', 'supplemental', 'additional', 'driver']),
});
const SettlementSchema = z.object({
  knownUsd: z.number().finite().nonnegative(),
  complete: z.boolean(),
  semanticMatch: z.boolean(),
  fault: z.string().nullable(),
});
const CandidateSchema = z.object({
  qSha: z.string().regex(/^[a-f0-9]{40}$/),
  gSha: z.string().regex(/^[a-f0-9]{40}$/),
});
const DeclaredSchema = z.object({
  session: SessionSchema,
  judgments: z.number().int().nonnegative(),
});
export type DeclaredQualification = {
  session: QualificationSession;
  judgments: number;
};
export type QualificationObservation = DeclaredQualification & {
  settlement: QualificationSettlement | null;
  measurement: QualificationMeasurement | null;
  matchingJudgments: number | null;
  refs: QualificationRef[];
};
const ObservationSchema = DeclaredSchema.extend({
  settlement: SettlementSchema.nullable(),
  measurement: QualificationMeasurementSchema.nullable(),
  matchingJudgments: z.number().int().nonnegative().nullable(),
  refs: z.array(QualificationRefSchema).min(1),
});
const groupNames = [
  'retained',
  'supplemental',
  'additional',
  'driver',
] as const;
const sum = (values: number[]) =>
  Number(values.reduce((a, b) => a + b, 0).toPrecision(15));
/** Accepted semantic rates use accepted reports only; overall rates retain every admission. */
export function summarizeQualification(
  declared: DeclaredQualification[],
  rows: QualificationObservation[],
) {
  const groups = Object.fromEntries(
    groupNames.map((group) => {
      const planned = declared.filter((d) => d.session.group === group);
      const admitted = rows.filter((r) => r.session.group === group);
      const accepted = admitted.filter(
        (r) =>
          r.measurement?.accepted &&
          r.settlement?.complete &&
          r.settlement.fault === null,
      );
      const correct = accepted.filter((r) => r.settlement?.semanticMatch);
      const acceptedJudgments = sum(accepted.map((r) => r.judgments));
      return [
        group,
        {
          declaredSessions: planned.length,
          declaredJudgments: sum(planned.map((r) => r.judgments)),
          admittedSessions: admitted.length,
          acceptedReports: accepted.length,
          acceptedJudgments,
          matchingJudgments: sum(accepted.map((r) => r.matchingJudgments ?? 0)),
          correctSessions: correct.length,
          semanticAgreement: accepted.length
            ? correct.length / accepted.length
            : null,
          judgmentAgreement: acceptedJudgments
            ? sum(accepted.map((r) => r.matchingJudgments ?? 0)) /
              acceptedJudgments
            : null,
          overallCorrectSessions: admitted.length
            ? correct.length / admitted.length
            : null,
          firstReportValid: admitted.filter(
            (r) => r.measurement?.firstReportValid === true,
          ).length,
          firstReportInvalid: admitted.filter(
            (r) => r.measurement?.firstReportValid === false,
          ).length,
          firstReportUnknown: admitted.filter(
            (r) => r.measurement?.firstReportValid == null,
          ).length,
          eventualReportCompletions: admitted.filter(
            (r) => r.measurement?.eventualReportCompletion,
          ).length,
        },
      ];
    }),
  ) as Record<
    QualificationSession['group'],
    {
      declaredSessions: number;
      declaredJudgments: number;
      admittedSessions: number;
      acceptedReports: number;
      acceptedJudgments: number;
      matchingJudgments: number;
      correctSessions: number;
      semanticAgreement: number | null;
      judgmentAgreement: number | null;
      overallCorrectSessions: number | null;
      firstReportValid: number;
      firstReportInvalid: number;
      firstReportUnknown: number;
      eventualReportCompletions: number;
    }
  >;
  const counted = (
    field:
      | 'logicalAttempts'
      | 'logicalResponses'
      | 'physicalAttempts'
      | 'corrections',
  ) => sum(rows.map((r) => r.measurement?.[field] ?? 0));
  const knownUsd = sum(
    rows.map((r) => r.settlement?.knownUsd ?? r.measurement?.knownUsd ?? 0),
  );
  return {
    groups,
    admittedSessions: rows.length,
    knownUsd,
    totalUsd:
      rows.length > 0 && rows.every((r) => r.measurement?.costComplete)
        ? knownUsd
        : null,
    unknownUsageAttempts: sum(
      rows.map((r) => r.measurement?.unknownUsageAttemptIds?.length ?? 0),
    ),
    unknownUsageSessions: rows.filter(
      (r) => r.measurement?.unknownUsageAttemptIds == null,
    ).length,
    unmeasuredSessions: rows.filter((r) => r.measurement === null).length,
    logicalAttempts: counted('logicalAttempts'),
    logicalResponses: counted('logicalResponses'),
    physicalAttempts: counted('physicalAttempts'),
    corrections: counted('corrections'),
    latencyMs: sum(rows.map((r) => r.measurement?.latencyMs ?? 0)),
    unknownLatencySessions: rows.filter((r) => r.measurement === null).length,
  };
}
const ReviewInputSchema = z.object({
  schemaVersion: z.literal(1),
  stage: z.enum(['assessment', 'driver']),
  author: z.string().trim().min(1),
  candidate: CandidateSchema,
  benchmark: QualificationRefSchema,
  benchmarkVersion: z.string().min(1),
  declared: z.array(DeclaredSchema),
  rows: z.array(ObservationSchema),
  priorReview: QualificationRefSchema.nullable(),
});
export function writeQualificationReviewInput(
  input: Omit<z.infer<typeof ReviewInputSchema>, 'schemaVersion'> & {
    outputRoot: string;
  },
): QualificationRef {
  const value = ReviewInputSchema.parse({ schemaVersion: 1, ...input });
  return writeQualificationJson(
    join(input.outputRoot, 'rationale-review-input.json'),
    {
      ...value,
      readout: summarizeQualification(value.declared, value.rows),
      independentReviewComplete: false,
      executionAuthorized: false,
    },
  );
}
const CitationSchema = z.object({
  path: z.string().min(1),
  locator: z.string().trim().min(1),
});
const ReviewSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('qualification-review'),
  input: QualificationRefSchema,
  reviewer: z.string().trim().min(1),
  independent: z.literal(true),
  rows: z.array(
    z.object({
      ordinal: z.number().int().positive(),
      confirmed: z.literal(true),
      rationale: z.string().trim().min(1),
      criteria: z.array(
        z.object({
          ordinal: z.number().int().positive(),
          decisive: z.literal(true),
          rationale: z.string().trim().min(1),
          evidence: z.array(CitationSchema).min(1),
        }),
      ),
      evidence: z.array(CitationSchema).optional(),
      preferenceActs: z.array(
        z.object({
          question: z.enum(['channel', 'remaining-preferences', 'delivery']),
          act: z.object({
            kind: z.enum(['answer', 'stop']),
            facts: z.array(
              z.enum([
                'in-page',
                'selective-notifications',
                'local-browser',
                'task-population',
                'all-tasks',
              ]),
            ),
            declinedInconsistentOption: z.boolean().optional(),
          }),
          evidence: z.array(CitationSchema).min(1),
        }),
      ),
    }),
  ),
});
function requireReview(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(`qualification review: ${message}`);
}
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
export function assertQualificationSchedule(
  stage: 'assessment' | 'driver',
  declared: DeclaredQualification[],
): void {
  const expected: QualificationSession[] =
    stage === 'assessment'
      ? [
          ...retainedIds.flatMap((id) =>
            [1, 2].map((repetition) => ({
              id,
              repetition,
              group: 'retained' as const,
            })),
          ),
          ...Array.from({ length: 8 }, (_, i) => ({
            id: `control-0${i + 1}`,
            repetition: 1,
            group: 'supplemental' as const,
          })),
          ...['additional-01', 'additional-02'].map((id) => ({
            id,
            repetition: 1,
            group: 'additional' as const,
          })),
        ]
      : driverCases.flatMap((c) =>
          [1, 2].map((repetition) => ({
            id: c.id,
            repetition,
            group: 'driver' as const,
          })),
        );
  const counts = [10, 10, 6, 10, 6, 11, 11, 13, 13];
  requireReview(
    isDeepStrictEqual(
      declared,
      expected.map((session) => ({
        session,
        judgments:
          session.group === 'retained'
            ? counts[retainedIds.indexOf(session.id)]
            : session.group === 'driver'
              ? 0
              : 2,
      })),
    ),
    'fixed qualification schedule and criterion counts required',
  );
}
/** The owner supplies an authenticated independent receipt. Parsing a claim of
 * approval does not create authority, and preparation never creates this receipt. */
export function verifyQualificationReview(input: {
  receipt: QualificationRef;
  stage: 'assessment' | 'driver';
  candidate: z.infer<typeof CandidateSchema>;
  benchmark: QualificationRef;
}) {
  const receipt = ReviewSchema.parse(
    JSON.parse(authenticateQualificationRef(input.receipt).toString('utf8')),
  );
  const reviewed = ReviewInputSchema.parse(
    JSON.parse(authenticateQualificationRef(receipt.input).toString('utf8')),
  );
  requireReview(
    reviewed.stage === input.stage &&
      isDeepStrictEqual(reviewed.candidate, input.candidate) &&
      isDeepStrictEqual(reviewed.benchmark, input.benchmark),
    'candidate, benchmark or stage mismatch',
  );
  const version = JSON.parse(
    authenticateQualificationRef(reviewed.benchmark).toString('utf8'),
  ) as { id: string };
  requireReview(
    version.id === reviewed.benchmarkVersion,
    'benchmark version mismatch',
  );
  if (input.stage === 'driver') {
    requireReview(
      reviewed.priorReview,
      'driver must bind prior independent assessment review',
    );
    verifyQualificationReview({
      receipt: reviewed.priorReview,
      stage: 'assessment',
      candidate: input.candidate,
      benchmark: input.benchmark,
    });
  }
  requireReview(
    receipt.reviewer !== reviewed.author,
    'review must be independent',
  );
  assertQualificationSchedule(input.stage, reviewed.declared);
  const expected = reviewed.declared.map((d) => d.session);
  requireReview(
    isDeepStrictEqual(
      reviewed.declared.map((d) => d.session),
      expected,
    ) &&
      isDeepStrictEqual(
        reviewed.rows.map((r) => r.session),
        expected,
      ) &&
      receipt.rows.length === expected.length,
    'full fixed schedule required',
  );
  const readout = summarizeQualification(reviewed.declared, reviewed.rows);
  const required =
    input.stage === 'assessment'
      ? ([
          ['retained', 18, 180],
          ['supplemental', 8, 16],
          ['additional', 2, 4],
        ] as const)
      : ([['driver', 12, 0]] as const);
  for (const [group, sessions, judgments] of required) {
    const summary = readout.groups[group];
    requireReview(
      summary.declaredSessions === sessions &&
        summary.declaredJudgments === judgments &&
        summary.acceptedReports === sessions &&
        summary.correctSessions === sessions &&
        summary.acceptedJudgments === judgments &&
        summary.matchingJudgments === judgments,
      'incomplete or incorrect qualification group',
    );
  }
  for (const [i, row] of reviewed.rows.entries()) {
    const review = receipt.rows[i];
    const measured = row.measurement;
    requireReview(
      review?.ordinal === i + 1 &&
        measured?.accepted &&
        measured.result &&
        row.settlement?.complete &&
        row.settlement.fault === null &&
        row.settlement.knownUsd === measured.knownUsd,
      'unaccepted or incomplete session',
    );
    for (const ref of [
      ...row.refs,
      measured.result,
      measured.expectation,
      ...measured.inputs,
      ...measured.artifacts,
    ])
      authenticateQualificationRef(ref);
    const bound = (name: string) => {
      const refs = row.refs.filter((ref) => basename(ref.path) === name);
      requireReview(refs.length === 1 && refs[0], `one bound ${name} required`);
      return JSON.parse(authenticateQualificationRef(refs[0]).toString('utf8'));
    };
    requireReview(
      isDeepStrictEqual(
        QualificationMeasurementSchema.parse(bound('qualification-role.json')),
        measured,
      ) &&
        isDeepStrictEqual(
          SettlementSchema.parse(bound('settled.json')),
          row.settlement,
        ),
      'embedded readout differs from retained settlement',
    );
    const launch = bound('launch.json') as {
      ordinal: number;
      id: string;
      repetition: number;
    };
    requireReview(
      launch.ordinal === i + 1 &&
        launch.id === row.session.id &&
        launch.repetition === row.session.repetition,
      'review launch identity mismatch',
    );
    const allowed = new Set(
      [...measured.inputs, ...measured.artifacts].map((r) => r.path),
    );
    const cite = (citations: z.infer<typeof CitationSchema>[]) => {
      requireReview(
        citations.length > 0 && citations.every((c) => allowed.has(c.path)),
        'review citation not bound to evidence',
      );
    };
    if (input.stage === 'assessment') {
      const verdict = z.enum(['pass', 'fail', 'unclear']);
      const expectations = z
        .object({
          expected: z.array(verdict),
          originalVerdicts: z.array(verdict),
          groups: z.array(
            z.object({
              originalOrdinal: z.number().int().positive(),
              atomicOrdinals: z.array(z.number().int().positive()),
            }),
          ),
        })
        .parse(
          JSON.parse(
            authenticateQualificationRef(measured.expectation).toString('utf8'),
          ),
        );
      const result = z
        .object({ criteria: z.array(z.object({ verdict })) })
        .parse(
          JSON.parse(
            authenticateQualificationRef(measured.result).toString('utf8'),
          ),
        );
      const actual = result.criteria.map((c) => c.verdict);
      requireReview(
        expectations.expected.length === row.judgments &&
          isDeepStrictEqual(actual, measured.actual) &&
          checkCriterionAgreement(
            expectations.groups,
            expectations.expected,
            expectations.originalVerdicts,
            actual,
          ).match &&
          row.matchingJudgments === row.judgments,
        'review result/expectation agreement mismatch',
      );
      requireReview(
        review.criteria.length === row.judgments,
        'all criterion rationales must be reviewed',
      );
      for (const [j, criterion] of review.criteria.entries()) {
        requireReview(
          criterion.ordinal === j + 1,
          'criterion review order mismatch',
        );
        cite(criterion.evidence);
      }
    } else {
      cite(review.evidence ?? []);
      if (row.session.id === 'preferences') {
        requireReview(
          isDeepStrictEqual(
            review.preferenceActs.map((a) => a.question),
            ['channel', 'remaining-preferences', 'delivery'],
          ),
          'complete reviewed preference acts required',
        );
        for (const annotation of review.preferenceActs) {
          requireReview(
            preferenceActAllowed(annotation.question, {
              kind: annotation.act.kind,
              facts: annotation.act.facts,
              ...(annotation.act.declinedInconsistentOption === undefined
                ? {}
                : {
                    declinedInconsistentOption:
                      annotation.act.declinedInconsistentOption,
                  }),
            }),
            'reviewed preference act violates brief',
          );
          cite(annotation.evidence);
        }
      } else
        requireReview(
          review.preferenceActs.length === 0,
          'unexpected preference annotations',
        );
    }
  }
  return { input: receipt.input, reviewed, readout };
}
