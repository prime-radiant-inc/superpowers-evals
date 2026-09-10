import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, posix, resolve } from 'node:path';

export type Verdict = 'pass' | 'fail' | 'unclear';
export type FileRef = { path: string; sha256: string };
export type CriterionGroup = { originalOrdinal: number; atomicOrdinals: number[] };
export type AssessmentCase = {
  id: string;
  kind: 'retained-live' | 'constructed';
  mappingId: string;
  evidenceRoot: string;
  evidenceIndex: FileRef;
  authenticationRefs: FileRef[];
};
export type RubricMapping = {
  id: string;
  originalRubric: FileRef;
  derivedRubric: FileRef;
  groups: CriterionGroup[];
  independentReview: FileRef;
};
export type AssessmentExpectation = {
  caseId: string;
  mappingId: string;
  atomic: {
    ordinal: number;
    verdict: Verdict;
    decisiveEvidence: { path: string; locator: string }[];
    rationale: string;
  }[];
  originalVerdicts: Verdict[];
  independentReviews: FileRef[];
};

const CASES_PATH = 'assessment-cases.json';
const MAPPINGS_PATH = 'rubric-mappings.json';
const EXPECTATIONS_PATH = 'expectations/assessment.json';

const CASE_SPECS = [
  ['claude-design', 'retained-live', 'design'],
  ['known-claude-design', 'retained-live', 'design'],
  ['known-codex-review', 'retained-live', 'code-review'],
  ['codex-design', 'retained-live', 'design'],
  ['known-claude-review', 'retained-live', 'code-review'],
  ['claude-debugging-history', 'retained-live', 'debugging'],
  ['codex-debugging-history', 'retained-live', 'debugging'],
  ['control-e', 'constructed', 'verification'],
  ['control-f', 'constructed', 'verification'],
] as const;

const MAPPING_SPECS = [
  ['design', 'conversation-design', 3, 10],
  ['code-review', 'conversation-code-review', 4, 6],
  ['debugging', 'conversation-debugging', 3, 11],
  ['verification', 'conversation-verification', 3, 13],
] as const;

const VERDICTS = new Set<Verdict>(['pass', 'fail', 'unclear']);
const ANSWER_FILE_NAMES = new Set([
  'assessment.json',
  'expected.json',
  'expectations.json',
  'gold.json',
  'result.json',
  'rubric-mappings.json',
  'rubric.md',
  'verdict.json',
]);
const ANSWER_DIRECTORIES = new Set([
  'assessments',
  'authentication',
  'expectations',
  'gold',
  'mappings',
  'reviews',
  'rubrics',
]);

type EvidenceIndex = { files: string[] };
type ReceiptFile = { path: string; sha256: string; bytes?: number };
type CopyReceipt = { cases: { id: string; files: ReceiptFile[] }[]; indexedCount?: number };

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invalid assessment corpus: ${message}`);
}

function parseJsonFile<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(`invalid assessment corpus: cannot read JSON ${path}: ${String(error)}`);
  }
}

function portablePath(path: unknown, label: string): asserts path is string {
  invariant(typeof path === 'string' && path.length > 0, `${label} must be a nonempty path`);
  invariant(!isAbsolute(path), `${label} must be repository-relative`);
  invariant(!path.includes('\\'), `${label} must use portable separators`);
  invariant(
    path === posix.normalize(path) && !path.split('/').includes('..'),
    `${label} must be a normalized path without traversal`,
  );
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifyFileRef(root: string, ref: FileRef, label: string): string {
  invariant(ref && typeof ref === 'object', `${label} must be a file reference`);
  portablePath(ref.path, `${label}.path`);
  invariant(/^[0-9a-f]{64}$/.test(ref.sha256), `${label}.sha256 must be lowercase SHA-256`);
  const path = resolve(root, ref.path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`invalid assessment corpus: cannot read ${label} ${ref.path}: ${String(error)}`);
  }
  invariant(digest(bytes) === ref.sha256, `${label} sha256 mismatch for ${ref.path}`);
  return path;
}

function assertExactOrder(actual: readonly string[], expected: readonly string[], label: string): void {
  invariant(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${label} must be exactly ${expected.join(', ')}`,
  );
}

function assertOrdinalCoverage(
  groups: readonly CriterionGroup[],
  originalCount: number,
  atomicCount: number,
): void {
  const originalSeen = new Set<number>();
  const atomicSeen = new Set<number>();
  for (const group of groups) {
    invariant(Number.isInteger(group.originalOrdinal), 'original ordinals must be integers');
    invariant(
      group.originalOrdinal >= 1 && group.originalOrdinal <= originalCount,
      `original ordinal ${group.originalOrdinal} is out of range`,
    );
    invariant(!originalSeen.has(group.originalOrdinal), `duplicate original ordinal ${group.originalOrdinal}`);
    originalSeen.add(group.originalOrdinal);
    invariant(group.atomicOrdinals.length > 0, `original ordinal ${group.originalOrdinal} has no atoms`);
    for (const ordinal of group.atomicOrdinals) {
      invariant(Number.isInteger(ordinal), 'atomic ordinals must be integers');
      invariant(ordinal >= 1 && ordinal <= atomicCount, `atomic ordinal ${ordinal} is out of range`);
      invariant(!atomicSeen.has(ordinal), `duplicate atomic ordinal ${ordinal}`);
      atomicSeen.add(ordinal);
    }
  }
  invariant(
    originalSeen.size === originalCount &&
      Array.from({ length: originalCount }, (_, index) => index + 1).every((ordinal) =>
        originalSeen.has(ordinal),
      ),
    'original ordinals do not have complete coverage',
  );
  invariant(
    atomicSeen.size === atomicCount &&
      Array.from({ length: atomicCount }, (_, index) => index + 1).every((ordinal) =>
        atomicSeen.has(ordinal),
      ),
    'missing atomic ordinal from criterion groups',
  );
}

export function foldOriginalVerdicts(
  groups: readonly CriterionGroup[],
  atomic: readonly Verdict[],
): Verdict[] {
  for (const verdict of atomic) invariant(VERDICTS.has(verdict), `unknown verdict ${verdict}`);
  assertOrdinalCoverage(groups, groups.length, atomic.length);
  return groups.map((group) => {
    const values = group.atomicOrdinals.map((ordinal) => atomic[ordinal - 1]!);
    return values.includes('fail') ? 'fail' : values.includes('unclear') ? 'unclear' : 'pass';
  });
}

function equalVectors(left: readonly Verdict[], right: readonly Verdict[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function checkCriterionAgreement(
  groups: readonly CriterionGroup[],
  expectedAtomic: readonly Verdict[],
  expectedOriginal: readonly Verdict[],
  actualAtomic: readonly Verdict[],
): { atomicMatch: boolean; originalMatch: boolean; match: boolean } {
  for (const verdict of expectedOriginal) invariant(VERDICTS.has(verdict), `unknown verdict ${verdict}`);
  const expectedFold = foldOriginalVerdicts(groups, expectedAtomic);
  invariant(
    equalVectors(expectedFold, expectedOriginal),
    'expected original verdicts do not equal the atomic fold',
  );
  const actualFold = foldOriginalVerdicts(groups, actualAtomic);
  const atomicMatch = equalVectors(expectedAtomic, actualAtomic);
  const originalMatch = equalVectors(expectedOriginal, actualFold);
  return { atomicMatch, originalMatch, match: atomicMatch && originalMatch };
}

function isCopyReceipt(value: unknown): value is CopyReceipt {
  if (!value || typeof value !== 'object') return false;
  const cases = (value as { cases?: unknown }).cases;
  return (
    Array.isArray(cases) &&
    cases.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        Array.isArray((item as { files?: unknown }).files),
    )
  );
}

function answerMaterial(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  return (
    ANSWER_FILE_NAMES.has(segments.at(-1) ?? '') ||
    segments.slice(0, -1).some((segment) => ANSWER_DIRECTORIES.has(segment))
  );
}

function validateEvidence(
  root: string,
  assessmentCase: AssessmentCase,
  expectations: AssessmentExpectation,
): number {
  portablePath(assessmentCase.evidenceRoot, `${assessmentCase.id}.evidenceRoot`);
  const indexPath = verifyFileRef(root, assessmentCase.evidenceIndex, `${assessmentCase.id}.evidenceIndex`);
  const index = parseJsonFile<EvidenceIndex>(indexPath);
  invariant(index && Array.isArray(index.files), `${assessmentCase.id} evidence index needs files`);
  invariant(index.files.length > 0, `${assessmentCase.id} evidence index is empty`);
  const indexed = new Set<string>();
  for (const path of index.files) {
    portablePath(path, `${assessmentCase.id} indexed evidence`);
    invariant(!indexed.has(path), `${assessmentCase.id} duplicate indexed evidence ${path}`);
    invariant(!answerMaterial(path), `${assessmentCase.id} answer material is forbidden: ${path}`);
    indexed.add(path);
  }

  for (const atom of expectations.atomic) {
    invariant(atom.decisiveEvidence.length > 0, `${assessmentCase.id} atom ${atom.ordinal} lacks evidence`);
    for (const evidence of atom.decisiveEvidence) {
      portablePath(evidence.path, `${assessmentCase.id} decisive evidence`);
      invariant(
        indexed.has(evidence.path),
        `${assessmentCase.id} decisive evidence is not indexed: ${evidence.path}`,
      );
      invariant(
        typeof evidence.locator === 'string' && evidence.locator.trim().length > 0,
        `${assessmentCase.id} decisive evidence locator is empty`,
      );
    }
  }

  invariant(
    Array.isArray(assessmentCase.authenticationRefs) && assessmentCase.authenticationRefs.length > 0,
    `${assessmentCase.id} needs authentication references`,
  );
  let receiptFiles: ReceiptFile[] | null = null;
  for (const [index, ref] of assessmentCase.authenticationRefs.entries()) {
    const path = verifyFileRef(root, ref, `${assessmentCase.id}.authenticationRefs[${index}]`);
    let possible: unknown;
    try {
      possible = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (!isCopyReceipt(possible)) continue;
    const receiptCase = possible.cases.find((item) => item.id === assessmentCase.id);
    if (receiptCase) receiptFiles = receiptCase.files;
  }
  invariant(receiptFiles !== null, `${assessmentCase.id} has no byte-level authentication receipt`);
  invariant(receiptFiles.length === indexed.size, `${assessmentCase.id} receipt/index membership differs`);
  const receiptByPath = new Map<string, ReceiptFile>();
  for (const file of receiptFiles) {
    portablePath(file.path, `${assessmentCase.id} receipt file`);
    invariant(!receiptByPath.has(file.path), `${assessmentCase.id} receipt repeats ${file.path}`);
    receiptByPath.set(file.path, file);
  }
  for (const relativePath of indexed) {
    const portable = posix.join(assessmentCase.evidenceRoot, relativePath);
    const ref = receiptByPath.get(portable);
    invariant(ref !== undefined, `${assessmentCase.id} receipt omits ${relativePath}`);
    const path = verifyFileRef(root, ref, `${assessmentCase.id} evidence`);
    if (ref.bytes !== undefined) {
      invariant(
        readFileSync(path).byteLength === ref.bytes,
        `${assessmentCase.id} byte length mismatch for ${relativePath}`,
      );
    }
  }
  return indexed.size;
}

export function loadAssessmentCorpus(
  root: string,
  parseRubric: (text: string) => { id: string; acceptanceCriteria: string[] },
): {
  cases: AssessmentCase[];
  mappings: RubricMapping[];
  expectations: AssessmentExpectation[];
} {
  const cases = parseJsonFile<AssessmentCase[]>(resolve(root, CASES_PATH));
  const mappings = parseJsonFile<RubricMapping[]>(resolve(root, MAPPINGS_PATH));
  const expectations = parseJsonFile<AssessmentExpectation[]>(resolve(root, EXPECTATIONS_PATH));
  invariant(Array.isArray(cases), 'assessment-cases.json must be an array');
  invariant(Array.isArray(mappings), 'rubric-mappings.json must be an array');
  invariant(Array.isArray(expectations), 'expectations/assessment.json must be an array');
  assertExactOrder(
    cases.map((item) => item.id),
    CASE_SPECS.map(([id]) => id),
    'case ids',
  );
  assertExactOrder(
    mappings.map((item) => item.id),
    MAPPING_SPECS.map(([id]) => id),
    'mapping ids',
  );
  assertExactOrder(
    expectations.map((item) => item.caseId),
    CASE_SPECS.map(([id]) => id),
    'expectation case ids',
  );

  const mappingById = new Map<string, RubricMapping>();
  for (const [index, mapping] of mappings.entries()) {
    const [expectedId, storyId, originalCount, atomicCount] = MAPPING_SPECS[index]!;
    invariant(mapping.id === expectedId, `unexpected mapping ${mapping.id}`);
    invariant(!mappingById.has(mapping.id), `duplicate mapping ${mapping.id}`);
    mappingById.set(mapping.id, mapping);
    const originalPath = verifyFileRef(root, mapping.originalRubric, `${mapping.id}.originalRubric`);
    const derivedPath = verifyFileRef(root, mapping.derivedRubric, `${mapping.id}.derivedRubric`);
    verifyFileRef(root, mapping.independentReview, `${mapping.id}.independentReview`);
    const original = parseRubric(readFileSync(originalPath, 'utf8'));
    const derived = parseRubric(readFileSync(derivedPath, 'utf8'));
    invariant(original.id === storyId, `${mapping.id} original rubric id must be ${storyId}`);
    invariant(derived.id === storyId, `${mapping.id} derived rubric id must be ${storyId}`);
    invariant(
      original.acceptanceCriteria.length === originalCount,
      `${mapping.id} original criterion count must be ${originalCount}`,
    );
    invariant(
      derived.acceptanceCriteria.length === atomicCount,
      `${mapping.id} atomic criterion count must be ${atomicCount}`,
    );
    assertOrdinalCoverage(mapping.groups, originalCount, atomicCount);
  }

  for (const [index, assessmentCase] of cases.entries()) {
    const [expectedId, expectedKind, expectedMapping] = CASE_SPECS[index]!;
    invariant(assessmentCase.id === expectedId, `unexpected case ${assessmentCase.id}`);
    invariant(assessmentCase.kind === expectedKind, `${assessmentCase.id} has wrong source kind`);
    invariant(assessmentCase.mappingId === expectedMapping, `${assessmentCase.id} has wrong mapping`);
    const mapping = mappingById.get(assessmentCase.mappingId);
    invariant(mapping !== undefined, `${assessmentCase.id} references an unknown mapping`);
    const expectation = expectations[index]!;
    invariant(expectation.caseId === assessmentCase.id, `${assessmentCase.id} expectation is misordered`);
    invariant(expectation.mappingId === assessmentCase.mappingId, `${assessmentCase.id} expectation mapping differs`);
    const atomicCount = mapping.groups.flatMap((group) => group.atomicOrdinals).length;
    invariant(
      expectation.atomic.length === atomicCount &&
        expectation.atomic.every((atom, atomIndex) => atom.ordinal === atomIndex + 1),
      `${assessmentCase.id} lacks complete atomic expectation coverage`,
    );
    for (const atom of expectation.atomic) {
      invariant(VERDICTS.has(atom.verdict), `${assessmentCase.id} atom ${atom.ordinal} has unknown verdict`);
      invariant(
        typeof atom.rationale === 'string' && atom.rationale.trim().length > 0,
        `${assessmentCase.id} atom ${atom.ordinal} has no rationale`,
      );
    }
    invariant(
      expectation.originalVerdicts.length === mapping.groups.length &&
        expectation.originalVerdicts.every((verdict) => VERDICTS.has(verdict)),
      `${assessmentCase.id} has an invalid original verdict vector`,
    );
    invariant(
      equalVectors(
        foldOriginalVerdicts(
          mapping.groups,
          expectation.atomic.map((atom) => atom.verdict),
        ),
        expectation.originalVerdicts,
      ),
      `${assessmentCase.id} original verdicts do not equal the atomic fold`,
    );
    invariant(
      Array.isArray(expectation.independentReviews) && expectation.independentReviews.length > 0,
      `${assessmentCase.id} needs independent review`,
    );
    for (const [reviewIndex, ref] of expectation.independentReviews.entries()) {
      verifyFileRef(root, ref, `${assessmentCase.id}.independentReviews[${reviewIndex}]`);
    }
    validateEvidence(root, assessmentCase, expectation);
  }

  return { cases, mappings, expectations };
}
