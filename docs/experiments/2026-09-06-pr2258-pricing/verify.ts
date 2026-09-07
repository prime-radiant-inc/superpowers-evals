import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimatePath } from '@primeradianthq/obol';
import {
  estimateTrajectory,
  estimateUsageSidecar,
} from '../../../src/obol/index.ts';

// Exercise the same native library and capture functions as a real run. The
// caller selects pricing through the process environment or its default home;
// this probe must not override that selection and accidentally hide bad staging.
const AS_OF = '2026-09-06';
const dir = mkdtempSync(join(tmpdir(), 'pr2258-pricing-'));
const checks: { model: string; kind: string; usd: number | null }[] = [];
const openai = [
  { model: 'gpt-6-astra', input: 10, cached: 1, output: 50 },
  { model: 'gpt-5.6-sol', input: 4, cached: 0.4, output: 20 },
  { model: 'gpt-5.6-terra', input: 2, cached: 0.2, output: 12 },
  { model: 'gpt-5.6-luna', input: 0.2, cached: 0.02, output: 1.2 },
];
const anthropic = [
  { model: 'claude-opus-5', input: 5, cached: 0.5, output: 25 },
  { model: 'anthropic.claude-opus-5', input: 5, cached: 0.5, output: 25 },
  { model: 'claude-opus-4-8', input: 5, cached: 0.5, output: 25 },
  { model: 'anthropic.claude-opus-4-8', input: 5, cached: 0.5, output: 25 },
  { model: 'claude-haiku-4-5', input: 1, cached: 0.1, output: 5 },
  { model: 'claude-haiku-4-5-20251001', input: 1, cached: 0.1, output: 5 },
  { model: 'anthropic.claude-haiku-4-5', input: 1, cached: 0.1, output: 5 },
  {
    model: 'anthropic.claude-haiku-4-5-20251001',
    input: 1,
    cached: 0.1,
    output: 5,
  },
];

function trajectory(model: string, agent: string, fresh: number): string {
  const file = join(dir, 'trajectory.json');
  writeFileSync(
    file,
    JSON.stringify({
      schema_version: 'ATIF-v1.7',
      agent: { name: agent, version: 'probe', model_name: model },
      steps: [
        {
          step_id: 1,
          source: 'agent',
          model_name: model,
          metrics: {
            prompt_tokens: fresh,
            cached_tokens: 1000,
            completion_tokens: 1000,
          },
        },
      ],
    }),
  );
  return file;
}

try {
  for (const rate of openai) {
    for (const fresh of [1000, 271000, 271001]) {
      const file = trajectory(rate.model, 'codex', fresh);
      const above = fresh + 1000 > 272000;
      const expected =
        (fresh * rate.input * (above ? 2 : 1) +
          1000 * rate.cached * (above ? 2 : 1) +
          1000 * rate.output * (above ? 1.5 : 1)) /
        1e6;
      const usage = await estimateTrajectory(file);
      assert(usage, `${rate.model}: missing capture`);
      assert.deepEqual(usage.unpriced_models, [], `${rate.model}: unpriced`);
      assert(usage.est_cost_usd !== null);
      assert(
        Math.abs(usage.est_cost_usd - expected) < 1e-9,
        `${rate.model}, ${fresh + 1000} input: expected ${expected}, got ${usage.est_cost_usd}`,
      );
      assert.equal(usage.pricing_as_of, AS_OF);
      const native = await estimatePath(file, 'atif');
      assert('pricing_source' in native);
      assert.equal(native.pricing_source, 'local');
      checks.push({
        model: rate.model,
        kind: `input-${fresh + 1000}`,
        usd: usage.est_cost_usd,
      });
    }
  }
  for (const rate of anthropic) {
    const file = trajectory(rate.model, 'claude', 1000);
    const expected =
      (1000 * rate.input + 1000 * rate.cached + 1000 * rate.output) / 1e6;
    const usage = await estimateTrajectory(file);
    assert(usage, `${rate.model}: missing capture`);
    assert.deepEqual(usage.unpriced_models, [], `${rate.model}: unpriced`);
    assert(usage.est_cost_usd !== null);
    assert(
      Math.abs(usage.est_cost_usd - expected) < 1e-9,
      `${rate.model}: expected ${expected}, got ${usage.est_cost_usd}`,
    );
    assert.equal(usage.pricing_as_of, AS_OF);
    checks.push({ model: rate.model, kind: 'input-2000', usd: usage.est_cost_usd });
  }
  for (const model of ['claude-sonnet-5', 'anthropic.claude-sonnet-5']) {
    const file = join(dir, 'usage.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({
        type: 'obol.usage',
        v: '2026-06-08',
        provider: 'anthropic',
        model,
        service_tier: 'standard',
        usage: {
          input_tokens: 1000,
          output_tokens: 1000,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 2000,
          cache_creation: {
            ephemeral_5m_input_tokens: 1000,
            ephemeral_1h_input_tokens: 1000,
          },
        },
      })}\n`,
    );
    const usage = await estimateUsageSidecar(file);
    assert(usage);
    assert.deepEqual(usage.unpriced_models, []);
    // 1000 in ($2) + 1000 out ($10) + 1000 cache read ($0.2) + 1000 5m write
    // ($2.5) + 1000 1h write ($4), per MTok → $0.0187.
    assert.equal(usage.est_cost_usd, 0.0187);
    assert.equal(usage.total_cache_create, 2000);
    assert.equal(usage.pricing_as_of, AS_OF);
    checks.push({ model, kind: 'grader-five-buckets', usd: usage.est_cost_usd });
  }
  const unknown = join(dir, 'unknown.json');
  writeFileSync(
    unknown,
    JSON.stringify({
      schema_version: 'ATIF-v1.7',
      agent: { name: 'codex', version: 'probe', model_name: 'unknown-probe' },
      steps: [
        {
          step_id: 1,
          source: 'agent',
          metrics: { prompt_tokens: 1000, completion_tokens: 1000 },
        },
      ],
    }),
  );
  const missing = await estimateTrajectory(unknown);
  assert(missing);
  assert.equal(missing.est_cost_usd, null);
  assert.deepEqual(missing.unpriced_models, ['unknown-probe']);
  checks.push({ model: 'unknown-probe', kind: 'unpriced-is-null', usd: null });
  console.log(
    JSON.stringify(
      {
        ok: true,
        checked_at: new Date().toISOString(),
        checks,
        fixture_sha256: createHash('sha256')
          .update(readFileSync(new URL('./current.json', import.meta.url)))
          .digest('hex'),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
