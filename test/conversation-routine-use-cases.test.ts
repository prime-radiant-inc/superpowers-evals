import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type AssessmentCase,
  type AssessmentExpectation,
  checkCriterionAgreement,
  foldOriginalVerdicts,
  loadAssessmentCorpus,
  type RubricMapping,
  type Verdict,
} from '../docs/experiments/2026-09-08-conversation-routine-use/cases';
import { driverCases as priorDriverCases } from '../docs/experiments/2026-09-08-conversation-routine-use/driver/cases.ts';
import {
  driverCases,
  preferenceActAllowed,
} from '../docs/experiments/2026-09-09-conversation-assessor-reliability/driver/cases.ts';

const CASE_IDS = [
  'claude-design',
  'known-claude-design',
  'known-codex-review',
  'codex-design',
  'known-claude-review',
  'claude-debugging-history',
  'codex-debugging-history',
  'control-e',
  'control-f',
] as const;

const roots: string[] = [];

describe('versioned driver acts', () => {
  test('a narrow channel answer may include extra relevant preferences', () => {
    expect(
      preferenceActAllowed('channel', {
        kind: 'answer',
        facts: ['local-browser', 'in-page', 'selective-notifications'],
      }),
    ).toBe(true);
  });

  test('channel acts still require an answer with in-page notices and no all-tasks contradiction', () => {
    expect(
      preferenceActAllowed('channel', {
        kind: 'answer',
        facts: ['local-browser'],
      }),
    ).toBe(false);
    expect(
      preferenceActAllowed('channel', {
        kind: 'answer',
        facts: ['in-page', 'all-tasks'],
      }),
    ).toBe(false);
    expect(
      preferenceActAllowed('channel', {
        kind: 'stop',
        facts: ['in-page'],
      }),
    ).toBe(false);
  });

  test('a channel answer cannot satisfy a broad preference or notification-scope question', () => {
    const narrow = { kind: 'answer', facts: ['in-page'] } as const;
    expect(preferenceActAllowed('channel', narrow)).toBe(true);
    expect(preferenceActAllowed('remaining-preferences', narrow)).toBe(false);
    expect(preferenceActAllowed('notification-scope', narrow)).toBe(false);
    expect(
      preferenceActAllowed('remaining-preferences', {
        kind: 'answer',
        facts: ['in-page', 'selective-notifications', 'local-browser'],
      }),
    ).toBe(true);
    expect(
      preferenceActAllowed('notification-scope', {
        kind: 'answer',
        facts: ['selective-notifications'],
      }),
    ).toBe(true);
  });

  test('a task-population answer does not require unrelated notification preferences', () => {
    expect(
      preferenceActAllowed('task-population', {
        kind: 'answer',
        facts: ['task-population'],
      }),
    ).toBe(true);
    expect(
      preferenceActAllowed('remaining-preferences', {
        kind: 'answer',
        facts: ['task-population'],
      }),
    ).toBe(false);
  });

  test('an inconsistent offered option must be declined while giving the relevant preference', () => {
    expect(
      preferenceActAllowed('offered-all-tasks', {
        kind: 'answer',
        facts: ['selective-notifications'],
        declinedInconsistentOption: true,
      }),
    ).toBe(true);
    expect(
      preferenceActAllowed('offered-all-tasks', {
        kind: 'answer',
        facts: ['selective-notifications'],
      }),
    ).toBe(false);
    expect(
      preferenceActAllowed('offered-all-tasks', {
        kind: 'answer',
        facts: ['all-tasks'],
      }),
    ).toBe(false);
  });

  test('delivery ends interaction even when the proposal contradicts the brief', () => {
    expect(preferenceActAllowed('delivery', { kind: 'stop', facts: [] })).toBe(
      true,
    );
    expect(
      preferenceActAllowed('delivery', {
        kind: 'answer',
        facts: ['selective-notifications'],
      }),
    ).toBe(false);
    expect(preferenceActAllowed('channel', { kind: 'stop', facts: [] })).toBe(
      false,
    );
  });

  test('the five other situations are reused and the preference case retains its subject and endpoint', () => {
    expect(driverCases.slice(1)).toEqual(priorDriverCases.slice(1));
    expect(driverCases[0]!.subjectCase).toBe('preferences');
    expect(driverCases[0]!.expectedCompletion).toBe('delivery');
    expect(driverCases[0]!.briefPath).not.toBe(priorDriverCases[0]!.briefPath);
  });
});

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function writeJson(root: string, path: string, value: unknown): void {
  write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function rubric(id: string, count: number): string {
  const criteria = Array.from(
    { length: count },
    (_, index) => `- obligation ${index + 1}`,
  );
  return `---\nid: ${id}\ntitle: Fixture\n---\n\nFixture.\n\n## Acceptance Criteria\n\n${criteria.join('\n')}\n`;
}

type Fixture = {
  root: string;
  casesPath: string;
  mappingsPath: string;
  expectationsPath: string;
  receiptPath: string;
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'routine-assessment-corpus-'));
  roots.push(root);
  const mappingsSpec = [
    ['design', 3, 10],
    ['code-review', 4, 6],
    ['debugging', 3, 11],
    ['verification', 3, 13],
  ] as const;
  const caseMappings = [
    'design',
    'design',
    'code-review',
    'design',
    'code-review',
    'debugging',
    'debugging',
    'verification',
    'verification',
  ];
  const reviewPath = 'reviews/fixture-review.json';
  writeJson(root, reviewPath, { reviewed: true });

  const mappings: RubricMapping[] = mappingsSpec.map(
    ([id, originalCount, atomicCount]) => {
      const originalPath = `cases/${id}/original-rubric.md`;
      const derivedPath = `rubrics/${id}.md`;
      write(root, originalPath, rubric(`conversation-${id}`, originalCount));
      write(root, derivedPath, rubric(`conversation-${id}`, atomicCount));
      return {
        id,
        originalRubric: {
          path: originalPath,
          sha256: sha256(join(root, originalPath)),
        },
        derivedRubric: {
          path: derivedPath,
          sha256: sha256(join(root, derivedPath)),
        },
        groups: Array.from({ length: originalCount }, (_, index) => ({
          originalOrdinal: index + 1,
          atomicOrdinals:
            index === originalCount - 1
              ? Array.from(
                  { length: atomicCount - originalCount + 1 },
                  (_unused, offset) => index + 1 + offset,
                )
              : [index + 1],
        })),
        independentReview: {
          path: reviewPath,
          sha256: sha256(join(root, reviewPath)),
        },
      };
    },
  );

  const cases: AssessmentCase[] = [];
  const expectations: AssessmentExpectation[] = [];
  const receiptCases: Array<{
    id: string;
    files: Array<{ path: string; sha256: string; bytes: number }>;
  }> = [];

  for (const [index, id] of CASE_IDS.entries()) {
    const mappingId = caseMappings[index]!;
    const mapping = mappings.find((item) => item.id === mappingId)!;
    const evidenceRoot = `cases/${id}/evidence`;
    const evidencePath = `${evidenceRoot}/evidence.txt`;
    const indexPath = `${evidenceRoot}/index.json`;
    write(root, evidencePath, `evidence for ${id}\n`);
    writeJson(root, indexPath, { files: ['evidence.txt'] });
    receiptCases.push({
      id,
      files: [
        {
          path: evidencePath,
          sha256: sha256(join(root, evidencePath)),
          bytes: readFileSync(join(root, evidencePath)).byteLength,
        },
      ],
    });
    cases.push({
      id,
      kind: id.startsWith('control-') ? 'constructed' : 'retained-live',
      mappingId,
      evidenceRoot,
      evidenceIndex: { path: indexPath, sha256: sha256(join(root, indexPath)) },
      authenticationRefs: [],
    });
    const atomic = mapping.groups
      .flatMap((group) => group.atomicOrdinals)
      .map((ordinal) => ({
        ordinal,
        verdict: 'pass' as const,
        decisiveEvidence: [{ path: 'evidence.txt', locator: 'whole fixture' }],
        rationale: `fixture judgment ${ordinal}`,
      }));
    expectations.push({
      caseId: id,
      mappingId,
      atomic,
      originalVerdicts: mapping.groups.map(() => 'pass' as const),
      independentReviews: [
        { path: reviewPath, sha256: sha256(join(root, reviewPath)) },
      ],
    });
  }

  const receiptPath = 'authentication/copy-receipt.json';
  writeJson(root, receiptPath, {
    cases: receiptCases,
    indexedCount: CASE_IDS.length,
  });
  const receiptRef = {
    path: receiptPath,
    sha256: sha256(join(root, receiptPath)),
  };
  for (const assessmentCase of cases)
    assessmentCase.authenticationRefs = [receiptRef];

  const casesPath = 'assessment-cases.json';
  const mappingsPath = 'rubric-mappings.json';
  const expectationsPath = 'expectations/assessment.json';
  writeJson(root, casesPath, cases);
  writeJson(root, mappingsPath, mappings);
  writeJson(root, expectationsPath, expectations);
  return { root, casesPath, mappingsPath, expectationsPath, receiptPath };
}

function json<T>(fixture: Fixture, path: string): T {
  return JSON.parse(readFileSync(join(fixture.root, path), 'utf8')) as T;
}

function parseFixtureRubric(text: string): {
  id: string;
  acceptanceCriteria: string[];
} {
  const id = text.match(/^id: (.+)$/m)?.[1] ?? 'missing';
  return {
    id,
    acceptanceCriteria: [...text.matchAll(/^- (.+)$/gm)].map(
      (match) => match[1]!,
    ),
  };
}

describe('atomic verdict folding', () => {
  test('a correct original failure cannot hide failing the wrong obligation', () => {
    const groups = [{ originalOrdinal: 1, atomicOrdinals: [1, 2] }];
    expect(
      checkCriterionAgreement(
        groups,
        ['pass', 'fail'],
        ['fail'],
        ['fail', 'pass'],
      ),
    ).toEqual({
      atomicMatch: false,
      originalMatch: true,
      match: false,
    });
  });

  test('a definite failure dominates unclear in a conjunctive original criterion', () => {
    expect(
      foldOriginalVerdicts(
        [{ originalOrdinal: 1, atomicOrdinals: [1, 2] }],
        ['unclear', 'fail'],
      ),
    ).toEqual(['fail']);
  });

  test('unclear dominates pass in a conjunctive original criterion', () => {
    expect(
      foldOriginalVerdicts(
        [{ originalOrdinal: 1, atomicOrdinals: [1, 2] }],
        ['pass', 'unclear'],
      ),
    ).toEqual(['unclear']);
  });

  const invalidCoverage: Array<
    [string, RubricMapping['groups'], Verdict[], string]
  > = [
    [
      'missing atom',
      [{ originalOrdinal: 1, atomicOrdinals: [1] }],
      ['pass', 'fail'],
      'missing atomic ordinal',
    ],
    [
      'duplicate atom',
      [
        { originalOrdinal: 1, atomicOrdinals: [1] },
        { originalOrdinal: 2, atomicOrdinals: [1] },
      ],
      ['pass'],
      'duplicate atomic ordinal',
    ],
    [
      'out-of-range original',
      [{ originalOrdinal: 2, atomicOrdinals: [1] }],
      ['pass'],
      'original ordinal 2',
    ],
    [
      'out-of-range atom',
      [{ originalOrdinal: 1, atomicOrdinals: [2] }],
      ['pass'],
      'atomic ordinal 2',
    ],
  ];

  test.each(
    invalidCoverage,
  )('rejects invalid ordinal coverage: %s', (_label, groups, atomic, message) => {
    expect(() => foldOriginalVerdicts(groups, atomic)).toThrow(message);
  });
});

describe('finite corpus validation', () => {
  test('loads exactly the fixed nine cases from a byte-authenticated package', () => {
    const fixture = makeFixture();
    const loaded = loadAssessmentCorpus(fixture.root, parseFixtureRubric);
    expect(loaded.cases.map((item) => item.id)).toEqual([...CASE_IDS]);
    expect(loaded.mappings.map((item) => item.id)).toEqual([
      'design',
      'code-review',
      'debugging',
      'verification',
    ]);
    expect(loaded.expectations).toHaveLength(9);
  });

  test.each([
    ['missing', (atoms: AssessmentExpectation['atomic']) => atoms.slice(0, -1)],
    [
      'extra',
      (atoms: AssessmentExpectation['atomic']) => [
        ...atoms,
        { ...atoms.at(-1)!, ordinal: atoms.length + 1 },
      ],
    ],
  ])('rejects %s expected atoms', (_label, mutate) => {
    const fixture = makeFixture();
    const expectations = json<AssessmentExpectation[]>(
      fixture,
      fixture.expectationsPath,
    );
    expectations[0]!.atomic = mutate(expectations[0]!.atomic);
    writeJson(fixture.root, fixture.expectationsPath, expectations);
    expect(() =>
      loadAssessmentCorpus(fixture.root, parseFixtureRubric),
    ).toThrow('complete atomic expectation coverage');
  });

  test('rejects incomplete or duplicated rubric ordinal mappings', () => {
    const fixture = makeFixture();
    const mappings = json<RubricMapping[]>(fixture, fixture.mappingsPath);
    mappings[0]!.groups[1]!.atomicOrdinals = [1];
    writeJson(fixture.root, fixture.mappingsPath, mappings);
    expect(() =>
      loadAssessmentCorpus(fixture.root, parseFixtureRubric),
    ).toThrow('duplicate atomic ordinal');
  });

  test('rejects a changed indexed evidence byte', () => {
    const fixture = makeFixture();
    write(
      fixture.root,
      'cases/claude-design/evidence/evidence.txt',
      'tampered evidence\n',
    );
    expect(() =>
      loadAssessmentCorpus(fixture.root, parseFixtureRubric),
    ).toThrow('sha256 mismatch');
  });

  test('rejects answer material in the candidate evidence index', () => {
    const fixture = makeFixture();
    const cases = json<AssessmentCase[]>(fixture, fixture.casesPath);
    const indexPath = cases[0]!.evidenceIndex.path;
    write(
      fixture.root,
      `${cases[0]!.evidenceRoot}/expected.json`,
      '{"answer":"pass"}\n',
    );
    writeJson(fixture.root, indexPath, {
      files: ['evidence.txt', 'expected.json'],
    });
    cases[0]!.evidenceIndex.sha256 = sha256(join(fixture.root, indexPath));
    writeJson(fixture.root, fixture.casesPath, cases);

    const receipt = json<{
      cases: Array<{
        id: string;
        files: Array<{ path: string; sha256: string; bytes: number }>;
      }>;
      indexedCount: number;
    }>(fixture, fixture.receiptPath);
    const answerPath = `${cases[0]!.evidenceRoot}/expected.json`;
    receipt.cases[0]!.files.push({
      path: answerPath,
      sha256: sha256(join(fixture.root, answerPath)),
      bytes: readFileSync(join(fixture.root, answerPath)).byteLength,
    });
    receipt.indexedCount += 1;
    writeJson(fixture.root, fixture.receiptPath, receipt);
    const receiptHash = sha256(join(fixture.root, fixture.receiptPath));
    for (const assessmentCase of cases)
      assessmentCase.authenticationRefs[0]!.sha256 = receiptHash;
    writeJson(fixture.root, fixture.casesPath, cases);

    expect(() =>
      loadAssessmentCorpus(fixture.root, parseFixtureRubric),
    ).toThrow('answer material is forbidden');
  });
});

const gauntletRoot = Bun.env['GAUNTLET_ROOT'];

describe.skipIf(!gauntletRoot)('Gauntlet story parser integration', () => {
  test('the tiny package runs through the real parseStoryCard', async () => {
    const fixture = makeFixture();
    const modulePath = resolve(gauntletRoot!, 'src/format/story-card.ts');
    const { parseStoryCard } = await import(pathToFileURL(modulePath).href);
    expect(
      loadAssessmentCorpus(fixture.root, parseStoryCard).cases,
    ).toHaveLength(9);
  });

  test('the credential alternatives remain one atomic obligation', async () => {
    const modulePath = resolve(gauntletRoot!, 'src/format/story-card.ts');
    const { parseStoryCard } = await import(pathToFileURL(modulePath).href);
    const root = resolve(import.meta.dir, '..');
    const parsed = parseStoryCard(
      readFileSync(
        resolve(
          root,
          'docs/experiments/2026-09-08-conversation-routine-use/rubrics/code-review.md',
        ),
        'utf8',
      ),
    );
    expect(parsed.acceptanceCriteria).toHaveLength(6);
    expect(parsed.acceptanceCriteria[2]).toContain('either hash(s) returns s');
    expect(parsed.acceptanceCriteria[2]).toContain(
      'or console.log emits password_hash',
    );
  });
});

const privateCaseRoot = Bun.env['ROUTINE_PRIVATE_CASE_ROOT'];

describe.skipIf(!gauntletRoot || !privateCaseRoot)(
  'private corpus freeze',
  () => {
    test('all nine cases and all 896 evidence files authenticate', async () => {
      const modulePath = resolve(gauntletRoot!, 'src/format/story-card.ts');
      const { parseStoryCard } = await import(pathToFileURL(modulePath).href);
      const corpus = loadAssessmentCorpus(privateCaseRoot!, parseStoryCard);
      const indexedCount = corpus.cases.reduce((sum, assessmentCase) => {
        const index = JSON.parse(
          readFileSync(
            resolve(privateCaseRoot!, assessmentCase.evidenceIndex.path),
            'utf8',
          ),
        ) as { files: string[] };
        return sum + index.files.length;
      }, 0);
      expect(corpus.cases).toHaveLength(9);
      expect(indexedCount).toBe(896);
    });
  },
);
