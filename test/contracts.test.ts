import { expect, test } from 'bun:test';
import { GauntletResultSchema } from '../src/contracts/gauntlet.ts';
import {
  EXIT_CODE_BY_FINAL,
  FINAL_STATUSES,
  type FinalVerdict,
  FinalVerdictSchema,
} from '../src/contracts/verdict.ts';

test('a real verdict.json parses and round-trips', () => {
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

test('the quorum run exit-code contract encodes every final status distinctly (pass 0, fail 1, indeterminate 2)', () => {
  // Shared by the CLI (which exits with it) and the campaign dispatcher
  // (which reads the child's code back through it): a verdict's exit code
  // must be unique so the reader can tell a verdict-consistent exit from a
  // crash.
  expect(EXIT_CODE_BY_FINAL).toEqual({ pass: 0, fail: 1, indeterminate: 2 });
  const codes = FINAL_STATUSES.map((s) => EXIT_CODE_BY_FINAL[s]);
  expect(new Set(codes).size).toBe(FINAL_STATUSES.length);
});

test('gauntlet result.json validates status and reads run-relevant fields', () => {
  const r = GauntletResultSchema.parse({
    schemaVersion: 5,
    runId: 'x_20260529T170857Z_32wy',
    status: 'fail',
    summary: 's',
    reasoning: 'r',
    duration_ms: 1234,
    config: { model: 'claude-sonnet-4-6', target: 'claude', adapter: 'tui' },
  });
  expect(r.status).toBe('fail');
  expect(r.config?.model).toBe('claude-sonnet-4-6');
});
