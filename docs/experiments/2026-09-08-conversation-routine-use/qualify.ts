import { join, resolve } from 'node:path';
import { executeQualificationRole } from '../../../src/runner/qualification-role.ts';
import {
  type QualificationSettlement,
  runQualificationSessions,
} from '../../../src/runner/qualification-set.ts';
import { loadAssessmentCorpus } from './cases.ts';
import { driverCases } from './driver/cases.ts';
import { qualificationFits } from './envelope.ts';
import { type RoutineManifest, readPrivate } from './operation.ts';

const assessmentIds = [
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

export type { QualificationSettlement } from '../../../src/runner/qualification-set.ts';
/** Preserve the historical order, repetitions and envelope. */
export async function runQualificationSet(d: {
  role: 'assessment' | 'driver';
  outputRoot: string;
  firstPaidAtMs: number;
  now(): number;
  stopped(): boolean;
  validate(): void;
  execute(id: string, out: string): Promise<QualificationSettlement>;
}): Promise<QualificationSettlement & { consumed: number }> {
  const ids =
    d.role === 'assessment' ? assessmentIds : driverCases.map((row) => row.id);
  return runQualificationSessions({
    ...d,
    sessions: ids.flatMap((id) =>
      [1, 2].map((repetition) => ({
        id,
        repetition,
        group:
          d.role === 'assessment' ? ('retained' as const) : ('driver' as const),
      })),
    ),
    fits: () => qualificationFits(d.firstPaidAtMs, d.now()),
    execute: (session, out) => d.execute(session.id, out),
  });
}

const MODEL = 'anthropic.claude-sonnet-5';
type Rubric = { id: string; acceptanceCriteria: string[] };
export async function prepareQualification(
  m: RoutineManifest,
  env: Record<string, string | undefined>,
  stopped: () => boolean,
) {
  for (const file of [
    'src/format/story-card.ts',
    'src/util/id.ts',
    'src/index.ts',
  ])
    readPrivate(join(m.gRoot, file));
  if (m.mode === 'assessment')
    for (const file of [
      'assessment-cases.json',
      'rubric-mappings.json',
      'expectations/assessment.json',
    ]) {
      if (!m.frozenInputs.some((ref) => ref.path === join(m.caseRoot, file)))
        throw new Error('private corpus catalogue identity must be frozen');
    }
  const { parseStoryCard } = (await import(
    join(m.gRoot, 'src/format/story-card.ts')
  )) as { parseStoryCard(text: string): Rubric };
  const corpus =
    m.mode === 'assessment'
      ? loadAssessmentCorpus(m.caseRoot, parseStoryCard)
      : { cases: [], mappings: [], expectations: [] };
  return async (
    id: string,
    runDir: string,
  ): Promise<QualificationSettlement> => {
    const assessment = m.mode === 'assessment';
    const entry = corpus.cases.find((c) => c.id === id);
    const mapping =
      entry && corpus.mappings.find((c) => c.id === entry.mappingId);
    const expectation = corpus.expectations.find((c) => c.caseId === id);
    const driver = driverCases.find((c) => c.id === id);
    const rubricPath = mapping
      ? resolve(m.caseRoot, mapping.derivedRubric.path)
      : '';
    const rubric = assessment
      ? parseStoryCard(readPrivate(rubricPath).toString('utf8'))
      : null;
    if (assessment && (!entry || !mapping || !expectation || !rubric))
      throw new Error('assessment case missing');
    if (!assessment && !driver) throw new Error('driver case missing');
    return executeQualificationRole({
      gRoot: m.gRoot,
      runDir,
      model: MODEL,
      env,
      stopped,
      role:
        assessment && entry && mapping && expectation
          ? {
              kind: 'assessment',
              rubricPath,
              evidenceRoot: resolve(m.caseRoot, entry.evidenceRoot),
              evidenceIndexPath: resolve(m.caseRoot, entry.evidenceIndex.path),
              expected: expectation.atomic.map((c) => c.verdict),
              groups: mapping.groups,
              originalVerdicts: expectation.originalVerdicts,
            }
          : driver
            ? {
                kind: 'driver',
                briefPath: driver.briefPath,
                subjectScriptPath: join(import.meta.dir, 'driver/subject.ts'),
                subjectCase: driver.subjectCase,
                expectedCompletion: driver.expectedCompletion,
              }
            : (() => {
                throw Error('qualification case missing');
              })(),
    });
  };
}
