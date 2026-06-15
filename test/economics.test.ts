import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AtifTrajectory } from '../src/atif/types.ts';
import { captureTokenUsage } from '../src/capture/index.ts';
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

// K-legacy-frozen-file-crash: a legacy pre-obol frozen coding-agent usage file
// lacks unpriced_models/approximations/pricing_as_of. Python builds a coding
// block with obol=null, partial=true, no crash. TS must degrade, not throw.
test('legacy frozen coding-agent file (no obol keys) renders without crashing', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
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
          est_cost_usd: null,
        },
      },
      est_cost_usd: null,
      // legacy: no unpriced_models, approximations, pricing_as_of
    }),
  );
  const econ = await buildRunEconomics(runDir);
  expect(econ).not.toBeNull();
  const e = econ as NonNullable<typeof econ>;
  expect(e.coding_agent).not.toBeNull();
  expect(e.coding_agent?.obol).toBeNull();
  expect(e.coding_agent?.tokens.total).toBe(128);
  // est_cost_usd is null in a pre-obol file => has_unpriced_model from models
  expect(e.coding_agent?.has_unpriced_model).toBe(true);
  expect(e.partial).toBe(true);
});

// K-result-field-drift-rejected: field-type drift in result.json (e.g. a
// config that is an array) must degrade per-field, keeping a valid duration_ms.
test('wrong-typed result.json config degrades per-field, keeps duration_ms', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const rdir = join(runDir, 'gauntlet-agent', 'results', 'g_0000');
  mkdirSync(rdir, { recursive: true });
  writeFileSync(
    join(rdir, 'result.json'),
    JSON.stringify({
      status: 'pass',
      duration_ms: 1000,
      config: ['not', 'a', 'dict'],
    }),
  );
  const econ = await buildRunEconomics(runDir);
  const e = econ as NonNullable<typeof econ>;
  expect(e.gauntlet).not.toBeNull();
  expect(e.gauntlet?.duration_ms).toBe(1000);
  expect(e.gauntlet?.model).toBeNull();
});

// K-gauntlet-usage-only-dir: a results dir carrying only usage.jsonl (no
// result.json) must still be selected and priced via the sidecar.
test('results dir with only usage.jsonl is selected and priced', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const rdir = join(runDir, 'gauntlet-agent', 'results', 'g_0000');
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, 'usage.jsonl'), '{}\n');
  const sidecarPaths: string[] = [];
  const fakeSidecar = async (p: string) => {
    sidecarPaths.push(p);
    return {
      total_input: 10,
      total_cache_create: 0,
      total_cache_read: 0,
      total_output: 5,
      total_tokens: 15,
      model: 'gauntlet-model',
      models: {},
      est_cost_usd: 0.01,
      unpriced_models: [],
      approximations: [],
      pricing_as_of: '2026-06-09',
    };
  };
  const econ = await buildRunEconomics(runDir, fakeSidecar);
  const e = econ as NonNullable<typeof econ>;
  expect(sidecarPaths.length).toBe(1);
  expect(sidecarPaths[0]).toContain('usage.jsonl');
  expect(e.gauntlet).not.toBeNull();
  expect(e.gauntlet?.est_cost_usd).toBe(0.01);
  expect(e.gauntlet?.tokens.total).toBe(15);
});

// K-obol-provenance-present-null: when pricing_as_of is present-but-null, Python
// keeps the provenance block (per_model/unpriced_models/approximations). TS must
// not conflate present-but-null with absent.
test('obol provenance retained when pricing_as_of is present-but-null', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  writeFileSync(
    join(runDir, 'coding-agent-token-usage.json'),
    JSON.stringify({
      total_input: 100,
      total_cache_create: 5,
      total_cache_read: 3,
      total_output: 20,
      total_tokens: 128,
      model: 'some-model',
      models: {
        'some-model': {
          total_input: 100,
          total_cache_create: 5,
          total_cache_read: 3,
          total_output: 20,
          total_tokens: 128,
          provider: 'somewhere',
          est_cost_usd: null,
        },
      },
      est_cost_usd: null,
      unpriced_models: ['some-model'],
      approximations: [{ kind: 'guessed', detail: 'no price' }],
      pricing_as_of: null,
    }),
  );
  const econ = await buildRunEconomics(runDir);
  const e = econ as NonNullable<typeof econ>;
  expect(e.coding_agent?.obol).not.toBeNull();
  expect(e.coding_agent?.obol?.pricing_as_of).toBeNull();
  expect(e.coding_agent?.obol?.unpriced_models).toEqual(['some-model']);
  expect(e.coding_agent?.obol?.approximations).toEqual([
    { kind: 'guessed', detail: 'no price' },
  ]);
});

// K-permodel-sort-none-tiebreak: a $0 free-tier model and an unpriced (null)
// model must tie (null maps to 0), preserving input order between them rather
// than sorting the unpriced one strictly below the $0 one.
test('per-model sort treats null cost as 0, tieing with a $0 model', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  writeFileSync(
    join(runDir, 'coding-agent-token-usage.json'),
    JSON.stringify({
      total_input: 0,
      total_cache_create: 0,
      total_cache_read: 0,
      total_output: 0,
      total_tokens: 0,
      model: 'unpriced-model',
      // insertion order: unpriced (null) first, then a genuine $0 free-tier
      models: {
        'unpriced-model': {
          total_input: 0,
          total_cache_create: 0,
          total_cache_read: 0,
          total_output: 0,
          total_tokens: 0,
          provider: 'x',
          est_cost_usd: null,
        },
        'free-tier': {
          total_input: 0,
          total_cache_create: 0,
          total_cache_read: 0,
          total_output: 0,
          total_tokens: 0,
          provider: 'y',
          est_cost_usd: 0,
        },
      },
      est_cost_usd: null,
      unpriced_models: ['unpriced-model'],
      approximations: [],
      pricing_as_of: '2026-06-09',
    }),
  );
  const econ = await buildRunEconomics(runDir);
  const e = econ as NonNullable<typeof econ>;
  // Python: None->0 ties stably with the $0 model, preserving insertion order
  // => [unpriced-model, free-tier]. TS None->-1 would flip them.
  expect(e.coding_agent?.models.map((m) => m.model)).toEqual([
    'unpriced-model',
    'free-tier',
  ]);
});

// ── trajectory-sourced coding-agent economics ────────────────────────────────
// The new data flow: capture writes trajectory.json (normalizers fill metrics),
// captureTokenUsage prices it via obol's "atif" dialect into the frozen
// coding-agent-token-usage.json, and buildRunEconomics reads that frozen file.
// These exercise the REAL obol atif pricing, end to end.

function writeTrajectory(runDir: string, traj: AtifTrajectory): void {
  writeFileSync(
    join(runDir, 'trajectory.json'),
    `${JSON.stringify(traj, null, 2)}\n`,
  );
}

// captureTokenUsage requires CaptureArgs; only runDir/normalizer matter once the
// trajectory is the token source (no raw logs exist in these fixtures, so
// duration_ms resolves to null and kimi-bytes to 0 — both honest absences).
function priceTrajectory(runDir: string, normalizer: string): Promise<unknown> {
  return captureTokenUsage({
    logDir: join(runDir, 'no-such-log-dir'),
    logGlob: '*.jsonl',
    snapshot: new Set<string>(),
    normalizer,
    runDir,
    launchCwd: runDir,
  });
}

test('coding-agent economics priced from a trajectory with disjoint metric buckets', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-traj-'));
  writeTrajectory(runDir, {
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
  await priceTrajectory(runDir, 'claude');
  const econ = await buildRunEconomics(runDir);
  const e = econ as NonNullable<typeof econ>;
  expect(e.coding_agent).not.toBeNull();
  // disjoint buckets carried straight through to the economics shell.
  expect(e.coding_agent?.tokens.input).toBe(100);
  expect(e.coding_agent?.tokens.output).toBe(20);
  expect(e.coding_agent?.tokens.cache_read).toBe(3);
  expect(e.coding_agent?.tokens.total).toBe(123);
  expect(e.coding_agent?.model).toBe('claude-opus-4-8');
  // obol has a rate for this model -> priced.
  expect(e.coding_agent?.est_cost_usd).not.toBeNull();
  expect((e.coding_agent?.est_cost_usd as number) > 0).toBe(true);
  expect(e.coding_agent?.has_unpriced_model).toBe(false);
});

test('coding-agent economics honors an embedded cost_usd from the trajectory', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-traj-cost-'));
  writeTrajectory(runDir, {
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
  await priceTrajectory(runDir, 'opencode');
  const econ = await buildRunEconomics(runDir);
  const e = econ as NonNullable<typeof econ>;
  // The transcript carried the cost — obol uses it verbatim, no re-pricing.
  expect(e.coding_agent?.est_cost_usd).toBe(0.42);
  expect(e.coding_agent?.tokens.total).toBe(123);
});

test('coding-agent economics is null for a no-usage (antigravity) trajectory', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-traj-antigravity-'));
  writeTrajectory(runDir, {
    schema_version: 'ATIF-v1.7',
    agent: { name: 'antigravity', version: 'unknown' },
    steps: [{ step_id: 1, source: 'agent' }],
  });
  const path = await priceTrajectory(runDir, 'antigravity');
  // No usage -> no frozen file written -> no coding_agent block.
  expect(path).toBeNull();
  expect(existsSync(join(runDir, 'coding-agent-token-usage.json'))).toBe(false);
  expect(await buildRunEconomics(runDir)).toBeNull();
});

test('coding-agent economics marks an unknown model unpriced (tokens kept, cost null)', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-traj-unpriced-'));
  writeTrajectory(runDir, {
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
  await priceTrajectory(runDir, 'gemini');
  const econ = await buildRunEconomics(runDir);
  const e = econ as NonNullable<typeof econ>;
  expect(e.coding_agent?.tokens.total).toBe(60);
  expect(e.coding_agent?.est_cost_usd).toBeNull();
  expect(e.coding_agent?.has_unpriced_model).toBe(true);
});
