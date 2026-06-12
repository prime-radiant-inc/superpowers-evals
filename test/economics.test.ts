import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunEconomics } from '../src/economics.ts';

function frozenUsage(runDir: string): void {
  writeFileSync(
    join(runDir, 'coding-agent-token-usage.json'),
    JSON.stringify({
      total_input: 100,
      total_cache_create: 5,
      total_cache_read: 3,
      total_output: 20,
      total_tokens: 128,
      model: 'claude-opus-4-8',
      models: {
        'claude-opus-4-8': {
          total_input: 100,
          total_cache_create: 5,
          total_cache_read: 3,
          total_output: 20,
          total_tokens: 128,
          provider: 'anthropic',
          est_cost_usd: 0.5,
        },
      },
      est_cost_usd: 0.5,
      unpriced_models: [],
      approximations: [],
      pricing_as_of: '2026-06-09',
      duration_ms: 9000,
    }),
  );
}

test('builds economics from a frozen coding-agent usage file with no gauntlet usage', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  frozenUsage(runDir);
  const econ = await buildRunEconomics(runDir);
  expect(econ).not.toBeNull();
  const e = econ as NonNullable<typeof econ>;
  expect(e.coding_agent?.est_cost_usd).toBe(0.5);
  expect(e.coding_agent?.tokens.total).toBe(128);
  expect(e.gauntlet).toBeNull();
  // gauntlet missing => partial, total uncomputed
  expect(e.partial).toBe(true);
  expect(e.total_est_cost_usd).toBeNull();
});

test('gauntlet result.json with no usage sidecar still yields a gauntlet block (zero tokens)', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const rdir = join(runDir, 'gauntlet-agent', 'results', 'g_0000');
  mkdirSync(rdir, { recursive: true });
  writeFileSync(
    join(rdir, 'result.json'),
    JSON.stringify({
      status: 'pass',
      duration_ms: 1200,
      config: { model: 'claude-opus-4-8' },
    }),
  );
  // usage.jsonl absent -> estimateUsageSidecar returns null without calling obol
  const econ = await buildRunEconomics(runDir);
  const e = econ as NonNullable<typeof econ>;
  expect(e.gauntlet).not.toBeNull();
  expect(e.gauntlet?.tokens.total).toBe(0);
  expect(e.gauntlet?.est_cost_usd).toBeNull();
  expect(e.gauntlet?.model).toBe('claude-opus-4-8');
});

test('returns null when neither source exists', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  expect(await buildRunEconomics(runDir)).toBeNull();
});
