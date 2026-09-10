import {
  basename,
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Verdict } from '../2026-09-08-conversation-routine-use/cases.ts';
import { authenticatedReader } from './reconstruct.ts';

type Ref = { path: string; sha256: string; bytes: number };
type AssessorInput = {
  rubric: Ref;
  evidenceRoot: string;
  index: Ref;
  evidence: Ref[];
};
type Control = {
  id: string;
  criterionCount: number;
  assessorInput: AssessorInput;
  privateExpectation: Ref;
};
type Manifest = { caseCount: number; criterionCount: number; cases: Control[] };
type Receipt = {
  status: string;
  blindReviewCommittedBeforeExpectationDisclosure: boolean;
  bindings: { manifest: Ref } & Record<string, Ref>;
  counts: {
    cases: number;
    criteria: number;
    matches: number;
    mismatches: number;
    authenticatedCaseReferences: number;
  };
  caseReferences: (Omit<Control, 'criterionCount'> & {
    blindCriterionVerdicts: Verdict[];
    expectedCriterionVerdicts: Verdict[];
    allCriteriaMatch: boolean;
  })[];
  authenticationReceipts: (Ref & { caseId: string; verified: boolean })[];
};
type Expectation = {
  caseId: string;
  criteria: {
    ordinal: number;
    verdict: Verdict;
    decisiveEvidence: { path: string }[];
  }[];
};

// Trust anchors from the controller-authenticated historical input inventory.
// A replacement corpus/receipt requires a new independently reviewed version.
const RECEIPT_SHA256 =
  'b82bb719f6b9963d2dab92e77b7457eb722d3abb32f6fb64c74731de4d92ab81';
const MANIFEST_SHA256 =
  'ee8fb0f4622b608dec9e53224e4d67a82b63fa8952b5adc8a5a4b814111e9f4d';

export type SupplementalControl = {
  id: string;
  rubricPath: string;
  evidenceRoot: string;
  evidenceIndexPath: string;
  expected: Verdict[];
};

function requireControl(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`invalid supplemental controls: ${message}`);
}

function readExact(root: string, ref: Ref, label: string): string {
  requireControl(
    !isAbsolute(ref.path) &&
      !ref.path.includes('\\') &&
      ref.path === posix.normalize(ref.path),
    `${label} path must be normalized and relative`,
  );
  let text: string;
  try {
    text = authenticatedReader(root, [ref])(ref.path);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('source hash mismatch:')
    ) {
      throw new Error(`${label} sha256 mismatch: ${ref.path}`);
    }
    throw error;
  }
  requireControl(
    Buffer.byteLength(text) === ref.bytes,
    `${label} byte length mismatch`,
  );
  return text;
}

/** Caller-only loader. Project the three paths explicitly before invoking Gauntlet. */
export function loadSupplementalControls(
  root: string,
  receiptPath: string,
): SupplementalControl[] {
  const receipt: Receipt = JSON.parse(
    readExact(
      dirname(receiptPath),
      {
        path: basename(receiptPath),
        sha256: RECEIPT_SHA256,
        bytes: 45068,
      },
      'receipt',
    ),
  );
  requireControl(
    receipt.status === 'approved' &&
      receipt.blindReviewCommittedBeforeExpectationDisclosure,
    'independent review is not approved',
  );
  requireControl(
    receipt.bindings.manifest.sha256 === MANIFEST_SHA256,
    'receipt manifest binding differs',
  );
  const manifest: Manifest = JSON.parse(
    readExact(
      root,
      {
        ...receipt.bindings.manifest,
        path: 'manifest.json',
      },
      'manifest',
    ),
  );

  // The pinned receipt carries historical absolute paths. Permit exact-byte
  // copies laid out under a new repair directory, never substitute new refs.
  for (const [label, ref] of Object.entries(receipt.bindings)) {
    const local = resolve(
      root,
      relative(dirname(receipt.bindings.manifest.path), ref.path),
    );
    readExact(
      dirname(root),
      { ...ref, path: relative(dirname(root), local) },
      label,
    );
  }
  requireControl(
    manifest.caseCount === 8 &&
      manifest.criterionCount === 16 &&
      manifest.cases.length === 8,
    'expected exactly eight cases and 16 criteria',
  );
  requireControl(
    receipt.counts.cases === 8 &&
      receipt.counts.criteria === 16 &&
      receipt.counts.matches === 16 &&
      receipt.counts.mismatches === 0 &&
      receipt.caseReferences.length === 8,
    'receipt counts differ',
  );

  let referenceCount = 0;
  const controls = manifest.cases.map((c, ordinal) => {
    requireControl(
      c.id === `control-${String(ordinal + 1).padStart(2, '0')}` &&
        c.criterionCount === 2,
      'fixed case identity or criterion count differs',
    );
    const reviewed = receipt.caseReferences[ordinal];
    requireControl(
      reviewed?.id === c.id &&
        reviewed.allCriteriaMatch &&
        isDeepStrictEqual(reviewed.assessorInput, c.assessorInput) &&
        isDeepStrictEqual(reviewed.privateExpectation, c.privateExpectation),
      `${c.id} receipt references differ`,
    );
    const input = c.assessorInput;
    const refs = [
      input.rubric,
      input.index,
      ...input.evidence,
      c.privateExpectation,
    ];
    const texts = new Map<string, string>();
    for (const ref of refs) {
      const authenticated = receipt.authenticationReceipts.filter(
        (r) => r.caseId === c.id && r.path === ref.path,
      );
      requireControl(
        authenticated.length === 1 &&
          authenticated[0]?.verified &&
          authenticated[0].sha256 === ref.sha256 &&
          authenticated[0].bytes === ref.bytes,
        `${c.id} authentication reference differs`,
      );
      texts.set(ref.path, readExact(root, ref, `${c.id} ${ref.path}`));
      referenceCount++;
    }
    requireControl(
      input.evidenceRoot === `cases/${c.id}/evidence` &&
        input.index.path === `${input.evidenceRoot}/index.json`,
      `${c.id} evidence scope differs`,
    );
    const index: { files: string[] } = JSON.parse(
      texts.get(input.index.path) ?? 'null',
    );
    requireControl(
      new Set(index.files).size === index.files.length &&
        isDeepStrictEqual(
          index.files.map((p) => `${input.evidenceRoot}/${p}`),
          input.evidence.map((r) => r.path),
        ),
      `${c.id} index membership differs`,
    );
    const expectation: Expectation = JSON.parse(
      texts.get(c.privateExpectation.path) ?? 'null',
    );
    requireControl(
      expectation.caseId === c.id &&
        expectation.criteria.length === c.criterionCount,
      `${c.id} expectation count differs`,
    );
    const expected = expectation.criteria.map((criterion, i) => {
      requireControl(
        criterion.ordinal === i + 1 &&
          ['pass', 'fail', 'unclear'].includes(criterion.verdict),
        `${c.id} expectation ordinal or verdict differs`,
      );
      requireControl(
        criterion.decisiveEvidence.length > 0 &&
          criterion.decisiveEvidence.every((e) => index.files.includes(e.path)),
        `${c.id} expectation cites unindexed evidence`,
      );
      return criterion.verdict;
    });
    requireControl(
      isDeepStrictEqual(expected, reviewed.expectedCriterionVerdicts) &&
        isDeepStrictEqual(expected, reviewed.blindCriterionVerdicts),
      `${c.id} reviewed expectation differs`,
    );
    return {
      id: c.id,
      rubricPath: resolve(root, input.rubric.path),
      evidenceRoot: resolve(root, input.evidenceRoot),
      evidenceIndexPath: resolve(root, input.index.path),
      expected,
    };
  });
  requireControl(
    referenceCount === 37 &&
      referenceCount === receipt.counts.authenticatedCaseReferences &&
      receipt.authenticationReceipts.length === referenceCount,
    'authentication coverage differs',
  );
  return controls;
}
