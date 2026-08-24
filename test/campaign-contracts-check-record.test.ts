// test/campaign-contracts-check-record.test.ts
import { expect, test } from 'bun:test';
// readRecords is module-private; drive it through runPhase's public surface
// is too heavy for a contract test, so this suite covers the schema half
// and the fold half via the exported fold helper (implemented in step 3).
import { foldUnknownKeys } from '../src/checks/record-fold.ts';
import { CheckRecordSchema } from '../src/contracts/verdict.ts';

test('CheckRecord keeps its base shape and gains optional extensions', () => {
  const base = {
    check: 'file-contains',
    args: ['out.txt', 'done'],
    negated: false,
    passed: true,
    detail: null,
    phase: 'post' as const,
  };
  expect(CheckRecordSchema.parse(base)).toEqual(base);
  const extended = {
    ...base,
    score: 0.92,
    metrics: { latency_ms: 120 },
    tags: ['smoke'],
    notes: 'borderline',
  };
  expect(CheckRecordSchema.parse(extended)).toEqual(extended);
});

test('unknown keys fold into detail with the pinned format', () => {
  const folded = foldUnknownKeys({
    check: 'custom-verb',
    args: [],
    negated: false,
    passed: true,
    detail: null,
    phase: 'post',
    verbosity: 3,
    note: 'ad hoc',
  });
  expect(folded['detail']).toBe('folded: note=ad hoc; verbosity=3');
  expect('verbosity' in folded).toBe(false);
  expect('note' in folded).toBe(false);
});

test('fold appends after an existing detail with a separator', () => {
  const folded = foldUnknownKeys({
    check: 'c',
    args: [],
    negated: false,
    passed: false,
    detail: 'original',
    extra: 'x',
  });
  expect(folded['detail']).toBe('original | folded: extra=x');
});

test('no unknown keys means untouched output', () => {
  const record = {
    check: 'c',
    args: [],
    negated: false,
    passed: true,
    detail: null,
    phase: 'pre',
  };
  expect(foldUnknownKeys(record)).toBe(record); // same reference, no copy
});

test('folded non-string values serialize as JSON', () => {
  const folded = foldUnknownKeys({
    check: 'c',
    args: [],
    negated: false,
    passed: true,
    detail: null,
    cfg: { a: 1 },
  });
  expect(folded['detail']).toBe('folded: cfg={"a":1}');
});
