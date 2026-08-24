import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FinalVerdict,
  FinalVerdictSchema,
} from '../src/contracts/verdict.ts';

// Back-compat baseline: the inline shapes the repo already tests (the
// on-disk seats/dashboard fixtures are deliberately partial/legacy and sit
// outside FinalVerdictSchema by design).
test('existing verdict shapes parse unchanged (no campaign block)', () => {
  const v: FinalVerdict = {
    schema: 1,
    final: 'pass',
    final_reason: 'Gauntlet-Agent passed; no deterministic checks',
    gauntlet: {
      status: 'pass',
      summary: 's',
      reasoning: 'r',
      run_id: 'x_20260529T170857Z_32wy',
    },
    checks: [
      {
        check: 'git-repo',
        args: [],
        negated: false,
        passed: true,
        detail: null,
        phase: 'pre',
      },
    ],
    error: null,
    economics: null,
  };
  expect(FinalVerdictSchema.parse(v)).toEqual(v);
});

test('a complete real-world fixture parses', () => {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dir, 'fixtures', 'verdict-full.json'),
      'utf8',
    ),
  );
  const parsed = FinalVerdictSchema.parse(raw);
  expect(parsed.campaign).toEqual({
    campaign_id: 'cmp-0001',
    comparison_id: 'c1',
    block_id: 'b1',
    sample_id: 's1',
    execution_attempt_id: 'a1',
  });
});

test('the campaign block is optional and strictly shaped', () => {
  const base = FinalVerdictSchema.parse({
    schema: 1,
    final: 'fail',
    final_reason: 'checks failed',
    gauntlet: null,
    checks: [],
    error: null,
    economics: null,
  });
  expect(base.campaign).toBeUndefined();
  expect(() =>
    FinalVerdictSchema.parse({
      schema: 1,
      final: 'pass',
      final_reason: 'ok',
      gauntlet: null,
      checks: [],
      error: null,
      economics: null,
      campaign: { campaign_id: 'c' }, // missing the other four ids
    }),
  ).toThrow();
});
