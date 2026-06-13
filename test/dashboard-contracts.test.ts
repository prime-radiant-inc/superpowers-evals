import { expect, test } from 'bun:test';
import {
  cellId,
  cellKey,
  DashboardVerdictSchema,
  PhaseJsonSchema,
} from '../src/dashboard/contracts.ts';

// The dashboard contracts keystone — the literal unions + zod schemas every
// other dashboard module imports.

test('PhaseJsonSchema parses runner output', () => {
  const p = PhaseJsonSchema.parse({
    phase: 'agent',
    updated_at: '2026-06-12T00:00:00Z',
    pid: 42,
  });
  expect(p.phase).toBe('agent');
  expect(p.pid).toBe(42);
});

test('PhaseJsonSchema requires pid (liveness signal)', () => {
  expect(
    PhaseJsonSchema.safeParse({ phase: 'agent', updated_at: 'x' }).success,
  ).toBe(false);
});

test('DashboardVerdictSchema narrows to the read-side fields', () => {
  const v = DashboardVerdictSchema.parse({
    final: 'pass',
    economics: { total_est_cost_usd: 1.25 },
    finished_at: '2026-06-12T00:01:00Z',
    scenario: 'demo',
    coding_agent: 'claude',
  });
  expect(v.final).toBe('pass');
  expect(v.economics?.total_est_cost_usd).toBe(1.25);
  expect(v.scenario).toBe('demo');
});

test('DashboardVerdictSchema tolerates a partial/old verdict', () => {
  const v = DashboardVerdictSchema.parse({ final: 'fail' });
  expect(v.final).toBe('fail');
  expect(v.economics).toBeUndefined();
  expect(v.scenario).toBeUndefined();
});

test('DashboardVerdictSchema: one wrong-typed field never sinks the parse', () => {
  // A malformed/legacy verdict (non-string final, integer-epoch finished_at,
  // string cost) must still read as a PRESENT verdict so the authority rule
  // holds — parity with Python's type-blind .get(). The bad fields degrade:
  // final -> undefined (read-side collapses to 'unknown'), cost -> null.
  const v = DashboardVerdictSchema.parse({
    final: null,
    finished_at: 123,
    economics: { total_est_cost_usd: 'x' },
    scenario: 42,
  });
  expect(v.final).toBeUndefined();
  expect(v.finished_at).toBeNull();
  expect(v.economics?.total_est_cost_usd).toBeNull();
  expect(v.scenario).toBeUndefined();
});

test('DashboardVerdictSchema: a non-object economics degrades to null', () => {
  const v = DashboardVerdictSchema.parse({ final: 'pass', economics: 'oops' });
  expect(v.final).toBe('pass');
  expect(v.economics).toBeNull();
});

test('cellKey + cellId form the composite key and DOM id', () => {
  expect(cellKey('s', 'claude')).toBe('s\tclaude');
  expect(cellId('s', 'claude')).toBe('cell-s-claude');
});
