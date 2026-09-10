import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  authenticateQualificationRef,
  type QualificationRef,
  qualificationRef,
} from '../../../src/runner/qualification-evidence.ts';
import type { QualificationRoleInput } from '../../../src/runner/qualification-role.ts';
import type { QualificationSession } from '../../../src/runner/qualification-set.ts';
import {
  loadAssessmentCorpus,
  type Verdict,
} from '../2026-09-08-conversation-routine-use/cases.ts';
import benchmark from './benchmark-version.json';
import {
  loadSupplementalControls,
  type SupplementalControl,
} from './controls.ts';
import { driverCases } from './driver/cases.ts';
import { authenticatedReader, hash } from './reconstruct.ts';

type Ref = QualificationRef & { bytes: number };
const BENCHMARK_SHA =
  '017e83f66dff75aa248c975d1af0b7c0d1f4467316155b5d3a492715c0b2a0a3';
const CONSTRUCTION_COMMIT = '00f7a2d6ef6fa75f09c7e4981dda4145f2594408';
const D = 'docs/experiments/2026-09-09-conversation-assessor-reliability';
function requireInput(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(`qualification input: ${message}`);
}
function readExact(root: string, ref: Ref, refs: QualificationRef[]): string {
  const text = authenticatedReader(root, [ref])(ref.path);
  requireInput(Buffer.byteLength(text) === ref.bytes, 'byte length mismatch');
  refs.push({ path: resolve(root, ref.path), sha256: ref.sha256 });
  return text;
}

type Neutral = {
  cases: {
    id: string;
    criterionCount: number;
    assessorInput: {
      rubric: Ref;
      evidenceRoot: string;
      index: Ref;
      evidence: Ref[];
    };
  }[];
};
type Judgments = {
  id: string;
  criteria: { ordinal: number; verdict: Verdict }[];
};
type AdditionalReceipt = {
  current: {
    input: Ref;
    inputRefs: Ref[];
    inputRefsRelativeTo: string;
    authoredExpectations: Ref;
    sourceManifest: Ref;
    report: Ref;
  };
  originalBlind: { input: Ref; labels: Ref; review: Ref };
  phase2: { priorAuthoredExpectations: Ref; comparisonReview: Ref };
  supersedes: Ref;
  acceptedJudgments: Judgments[];
};
function additionalInputs(qRoot: string): {
  controls: SupplementalControl[];
  refs: QualificationRef[];
} {
  const refs: QualificationRef[] = [];
  // This corrected independent receipt is the trust anchor, not author pending flags.
  const receipt: AdditionalReceipt = JSON.parse(
    readExact(
      qRoot,
      benchmark.additionalControls.independentReview.receipt,
      refs,
    ),
  );
  const neutral: Neutral = JSON.parse(
    readExact(qRoot, receipt.current.input, refs),
  );
  const gold: { cases: Judgments[] } = JSON.parse(
    readExact(qRoot, receipt.current.authoredExpectations, refs),
  );
  const source: {
    neutralInput: Ref;
    neutralFiles: Ref[];
    authoredExpectations: Ref;
    publicSources: Ref[];
    sourceBase: { q: string };
    authoringContext: Record<string, unknown>;
    supersession: Record<string, unknown>;
  } = JSON.parse(readExact(qRoot, receipt.current.sourceManifest, refs));
  for (const ref of [
    receipt.current.report,
    receipt.originalBlind.input,
    receipt.originalBlind.labels,
    receipt.originalBlind.review,
    receipt.phase2.priorAuthoredExpectations,
    receipt.phase2.comparisonReview,
    receipt.supersedes,
  ])
    readExact(qRoot, ref, refs);
  const bundleRoot = dirname(
    resolve(qRoot, receipt.current.sourceManifest.path),
  );
  for (const ref of [
    source.neutralInput,
    ...source.neutralFiles,
    source.authoredExpectations,
  ])
    readExact(bundleRoot, ref, refs);
  // Authenticate the preserved review/supersession chain without interpreting a
  // post-gold reconsideration as a fresh blind pass.
  for (const section of [source.authoringContext, source.supersession])
    for (const value of Object.values(section))
      if (
        value &&
        typeof value === 'object' &&
        'path' in value &&
        'sha256' in value &&
        'bytes' in value
      ) {
        const ref = value as Ref;
        const historical = spawnSync(
          'git',
          ['show', `${source.sourceBase.q}:${ref.path}`],
          { cwd: qRoot },
        );
        if (historical.status === 0) {
          requireInput(
            hash(historical.stdout) === ref.sha256 &&
              historical.stdout.length === ref.bytes,
            `authoring source mismatch: ${ref.path}`,
          );
        } else readExact(qRoot, ref, refs);
      }
  for (const ref of source.publicSources) {
    const result = spawnSync(
      'git',
      ['show', `${CONSTRUCTION_COMMIT}:${ref.path}`],
      { cwd: qRoot },
    );
    requireInput(
      result.status === 0 &&
        hash(result.stdout) === ref.sha256 &&
        result.stdout.length === ref.bytes,
      `construction source mismatch: ${ref.path}`,
    );
  }
  const neutralRoot = resolve(qRoot, receipt.current.inputRefsRelativeTo);
  for (const ref of receipt.current.inputRefs)
    readExact(neutralRoot, ref, refs);
  requireInput(
    neutral.cases.length === 2 && gold.cases.length === 2,
    'additional counts differ',
  );
  const controls = neutral.cases.map((c, i) => {
    const expected = gold.cases[i];
    const accepted = receipt.acceptedJudgments[i];
    requireInput(
      c.id === `additional-0${i + 1}` &&
        c.criterionCount === 2 &&
        expected?.id === c.id &&
        accepted?.id === c.id,
      'additional identity mismatch',
    );
    const vector = expected.criteria.map((criterion, ordinal) => {
      requireInput(
        criterion.ordinal === ordinal + 1 &&
          accepted.criteria[ordinal]?.verdict === criterion.verdict,
        'additional reviewed verdict mismatch',
      );
      return criterion.verdict;
    });
    requireInput(vector.length === 2, 'additional criterion count mismatch');
    const a = c.assessorInput;
    for (const ref of [a.rubric, a.index, ...a.evidence]) {
      requireInput(
        receipt.current.inputRefs.some((r) => isDeepStrictEqual(r, ref)),
        'additional reference absent from review',
      );
      readExact(neutralRoot, ref, refs);
    }
    const index: { files: string[] } = JSON.parse(
      readExact(neutralRoot, a.index, refs),
    );
    requireInput(
      isDeepStrictEqual(
        index.files.map((p) => `${a.evidenceRoot}/${p}`),
        a.evidence.map((r) => r.path),
      ),
      'additional evidence scope mismatch',
    );
    return {
      id: c.id,
      rubricPath: resolve(neutralRoot, a.rubric.path),
      evidenceRoot: resolve(neutralRoot, a.evidenceRoot),
      evidenceIndexPath: resolve(neutralRoot, a.index.path),
      expected: vector,
    };
  });
  return { controls, refs };
}
export function loadAdditionalControls(qRoot: string): SupplementalControl[] {
  return additionalInputs(qRoot).controls;
}

export function qualificationBenchmark(qRoot: string): QualificationRef {
  const ref = {
    path: resolve(qRoot, D, 'benchmark-version.json'),
    sha256: BENCHMARK_SHA,
  };
  authenticateQualificationRef(ref);
  return ref;
}
export type QualificationInputs = Awaited<
  ReturnType<typeof loadQualificationInputs>
>;
/** Preparation authenticates immutable inputs; it grants no execution authority. */
export async function loadQualificationInputs(input: {
  qRoot: string;
  gRoot: string;
  retainedRoot: string;
  supplementalRoot: string;
}) {
  const refs: QualificationRef[] = [];
  const benchmarkRef = qualificationBenchmark(input.qRoot);
  refs.push(benchmarkRef);
  for (const ref of [
    benchmark.scenario.current,
    benchmark.driver.cases,
    benchmark.driver.preferences,
    benchmark.driver.expectedActs,
    benchmark.driver.reusedSubject,
    benchmark.driver.reusedCaseCatalogue,
    benchmark.driver.reusedExpectedActs,
    ...benchmark.driver.unchangedBriefs,
  ])
    readExact(input.qRoot, ref, refs);
  for (const ref of [
    benchmark.historicalCorpus.catalogue,
    benchmark.historicalCorpus.mappings,
    benchmark.historicalCorpus.expectations,
    benchmark.historicalCorpus.copyReceipt,
  ])
    readExact(input.retainedRoot, ref, refs);
  const { parseStoryCard } = (await import(
    join(input.gRoot, 'src/format/story-card.ts')
  )) as {
    parseStoryCard(text: string): { id: string; acceptanceCriteria: string[] };
  };
  const corpus = loadAssessmentCorpus(input.retainedRoot, parseStoryCard);
  const supplementalReceipt = join(
    dirname(input.supplementalRoot),
    'heldout-freeze-receipt.json',
  );
  const supplemental = loadSupplementalControls(
    input.supplementalRoot,
    supplementalReceipt,
  );
  refs.push(qualificationRef(supplementalReceipt));
  const additional = additionalInputs(input.qRoot);
  refs.push(...additional.refs);
  const roles = new Map<string, QualificationRoleInput>();
  const assessments: QualificationSession[] = [];
  for (const c of corpus.cases) {
    const mapping = corpus.mappings.find((m) => m.id === c.mappingId);
    const expectation = corpus.expectations.find((e) => e.caseId === c.id);
    requireInput(mapping && expectation, 'retained mapping missing');
    roles.set(`retained:${c.id}`, {
      kind: 'assessment',
      rubricPath: resolve(input.retainedRoot, mapping.derivedRubric.path),
      evidenceRoot: resolve(input.retainedRoot, c.evidenceRoot),
      evidenceIndexPath: resolve(input.retainedRoot, c.evidenceIndex.path),
      expected: expectation.atomic.map((a) => a.verdict),
      groups: mapping.groups,
      originalVerdicts: expectation.originalVerdicts,
    });
    assessments.push(
      ...[1, 2].map((repetition) => ({
        id: c.id,
        repetition,
        group: 'retained' as const,
      })),
    );
  }
  for (const [group, controls] of [
    ['supplemental', supplemental],
    ['additional', additional.controls],
  ] as const)
    for (const c of controls) {
      // Identity folds preserve each control's own independent expectation.
      roles.set(`${group}:${c.id}`, {
        kind: 'assessment',
        rubricPath: c.rubricPath,
        evidenceRoot: c.evidenceRoot,
        evidenceIndexPath: c.evidenceIndexPath,
        expected: c.expected,
        groups: c.expected.map((_, i) => ({
          originalOrdinal: i + 1,
          atomicOrdinals: [i + 1],
        })),
        originalVerdicts: c.expected,
      });
      assessments.push({ id: c.id, repetition: 1, group });
    }
  const drivers = driverCases.flatMap((c) => {
    roles.set(`driver:${c.id}`, {
      kind: 'driver',
      briefPath: resolve(input.qRoot, relativeToQ(c.briefPath)),
      subjectScriptPath: resolve(
        input.qRoot,
        benchmark.driver.reusedSubject.path,
      ),
      subjectCase: c.subjectCase,
      expectedCompletion: c.expectedCompletion,
    });
    return [1, 2].map((repetition) => ({
      id: c.id,
      repetition,
      group: 'driver' as const,
    }));
  });
  function role(session: QualificationSession): QualificationRoleInput {
    const schedule = session.group === 'driver' ? drivers : assessments;
    requireInput(
      schedule.some((s) => isDeepStrictEqual(s, session)),
      'undeclared session',
    );
    const policy = roles.get(`${session.group}:${session.id}`);
    requireInput(policy, 'role missing');
    return structuredClone(policy);
  }
  const validate = () => {
    for (const ref of refs) authenticateQualificationRef(ref);
    loadAssessmentCorpus(input.retainedRoot, parseStoryCard);
    loadSupplementalControls(input.supplementalRoot, supplementalReceipt);
  };
  return {
    benchmark: benchmarkRef,
    benchmarkVersion: benchmark.id,
    assessments,
    drivers,
    refs,
    role,
    validate,
  };
}
function relativeToQ(path: string): string {
  // Imported catalogue resolves paths against this module's checkout. Rebase
  // only its known repository-relative brief path to the authenticated caller.
  const offset = path.indexOf('/docs/experiments/');
  requireInput(offset >= 0, 'driver brief outside repository');
  return path.slice(offset + 1);
}
