import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

export interface DiscoveryCitation {
  relativePath: string;
  line: number;
  quote: string;
}

export interface DiscoveryAnswerKey {
  harness: 'claude' | 'codex' | 'pi';
  targetSessionId: string;
  targetRelativePath: string;
  humanRequests: string[];
  expectedFact: string;
  allowedEvidence: DiscoveryCitation[];
}

export interface ExtractedDiscoveryAnswer {
  sessionId: string | null;
  sourcePath: string | null;
  humanRequests: string[];
  fact: string | null;
  citations: DiscoveryCitation[];
}

export interface DiscoveryCheck {
  check: string;
  passed: boolean;
  detail: string;
}

function result(
  check: string,
  passed: boolean,
  detail: string,
): DiscoveryCheck {
  return { check, passed, detail };
}

function canonicalRelativePath(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    posix.normalize(path) === path &&
    path !== '..' &&
    !path.startsWith('../')
  );
}

/**
 * Convert the subject's raw absolute source path to the canonical path used by
 * the private key. The caller supplies the disposable run's actual native log
 * root from operator evidence. This is an exact root containment check: a
 * basename or matching suffix beneath another root is never accepted. Invalid
 * subject paths return null; an invalid operator-supplied root is an assessment
 * error.
 */
export function canonicalizeReportedSourcePath(
  reportedPath: string,
  nativeLogRoot: string,
): string | null {
  if (!isAbsolute(nativeLogRoot)) {
    throw new Error('assessment error: native log root must be absolute');
  }
  if (!isAbsolute(reportedPath)) return null;
  const root = resolve(nativeLogRoot);
  const reported = resolve(reportedPath);
  const rel = relative(root, reported);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return null;
  }
  const portable = rel.split(sep).join('/');
  if (!canonicalRelativePath(portable)) return null;
  return portable;
}

function sameStrings(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function citationKey(citation: DiscoveryCitation): string {
  return JSON.stringify([citation.relativePath, citation.line, citation.quote]);
}

function validateExpectedEvidence(
  key: DiscoveryAnswerKey,
  readLine: (relativePath: string, line: number) => string | undefined,
): void {
  if (!canonicalRelativePath(key.targetRelativePath)) {
    throw new Error(
      'assessment error: answer key target path is not a canonical relative path',
    );
  }
  if (key.allowedEvidence.length === 0) {
    throw new Error('assessment error: answer key has no expected evidence');
  }
  for (const citation of key.allowedEvidence) {
    if (
      !canonicalRelativePath(citation.relativePath) ||
      !Number.isInteger(citation.line) ||
      citation.line < 1 ||
      citation.quote === ''
    ) {
      throw new Error(
        'assessment error: answer key has invalid expected evidence',
      );
    }
    const source = readLine(citation.relativePath, citation.line);
    if (source === undefined) {
      throw new Error(
        `assessment error: expected evidence is missing at ${citation.relativePath}:${citation.line}`,
      );
    }
    if (!source.includes(citation.quote)) {
      throw new Error(
        `assessment error: expected evidence quote does not match ${citation.relativePath}:${citation.line}`,
      );
    }
  }
}

/**
 * Check claims transcribed by an independent reviewer from the subject's
 * ordinary answer. This function compares canonical claims and verifies that
 * cited text exists at an answer-key-approved location. It does not extract
 * prose, validate the root of an absolute path reported by the subject, or
 * decide whether a quotation semantically entails a claim; those judgments
 * stay in the reviewer's private assessment artifact.
 */
export function checkDiscoveryAnswer(
  answer: ExtractedDiscoveryAnswer,
  key: DiscoveryAnswerKey,
  readLine: (relativePath: string, line: number) => string | undefined,
): DiscoveryCheck[] {
  validateExpectedEvidence(key, readLine);

  const targetSession = answer.sessionId === key.targetSessionId;
  const sourcePath =
    answer.sourcePath !== null &&
    canonicalRelativePath(answer.sourcePath) &&
    answer.sourcePath === key.targetRelativePath;
  const humanRequests = sameStrings(answer.humanRequests, key.humanRequests);
  const expectedFact = answer.fact === key.expectedFact;
  const hasCitations = answer.citations.length > 0;
  const citationSource =
    hasCitations &&
    answer.citations.every((citation) => {
      if (
        !canonicalRelativePath(citation.relativePath) ||
        !Number.isInteger(citation.line) ||
        citation.line < 1 ||
        citation.quote === ''
      ) {
        return false;
      }
      return (
        readLine(citation.relativePath, citation.line)?.includes(
          citation.quote,
        ) === true
      );
    });
  const allowed = new Set(key.allowedEvidence.map(citationKey));
  const citationRelevance =
    hasCitations &&
    answer.citations.every((citation) => allowed.has(citationKey(citation)));
  const missingSubjectOutput =
    answer.sessionId === null &&
    answer.sourcePath === null &&
    answer.humanRequests.length === 0 &&
    answer.fact === null &&
    answer.citations.length === 0;
  const detail = (passed: boolean, success: string, failure: string): string =>
    passed
      ? success
      : missingSubjectOutput
        ? `subject produced no discovery output: ${failure}`
        : `subject answer failed: ${failure}`;

  return [
    result(
      'target-session',
      targetSession,
      detail(targetSession, 'session id matches', 'session id does not match'),
    ),
    result(
      'source-path',
      sourcePath,
      detail(
        sourcePath,
        'canonical source path matches',
        'canonical source path does not match',
      ),
    ),
    result(
      'human-requests',
      humanRequests,
      detail(
        humanRequests,
        'human requests match in order',
        'human requests are missing, reordered, or include non-human text',
      ),
    ),
    result(
      'expected-fact',
      expectedFact,
      detail(
        expectedFact,
        'reported fact matches',
        'reported fact does not match',
      ),
    ),
    result(
      'citation-source',
      citationSource,
      detail(
        citationSource,
        'all cited quotations exist at their canonical locations',
        'a citation is missing, malformed, escaping, or misquoted',
      ),
    ),
    result(
      'citation-relevance',
      citationRelevance,
      detail(
        citationRelevance,
        'all citations are allowed evidence locations',
        'a citation is not an allowed evidence location',
      ),
    ),
  ];
}
