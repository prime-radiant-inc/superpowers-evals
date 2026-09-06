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

const directory = mkdtempSync(join(tmpdir(), 'pr2258-parallel-pricing-'));
const checks: { model: string; kind: string; usd: number | null }[] = [];
const openaiRates = [
  {
    model: 'gpt-6-astra',
    short: { input: 10, cacheRead: 1, output: 50 },
    long: { input: 20, cacheRead: 2, output: 75 },
  },
  {
    model: 'gpt-5.6-sol',
    short: { input: 4, cacheRead: 0.4, output: 20 },
    long: { input: 8, cacheRead: 0.8, output: 30 },
  },
] as const;

try {
  for (const model of openaiRates) {
    for (const totalInput of [272_000, 272_001]) {
      const cached = 1_000;
      const fresh = totalInput - cached;
      const rate = totalInput > 272_000 ? model.long : model.short;
      const path = join(directory, 'trajectory.json');
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: 'ATIF-v1.7',
          agent: { name: 'codex', version: 'probe', model_name: model.model },
          steps: [
            {
              step_id: 1,
              source: 'agent',
              model_name: model.model,
              metrics: {
                prompt_tokens: fresh,
                cached_tokens: cached,
                completion_tokens: 1_000,
              },
            },
          ],
        }),
      );
      const expected =
        (fresh * rate.input +
          cached * rate.cacheRead +
          1_000 * rate.output) /
        1e6;
      const usage = await estimateTrajectory(path);
      assert(usage);
      assert.deepEqual(usage.unpriced_models, []);
      assert(usage.est_cost_usd !== null);
      assert(Math.abs(usage.est_cost_usd - expected) < 1e-9);
      assert.equal(usage.pricing_as_of, '2026-09-05');
      const native = await estimatePath(path, 'atif');
      assert('pricing_source' in native);
      assert.equal(native.pricing_source, 'local');
      checks.push({
        model: model.model,
        kind: `input-${totalInput}`,
        usd: usage.est_cost_usd,
      });
    }
  }

  for (const model of [
    'anthropic.claude-opus-5',
    'anthropic.claude-sonnet-5',
  ]) {
    const path = join(directory, 'usage.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'obol.usage',
        v: '2026-06-08',
        provider: 'anthropic',
        model,
        service_tier: 'standard',
        usage: {
          input_tokens: 1_000,
          output_tokens: 1_000,
          cache_read_input_tokens: 1_000,
          cache_creation_input_tokens: 2_000,
          cache_creation: {
            ephemeral_5m_input_tokens: 1_000,
            ephemeral_1h_input_tokens: 1_000,
          },
        },
      })}\n`,
    );
    const usage = await estimateUsageSidecar(path);
    assert(usage);
    assert.deepEqual(usage.unpriced_models, []);
    assert(usage.est_cost_usd !== null);
    const expected =
      model === 'anthropic.claude-opus-5' ? 0.051425 : 0.02057;
    assert(Math.abs(usage.est_cost_usd - expected) < 1e-9);
    assert.equal(usage.total_cache_create, 2_000);
    assert.equal(usage.pricing_as_of, '2026-09-05');
    checks.push({ model, kind: 'five-bucket-sidecar', usd: usage.est_cost_usd });
  }

  const servedOpus = join(directory, 'served-opus.json');
  writeFileSync(
    servedOpus,
    JSON.stringify({
      schema_version: 'ATIF-v1.7',
      agent: { name: 'claude', version: '2.1.209', model_name: 'claude-opus-5' },
      steps: [{
        step_id: 1,
        source: 'agent',
        model_name: 'claude-opus-5',
        metrics: { prompt_tokens: 1_000, completion_tokens: 1_000, cached_tokens: 1_000 },
        extra: { cache_write: 1_000 },
      }],
    }),
  );
  const servedUsage = await estimateTrajectory(servedOpus);
  assert(servedUsage);
  assert.deepEqual(servedUsage.unpriced_models, []);
  assert(servedUsage.est_cost_usd !== null);
  assert(Math.abs(servedUsage.est_cost_usd - 0.040425) < 1e-9);
  checks.push({ model: 'claude-opus-5', kind: 'mantle-served-id-trajectory', usd: servedUsage.est_cost_usd });

  const unknown = join(directory, 'unknown.json');
  writeFileSync(
    unknown,
    JSON.stringify({
      schema_version: 'ATIF-v1.7',
      agent: { name: 'codex', version: 'probe', model_name: 'unknown-probe' },
      steps: [
        {
          step_id: 1,
          source: 'agent',
          metrics: { prompt_tokens: 1_000, completion_tokens: 1_000 },
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
  rmSync(directory, { recursive: true, force: true });
}
