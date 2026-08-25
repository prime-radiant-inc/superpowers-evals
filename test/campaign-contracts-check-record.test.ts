// test/campaign-contracts-check-record.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// The schema half plus the write-side fold rule: unit tests over the
// exported fold helper, and one REAL sink-line integration through
// runPhase/readRecords (a bash pre() emitting a raw record with unknown
// keys into QUORUM_RECORD_SINK).
import { runPhase } from '../src/checks/index.ts';
import { foldUnknownKeys } from '../src/checks/record-fold.ts';
import { CheckRecordSchema } from '../src/contracts/verdict.ts';

const REPO = resolve(import.meta.dir, '..');

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
  // score and metric values are finite: an unbounded number field would
  // otherwise admit Infinity into report aggregation.
  expect(() =>
    CheckRecordSchema.parse({ ...base, score: Number.POSITIVE_INFINITY }),
  ).toThrow();
  expect(() =>
    CheckRecordSchema.parse({
      ...base,
      metrics: { latency_ms: Number.NEGATIVE_INFINITY },
    }),
  ).toThrow();
});

test('unknown keys fold into detail with the pinned format', () => {
  // Pinned fold format (D1 spec, CheckRecord extension): pairs `key=value`,
  // joined by `; ` — nothing more when detail is null.
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
  expect(folded['detail']).toBe('note=ad hoc; verbosity=3');
  expect('verbosity' in folded).toBe(false);
  expect('note' in folded).toBe(false);
});

test('fold appends after an existing detail with a ` | ` separator', () => {
  const folded = foldUnknownKeys({
    check: 'c',
    args: [],
    negated: false,
    passed: false,
    detail: 'original',
    extra: 'x',
  });
  expect(folded['detail']).toBe('original | extra=x');
});

test('an empty-string detail is non-null: it is preserved, not treated as absent', () => {
  const folded = foldUnknownKeys({
    check: 'c',
    args: [],
    negated: false,
    passed: true,
    detail: '',
    extra: 'x',
  });
  expect(folded['detail']).toBe(' | extra=x');
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
  expect(folded['detail']).toBe('cfg={"a":1}');
});

test('a real sink line with unknown keys folds through runPhase/readRecords', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  const line = JSON.stringify({
    check: 'custom-emitter',
    args: ['x'],
    negated: false,
    passed: true,
    detail: 'seen',
    confidence: 0.9,
    verdict_hint: 'pass',
  });
  writeFileSync(
    checksSh,
    `pre() {\n  printf '%s\\n' '${line}' >> "$QUORUM_RECORD_SINK"\n}\npost() { :; }\n`,
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    repoRoot: REPO,
  });
  expect(exitCode).toBe(0);
  expect(records).toEqual([
    {
      check: 'custom-emitter',
      args: ['x'],
      negated: false,
      passed: true,
      detail: 'seen | confidence=0.9; verdict_hint=pass',
      phase: 'pre',
    },
  ]);
});
