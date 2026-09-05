import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSampleEvidence } from '../src/campaign/budgeted-report-evidence.ts';
import { FinalVerdictSchema } from '../src/contracts/verdict.ts';

function runDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(body));
  }
  return dir;
}

// verdict.json per src/contracts/verdict.ts FinalVerdictSchema — complete
// (every schema-required field present: schema, final, final_reason,
// gauntlet layer, checks, error, economics), mirroring the canonical fixture
// test/fixtures/verdict-full.json; the readers consume final/final_reason/
// error.stage + economics.total_est_cost_usd (src/economics.ts RunEconomics).
const verdictPass = {
  schema: 1,
  final: 'pass',
  final_reason: 'Gauntlet-Agent passed; all deterministic checks green',
  gauntlet: {
    status: 'pass',
    summary: 'All acceptance criteria met with evidence',
    reasoning: 'The diff matches the requested change',
    run_id: '20260831T100000Z-gr1',
  },
  checks: [
    {
      check: 'file-contains',
      args: ['src/main.ts', 'export function run()'],
      negated: false,
      passed: true,
      detail: 'pattern found at line 3',
      phase: 'post',
    },
  ],
  error: null,
  economics: {
    coding_agent: { duration_ms: 61000 },
    gauntlet: { duration_ms: 45000 },
    total_est_cost_usd: 1.23,
  },
};

// ATIF trajectory per src/atif/types.ts + validateTrajectory: sequential
// step_id from 1, model_name only on agent steps (AGENT_ONLY rule).
const trajectory = (steps: unknown[]) => ({
  schema_version: 'ATIF-v1.7',
  agent: { name: 'claude', version: '1.0.34' },
  steps,
});

// coding-agent-token-usage.json per src/contracts/economics.ts
// TokenUsageSchema (written by captureTokenUsage, src/capture/index.ts:740).
const tokenUsage = {
  total_input: 40000,
  total_cache_create: 0,
  total_cache_read: 0,
  total_output: 8200,
  total_tokens: 48200,
  model: 'claude-sonnet-4-6',
  models: {
    'claude-haiku-4-5': {
      total_input: 8000,
      total_cache_create: 0,
      total_cache_read: 0,
      total_output: 2000,
      total_tokens: 10000,
      provider: 'anthropic',
      est_cost_usd: 0.09,
    },
    'claude-sonnet-4-6': {
      total_input: 32000,
      total_cache_create: 0,
      total_cache_read: 0,
      total_output: 6200,
      total_tokens: 38200,
      provider: 'anthropic',
      est_cost_usd: 1.11,
    },
  },
  est_cost_usd: 1.2,
  unpriced_models: [],
  approximations: [],
  pricing_as_of: '2026-08-31',
  duration_ms: 61000,
};

// Gauntlet result.json per src/contracts/gauntlet.ts GauntletResultSchema
// (schemaVersion 5); it lives at gauntlet-agent/results/<runId>/result.json.
const gauntletResult = {
  schemaVersion: 5,
  runId: '20260831T100000Z-gr1',
  status: 'pass',
  summary: 'All acceptance criteria met with evidence',
  reasoning: 'The diff matches the requested change',
  duration_ms: 45000,
  config: { model: 'claude-sonnet-4-6' },
  usage: {},
};

describe('readSampleEvidence', () => {
  test('reads outcome, observed models, tokens, cost, grader identity', () => {
    const dir = runDir({
      'verdict.json': verdictPass,
      'trajectory.json': trajectory([
        {
          step_id: 1,
          timestamp: '2026-08-31T10:00:00Z',
          source: 'user',
          message: 'Fix the failing check',
        },
        {
          step_id: 2,
          timestamp: '2026-08-31T10:00:05Z',
          source: 'agent',
          model_name: 'claude-haiku-4-5',
          message: 'Reading the repo',
        },
        {
          step_id: 3,
          timestamp: '2026-08-31T10:01:00Z',
          source: 'agent',
          model_name: 'claude-sonnet-4-6',
          message: 'Patched it',
        },
      ]),
      'coding-agent-token-usage.json': tokenUsage,
      'gauntlet-agent/results/20260831T100000Z-gr1/result.json': gauntletResult,
    });
    const ev = readSampleEvidence({
      runDir: dir,
      sampleId: 'c1:scn:arm_a:r1',
    });
    expect(ev.outcome).toBe('pass');
    expect(ev.observedModels).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
    ]);
    expect(ev.totalTokens).toBe(48200);
    expect(ev.costUsd).toBeCloseTo(1.23);
    // The fixture must remain an actually emitted-verdict shape, not a
    // reader-satisfying subset.
    expect(FinalVerdictSchema.safeParse(verdictPass).success).toBe(true);
  });

  test('absent run dir is all-null evidence, not a throw', () => {
    const ev = readSampleEvidence({ runDir: '/nonexistent/x', sampleId: 's' });
    expect(ev.outcome).toBeNull();
    expect(ev.observedModels).toEqual([]);
    expect(ev.totalTokens).toBeNull();
    expect(ev.costUsd).toBeNull();
    expect(ev.graderModel).toBeNull();
  });

  test('a malformed trajectory fails closed per field, not per sample', () => {
    const dir = runDir({
      'verdict.json': verdictPass,
      'trajectory.json': { not: 'a trajectory' },
      'coding-agent-token-usage.json': tokenUsage,
      'gauntlet-agent/results/20260831T100000Z-gr1/result.json': gauntletResult,
    });
    const ev = readSampleEvidence({ runDir: dir, sampleId: 's' });
    expect(ev.outcome).toBe('pass'); // verdict still reads
    expect(ev.observedModels).toEqual([]); // trajectory field fails closed
    expect(ev.totalTokens).toBe(48200);
    expect(ev.costUsd).toBeCloseTo(1.23);
    expect(ev.graderModel).toBe('claude-sonnet-4-6');
  });

  test('observed model set is ordered and deduplicated', () => {
    const dir = runDir({
      'trajectory.json': trajectory([
        { step_id: 1, source: 'user', message: 'go' },
        {
          step_id: 2,
          source: 'agent',
          model_name: 'claude-sonnet-4-6',
          message: 'first',
        },
        {
          step_id: 3,
          source: 'agent',
          model_name: 'claude-haiku-4-5',
          message: 'second',
        },
        {
          step_id: 4,
          source: 'agent',
          model_name: 'claude-sonnet-4-6',
          message: 'third',
        },
      ]),
    });
    const ev = readSampleEvidence({ runDir: dir, sampleId: 's' });
    expect(ev.observedModels).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
    ]);
  });

  test('malformed token-usage and gauntlet artifacts fail closed per field', () => {
    const dir = runDir({
      'verdict.json': verdictPass,
      'trajectory.json': trajectory([
        {
          step_id: 1,
          source: 'agent',
          model_name: 'claude-sonnet-4-6',
          message: 'did the work',
        },
      ]),
      'coding-agent-token-usage.json': { nonsense: true }, // schema-invalid
      'gauntlet-agent/results/20260831T100000Z-gr1/result.json': {
        schemaVersion: 5, // missing required status — schema-invalid
      },
    });
    const ev = readSampleEvidence({ runDir: dir, sampleId: 's' });
    expect(ev.outcome).toBe('pass');
    expect(ev.observedModels).toEqual(['claude-sonnet-4-6']);
    expect(ev.totalTokens).toBeNull();
    expect(ev.costUsd).toBe(1.23);
    expect(ev.graderModel).toBeNull();
  });

  test('the newest schema-valid grader result decides the field, not a stale older one', () => {
    const dir = runDir({
      // Newest run-id walks first (gauntletResultDirs sorts descending); its
      // result is schema-valid but legitimately omits optional config.model.
      'gauntlet-agent/results/20260831T120000Z-newer/result.json': {
        schemaVersion: 5,
        runId: '20260831T120000Z-newer',
        status: 'pass',
        summary: 'Current run, model not recorded',
        reasoning: 'Graded without a model stamp',
      },
      'gauntlet-agent/results/20260831T090000Z-older/result.json': {
        schemaVersion: 5,
        runId: '20260831T090000Z-older',
        status: 'pass',
        summary: 'Older run that did stamp a model',
        reasoning: 'Superseded',
        config: { model: 'claude-sonnet-4-6' },
      },
    });
    const ev = readSampleEvidence({ runDir: dir, sampleId: 's' });
    // The older directory's model is not evidence about the current result.
    expect(ev.graderModel).toBeNull();
  });
});
