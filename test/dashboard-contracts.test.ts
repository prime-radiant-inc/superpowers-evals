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

test('cellKey + cellId form the composite key and DOM id', () => {
  expect(cellKey('s', 'claude')).toBe('s\tclaude');
  expect(cellId('s', 'claude')).toBe('cell-s-claude');
});
