import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CostEstimate, ModelCost } from '@primeradianthq/obol';
import { estimateSessionLogs, mergeEstimates } from '../src/obol/index.ts';

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

test('estimateSessionLogs adds kimi tool_result_total_bytes (UTF-8) for kimi', async () => {
  // The byte total sums the UTF-8 length of every tool.result output string in
  // context.append_loop_event rows. "café" is 5 UTF-8 bytes; "hi" is 2 -> 7.
  // Non-string outputs and non-tool.result events contribute nothing.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-bytes-'));
  const f = join(dir, 'wire.jsonl');
  const rows = [
    {
      type: 'usage.record',
      usageScope: 'turn',
      model: 'kimi-for-coding',
      time: 1_800_000_000_000,
      usage: {
        inputOther: 1,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        output: 1,
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        toolCallId: 't1',
        result: { output: 'café' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        toolCallId: 't2',
        result: { output: 'hi' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'tool.result', toolCallId: 't3', result: { output: 123 } },
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'assistant.message', result: { output: 'ignored' } },
    },
  ];
  writeFileSync(f, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const usage = await estimateSessionLogs('kimi', [f]);
  expect(usage).not.toBeNull();
  expect((usage as NonNullable<typeof usage>).tool_result_total_bytes).toBe(7);
});

test('estimateSessionLogs does not add tool_result_total_bytes for non-kimi', async () => {
  // A claude log carrying append_loop_event-shaped rows must NOT get the kimi
  // byte field — it is kimi-only.
  const dir = mkdtempSync(join(tmpdir(), 'claude-bytes-'));
  const f = join(dir, 's.jsonl');
  writeFileSync(
    f,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-09T00:00:00Z',
      message: {
        id: 'm1',
        model: 'claude-opus-4-8',
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    })}\n`,
  );
  const usage = await estimateSessionLogs('claude', [f]);
  expect(usage).not.toBeNull();
  expect(
    (usage as NonNullable<typeof usage>).tool_result_total_bytes,
  ).toBeUndefined();
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
