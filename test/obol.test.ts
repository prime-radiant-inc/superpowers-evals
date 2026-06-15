import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CostEstimate, ModelCost } from '@primeradianthq/obol';
import type { AtifTrajectory } from '../src/atif/types.ts';
import { estimateTrajectory, mergeEstimates } from '../src/obol/index.ts';

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

// ── estimateTrajectory: price an ATIF trajectory.json via obol's "atif"
//    dialect. These exercise the REAL obol native lib (atif dialect), so the
//    pricing math is obol's, not a quorum re-parser. ──────────────────────────

function writeTrajectory(traj: AtifTrajectory): string {
  const dir = mkdtempSync(join(tmpdir(), 'atif-traj-'));
  const f = join(dir, 'trajectory.json');
  writeFileSync(f, `${JSON.stringify(traj, null, 2)}\n`);
  return f;
}

test('estimateTrajectory prices a known model from per-step token buckets', async () => {
  const f = writeTrajectory({
    schema_version: 'ATIF-v1.7',
    agent: {
      name: 'claude',
      version: 'unknown',
      model_name: 'claude-opus-4-8',
    },
    steps: [
      {
        step_id: 1,
        source: 'agent',
        model_name: 'claude-opus-4-8',
        metrics: {
          prompt_tokens: 100,
          completion_tokens: 20,
          cached_tokens: 3,
        },
      },
    ],
  });
  const usage = await estimateTrajectory(f);
  expect(usage).not.toBeNull();
  const u = usage as NonNullable<typeof usage>;
  // disjoint buckets: prompt->input, completion->output, cached->cache_read.
  expect(u.total_input).toBe(100);
  expect(u.total_output).toBe(20);
  expect(u.total_cache_read).toBe(3);
  expect(u.total_tokens).toBe(123);
  expect(u.model).toBe('claude-opus-4-8');
  // obol has a rate for this model -> priced (a real positive number).
  expect(u.est_cost_usd).not.toBeNull();
  expect((u.est_cost_usd as number) > 0).toBe(true);
  expect(u.unpriced_models).toEqual([]);
});

test('estimateTrajectory honors an embedded cost_usd instead of re-pricing', async () => {
  // opencode/pi log a per-message cost; the atif dialect must use it verbatim.
  const f = writeTrajectory({
    schema_version: 'ATIF-v1.7',
    agent: { name: 'opencode', version: 'unknown', model_name: 'some-model' },
    steps: [
      {
        step_id: 1,
        source: 'agent',
        model_name: 'some-model',
        metrics: {
          prompt_tokens: 100,
          completion_tokens: 20,
          cached_tokens: 3,
          cost_usd: 0.42,
        },
      },
    ],
  });
  const usage = await estimateTrajectory(f);
  const u = usage as NonNullable<typeof usage>;
  expect(u.est_cost_usd).toBe(0.42);
  expect(u.total_tokens).toBe(123);
});

test('estimateTrajectory marks an unknown model unpriced (null cost, tokens kept)', async () => {
  const f = writeTrajectory({
    schema_version: 'ATIF-v1.7',
    agent: {
      name: 'gemini',
      version: 'unknown',
      model_name: 'totally-unknown-model-xyz',
    },
    steps: [
      {
        step_id: 1,
        source: 'agent',
        model_name: 'totally-unknown-model-xyz',
        metrics: { prompt_tokens: 50, completion_tokens: 10, cached_tokens: 0 },
      },
    ],
  });
  const usage = await estimateTrajectory(f);
  const u = usage as NonNullable<typeof usage>;
  expect(u.total_tokens).toBe(60);
  expect(u.est_cost_usd).toBeNull();
  expect(u.unpriced_models).toEqual(['totally-unknown-model-xyz']);
  expect(u.models['totally-unknown-model-xyz']?.est_cost_usd).toBeNull();
});

test('estimateTrajectory returns null for a no-usage (antigravity) trajectory', async () => {
  const f = writeTrajectory({
    schema_version: 'ATIF-v1.7',
    agent: { name: 'antigravity', version: 'unknown' },
    steps: [{ step_id: 1, source: 'agent' }],
  });
  expect(await estimateTrajectory(f)).toBeNull();
});

test('estimateTrajectory returns null when the trajectory file is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atif-missing-'));
  expect(await estimateTrajectory(join(dir, 'trajectory.json'))).toBeNull();
});

test('keeps the first TRUTHY pricing_as_of (empty string from earlier est is skipped)', () => {
  // Parity with Python `pricing_as_of = pricing_as_of or est.pricing_as_of`:
  // an empty-string pricing_as_of from the first estimate must NOT win over a
  // later real date. (`??` would have kept the '' since it is non-null.)
  const merged = mergeEstimates([
    est({ pricing_as_of: '' }),
    est({ pricing_as_of: '2026-06-09' }),
  ]);
  const m = merged as NonNullable<typeof merged>;
  expect(m.pricing_as_of).toBe('2026-06-09');
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
