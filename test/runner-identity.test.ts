import { expect, test } from 'bun:test';
import { FinalVerdictSchema } from '../src/contracts/verdict.ts';

// The schema accepts the four additive identity fields, all optional.
test('FinalVerdictSchema accepts identity fields', () => {
  const v = {
    schema: 1,
    final: 'pass',
    final_reason: 'ok',
    gauntlet: null,
    checks: [],
    error: null,
    economics: null,
    scenario: 'demo',
    coding_agent: 'claude',
    started_at: '2026-06-12T00:00:00.000Z',
    finished_at: '2026-06-12T00:01:00.000Z',
  };
  expect(FinalVerdictSchema.parse(v).scenario).toBe('demo');
});

// A verdict with no identity fields still parses (old runs).
test('FinalVerdictSchema identity fields are optional', () => {
  const v = {
    schema: 1,
    final: 'pass',
    final_reason: 'ok',
    gauntlet: null,
    checks: [],
    error: null,
    economics: null,
  };
  expect(FinalVerdictSchema.parse(v).scenario).toBeUndefined();
});
