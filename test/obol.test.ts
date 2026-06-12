import { expect, test } from 'bun:test';
import type { CostEstimate, ModelCost } from '@primeradianthq/obol';
import { mergeEstimates } from '../src/obol/index.ts';

// Typed CostEstimate fixtures (standard bans `as never`). The factory takes a
// typed partial override and merges it over a fully-typed baseline, so any
// drift from obol's real `CostEstimate` shape is a typecheck failure.
function modelCost(over: Partial<ModelCost> = {}): ModelCost {
  return {
    model: 'claude-opus-4-8',
    provider: 'anthropic',
    subtotal_usd: 0.5,
    tokens: { input: 100, output: 20, cache_write: 5, cache_read: 3 },
    ...over,
  };
}

function est(over: Partial<CostEstimate> = {}): CostEstimate {
  const perModel = over.per_model ?? [modelCost()];
  return {
    total_usd: 0.5,
    pricing_as_of: '2026-06-09',
    unpriced_models: [],
    approximations: [],
    tokens: { input: 100, output: 20, cache_write: 5, cache_read: 3 },
    ...over,
    per_model: perModel,
  };
}

test('sums tokens, maps cache_write->total_cache_create, rounds cost', () => {
  const merged = mergeEstimates([est(), est()]);
  expect(merged).not.toBeNull();
  const m = merged as NonNullable<typeof merged>;
  expect(m.total_input).toBe(200);
  expect(m.total_cache_create).toBe(10);
  expect(m.total_output).toBe(40);
  expect(m.total_tokens).toBe(200 + 10 + 6 + 40);
  expect(m.est_cost_usd).toBe(1);
  expect(m.model).toBe('claude-opus-4-8');
  expect(m.pricing_as_of).toBe('2026-06-09');
});

test('returns null when total_tokens is 0', () => {
  const zero = est({ per_model: [] });
  expect(mergeEstimates([zero])).toBeNull();
});

test('est_cost_usd is null when every model is unpriced', () => {
  const merged = mergeEstimates([
    est({ unpriced_models: ['claude-opus-4-8'] }),
  ]);
  const m = merged as NonNullable<typeof merged>;
  expect(m.est_cost_usd).toBeNull();
  expect(m.unpriced_models).toEqual(['claude-opus-4-8']);
  expect(m.models['claude-opus-4-8']?.est_cost_usd).toBeNull();
});

test('dedupes approximations by (kind, detail) tuple; undefined detail -> null', () => {
  const a = est({ approximations: [{ kind: 'rounded', detail: 'x' }] });
  const b = est({ approximations: [{ kind: 'rounded', detail: 'x' }] });
  const c = est({ approximations: [{ kind: 'rounded' }] });
  const merged = mergeEstimates([a, b, c]);
  const m = merged as NonNullable<typeof merged>;
  expect(m.approximations).toEqual([
    { kind: 'rounded', detail: 'x' },
    { kind: 'rounded', detail: null },
  ]);
});
