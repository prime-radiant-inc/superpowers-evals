import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCorpus, ReplayLoadError } from '../src/campaign/replay.ts';
import type { ReplayManifest } from '../src/contracts/replay.ts';

const BASE = 'a'.repeat(40);
const TREAT = 'b'.repeat(40);

function manifest(
  samples: Array<{
    run_id: string;
    arm: 'baseline' | 'treatment';
    role?: 'scored' | 'retry-load';
  }>,
): ReplayManifest {
  return {
    schema_version: 'quorum.replay-manifest/v1',
    name: 'fixture',
    source_docs: ['docs/experiments/2026-08-08-fresh-release-gate.md'],
    arms: { baseline_sha: BASE, treatment_sha: TREAT },
    comparisons: [
      {
        comparison_id: 'opus_bedrock',
        credential: 'opus_bedrock',
        pool_id: 'bedrock|anthropic|claude-opus-4-8',
        legacy_pool_id: 'bedrock|anthropic',
        cells: [
          {
            scenario: 'sdd-escalates',
            class: 'confirmatory',
            samples: samples.map((s) => ({
              run_id: s.run_id,
              arm: s.arm,
              replicate: 1,
              block_id: 'opus_bedrock/sdd-escalates/1',
              historical_job: 'job-1',
              role: s.role ?? 'scored',
            })),
          },
        ],
      },
    ],
    excluded_run_ids: [{ run_id: 'excluded-run', reason: 'bootstrap-probe' }],
  };
}

function writeRun(
  dir: string,
  rev: string | null,
  opts?: {
    wallMs?: number;
    gauntletMs?: number | null;
    firstStepTs?: string;
    resultMs?: number;
    noCredential?: boolean;
    finalReason?: string;
    error?: string;
  },
) {
  const wallMs = opts?.wallMs ?? 600_000;
  mkdirSync(join(dir, 'gauntlet-agent', 'results', 'g1'), { recursive: true });
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final: 'pass',
      scenario: 'sdd-escalates',
      coding_agent: 'claude',
      ...(opts?.noCredential ? {} : { credential: 'opus_bedrock' }),
      os: 'linux',
      started_at: '2026-08-08T00:00:00.000Z',
      finished_at: new Date(
        Date.parse('2026-08-08T00:00:00.000Z') + wallMs,
      ).toISOString(),
      ...(opts?.finalReason === undefined
        ? {}
        : { final_reason: opts.finalReason }),
      ...(opts?.error === undefined ? {} : { error: opts.error }),
      provenance: rev === null ? {} : { superpowers_rev: rev },
      economics: {
        coding_agent: { duration_ms: 500_000, est_cost_usd: 1.0 },
        gauntlet:
          opts?.gauntletMs === null
            ? {}
            : { duration_ms: opts?.gauntletMs ?? 560_000, est_cost_usd: 0.1 },
        total_est_cost_usd: 1.1,
      },
    }),
  );
  writeFileSync(
    join(dir, 'trajectory.json'),
    JSON.stringify({
      steps: [{ timestamp: opts?.firstStepTs ?? '2026-08-08T00:00:30.000Z' }],
    }),
  );
  writeFileSync(join(dir, 'coding-agent-token-usage.json'), '{}');
  writeFileSync(
    join(dir, 'gauntlet-agent', 'results', 'g1', 'result.json'),
    opts?.resultMs === undefined
      ? '{}'
      : JSON.stringify({ duration_ms: opts.resultMs }),
  );
}

test('loadCorpus builds two-arm blocks and coverage; verifies arm SHAs', () => {
  const corpus = mkdtempSync(join(tmpdir(), 'corpus-'));
  writeRun(join(corpus, 'run-base'), BASE);
  writeRun(join(corpus, 'run-treat'), TREAT);
  mkdirSync(join(corpus, 'excluded-run'), { recursive: true }); // present, excluded
  const loaded = loadCorpus(
    corpus,
    manifest([
      { run_id: 'run-base', arm: 'baseline' },
      { run_id: 'run-treat', arm: 'treatment' },
    ]),
  );
  expect(loaded.blocks).toHaveLength(1);
  expect(loaded.blocks[0]!.samples.map((s) => s.run_id).sort()).toEqual([
    'run-base',
    'run-treat',
  ]);
  expect(loaded.blocks[0]!.samples[0]!.subject_pool).toBe(
    'bedrock|anthropic|claude-opus-4-8',
  );
  const rec = loaded.records.get('run-base')!;
  expect(rec.wall_ms).toBe(600_000);
  expect(rec.coding_ms).toBe(500_000);
  expect(rec.gauntlet_ms).toBe(560_000);
  expect(rec.pre_exposure_ms).toBe(30_000);
  expect(rec.cost_total_usd).toBe(1.1);
  expect(loaded.coverage.excluded_runs_present).toBe(1);
  rmSync(corpus, { recursive: true });
});

test('arm SHA mismatch is a loud error naming the run', () => {
  const corpus = mkdtempSync(join(tmpdir(), 'corpus-'));
  writeRun(join(corpus, 'run-base'), TREAT); // wrong rev
  writeRun(join(corpus, 'run-treat'), TREAT);
  expect(() =>
    loadCorpus(
      corpus,
      manifest([
        { run_id: 'run-base', arm: 'baseline' },
        { run_id: 'run-treat', arm: 'treatment' },
      ]),
    ),
  ).toThrow(ReplayLoadError);
  rmSync(corpus, { recursive: true });
});

test('surplus corpus dir and missing listed run are loud errors', () => {
  const corpus = mkdtempSync(join(tmpdir(), 'corpus-'));
  writeRun(join(corpus, 'surprise-run'), BASE);
  expect(() =>
    loadCorpus(
      corpus,
      manifest([
        { run_id: 'run-base', arm: 'baseline' },
        { run_id: 'run-treat', arm: 'treatment' },
      ]),
    ),
  ).toThrow(/surprise-run|missing/);
  rmSync(corpus, { recursive: true });
});

test('retry-load samples become single-sample blocks; a block missing an arm errors', () => {
  const corpus = mkdtempSync(join(tmpdir(), 'corpus-'));
  writeRun(join(corpus, 'run-base'), BASE);
  writeRun(join(corpus, 'run-retry'), TREAT);
  expect(() =>
    loadCorpus(
      corpus,
      manifest([
        { run_id: 'run-base', arm: 'baseline' },
        { run_id: 'run-retry', arm: 'treatment', role: 'retry-load' },
      ]),
    ),
  ).toThrow(ReplayLoadError); // scored block has only one arm
  const loaded = loadCorpus(
    corpus,
    manifest([
      { run_id: 'run-base', arm: 'baseline', role: 'retry-load' },
      { run_id: 'run-retry', arm: 'treatment', role: 'retry-load' },
    ]),
  );
  expect(loaded.blocks).toHaveLength(2);
  expect(loaded.blocks.every((b) => b.samples.length === 1)).toBe(true);
  for (const b of loaded.blocks) {
    // collision-safe retry block_id; order_key's final component is the block_id
    expect(b.block_id.startsWith('opus_bedrock/sdd-escalates/1/retry-')).toBe(
      true,
    );
    const parts = b.order_key.split('|');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('opus_bedrock');
    expect(parts[1]).toBe('sdd-escalates');
    expect(parts[2]).toBe('0001');
    expect(parts[3]).toBe(b.block_id);
  }
  rmSync(corpus, { recursive: true });
});

test('result.json duration_ms wins over economics.gauntlet when both present', () => {
  const corpus = mkdtempSync(join(tmpdir(), 'corpus-'));
  writeRun(join(corpus, 'run-base'), BASE, { resultMs: 480_000 }); // economics says 560_000
  writeRun(join(corpus, 'run-treat'), TREAT);
  const loaded = loadCorpus(
    corpus,
    manifest([
      { run_id: 'run-base', arm: 'baseline' },
      { run_id: 'run-treat', arm: 'treatment' },
    ]),
  );
  expect(loaded.records.get('run-base')!.gauntlet_ms).toBe(480_000); // result.json wins
  // preserved anomaly: 480_000 < coding 500_000 — recorded, never clamped
  expect(loaded.coverage.gauntlet_lt_coding_anomalies).toContain('run-base');
  rmSync(corpus, { recursive: true });
});

test('loadCorpus reports 429 / rate-limit evidence from final_reason and error fields', () => {
  const corpus = mkdtempSync(join(tmpdir(), 'corpus-'));
  writeRun(join(corpus, 'run-base'), BASE, {
    finalReason: 'halted: upstream API error 429 Too Many Requests',
  });
  writeRun(join(corpus, 'run-treat'), TREAT, {
    error: 'provider Rate limit exceeded during grading',
  });
  // No evidence in either field → never listed.
  writeRun(join(corpus, 'run-clean'), TREAT, {
    finalReason: 'grading budget exceeded',
  });
  const loaded = loadCorpus(
    corpus,
    manifest([
      { run_id: 'run-base', arm: 'baseline' },
      { run_id: 'run-treat', arm: 'treatment' },
      { run_id: 'run-clean', arm: 'treatment', role: 'retry-load' },
    ]),
  );
  expect(loaded.coverage.rate_limit_evidence_runs).toEqual([
    'run-base',
    'run-treat',
  ]);
  rmSync(corpus, { recursive: true });
});

test('missing identity field in verdict.json is a loud error naming the run', () => {
  const corpus = mkdtempSync(join(tmpdir(), 'corpus-'));
  writeRun(join(corpus, 'run-base'), BASE, { noCredential: true });
  writeRun(join(corpus, 'run-treat'), TREAT);
  expect(() =>
    loadCorpus(
      corpus,
      manifest([
        { run_id: 'run-base', arm: 'baseline' },
        { run_id: 'run-treat', arm: 'treatment' },
      ]),
    ),
  ).toThrow(/run-base.*credential/);
  rmSync(corpus, { recursive: true });
});
