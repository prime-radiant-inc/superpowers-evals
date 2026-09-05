import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimatePath } from '@primeradianthq/obol';
import { estimateTrajectory, estimateUsageSidecar } from '../../../src/obol/index.ts';

// Exercise the same native library and capture functions as a real run. The
// caller selects pricing through the process environment or its default home;
// this probe must not override that selection and accidentally hide bad staging.
const dir = mkdtempSync(join(tmpdir(), 'pr2258-pricing-'));
const checks: { model: string; kind: string; usd: number | null }[] = [];
const rates = [
  { model: 'gpt-6-astra', input: 10, cached: 1, output: 50 },
  { model: 'gpt-5.6-sol', input: 4, cached: 0.4, output: 20 },
  { model: 'gpt-5.6-terra', input: 2, cached: 0.2, output: 12 },
  { model: 'gpt-5.6-luna', input: 0.2, cached: 0.02, output: 1.2 },
];

try {
  for (const rate of rates) {
    for (const fresh of [1000, 271000, 271001]) {
      const file = join(dir, 'trajectory.json');
      writeFileSync(file, JSON.stringify({
        schema_version: 'ATIF-v1.7',
        agent: { name: 'codex', version: 'probe', model_name: rate.model },
        steps: [{
          step_id: 1, source: 'agent', model_name: rate.model,
          metrics: { prompt_tokens: fresh, cached_tokens: 1000, completion_tokens: 1000 },
        }],
      }));
      const above = fresh + 1000 > 272000;
      const expected = (fresh * rate.input * (above ? 2 : 1)
        + 1000 * rate.cached * (above ? 2 : 1)
        + 1000 * rate.output * (above ? 1.5 : 1)) / 1e6;
      const usage = await estimateTrajectory(file);
      assert(usage, `${rate.model}: missing capture`);
      assert.deepEqual(usage.unpriced_models, [], `${rate.model}: unpriced`);
      assert(usage.est_cost_usd !== null);
      assert(Math.abs(usage.est_cost_usd - expected) < 1e-9,
        `${rate.model}, ${fresh + 1000} input: expected ${expected}, got ${usage.est_cost_usd}`);
      assert.equal(usage.total_input, fresh);
      assert.equal(usage.total_cache_read, 1000);
      assert.equal(usage.pricing_as_of, '2026-09-04');
      const native = await estimatePath(file, 'atif');
      assert('pricing_source' in native);
      assert.equal(native.pricing_source, 'local');
      checks.push({ model: rate.model, kind: `input-${fresh + 1000}`, usd: usage.est_cost_usd });
    }
  }
  for (const model of ['claude-sonnet-5', 'anthropic.claude-sonnet-5']) {
    const file = join(dir, 'usage.jsonl');
    writeFileSync(file, `${JSON.stringify({
      type: 'obol.usage', v: '2026-06-08', provider: 'anthropic', model,
      service_tier: 'standard',
      usage: { input_tokens: 1000, output_tokens: 1000,
        cache_read_input_tokens: 1000, cache_creation_input_tokens: 2000,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 } },
    })}\n`);
    const usage = await estimateUsageSidecar(file);
    assert(usage);
    assert.deepEqual(usage.unpriced_models, []);
    assert.equal(usage.est_cost_usd, 0.0187);
    assert.equal(usage.total_cache_create, 2000);
    assert.equal(usage.pricing_as_of, '2026-09-04');
    checks.push({ model, kind: 'grader-five-buckets', usd: usage.est_cost_usd });
  }
  const unknown = join(dir, 'unknown.json');
  writeFileSync(unknown, JSON.stringify({
    schema_version: 'ATIF-v1.7', agent: { name: 'codex', version: 'probe', model_name: 'unknown-probe' },
    steps: [{ step_id: 1, source: 'agent', metrics: { prompt_tokens: 1000, completion_tokens: 1000 } }],
  }));
  const missing = await estimateTrajectory(unknown);
  assert(missing);
  assert.equal(missing.est_cost_usd, null);
  assert.deepEqual(missing.unpriced_models, ['unknown-probe']);
  checks.push({ model: 'unknown-probe', kind: 'unpriced-is-null', usd: null });
  console.log(JSON.stringify({
    ok: true, checked_at: new Date().toISOString(), checks,
    fixture_sha256: createHash('sha256').update(readFileSync(new URL('./current.json', import.meta.url))).digest('hex'),
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
