import { expect, test } from 'bun:test';
import { GauntletResultSchema } from '../src/contracts/gauntlet.ts';
import {
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
