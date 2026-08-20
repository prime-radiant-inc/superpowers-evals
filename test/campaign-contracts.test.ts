// test/campaign-contracts.test.ts
import { expect, test } from 'bun:test';
import { EstimatesArtifactSchema } from '../src/contracts/estimates.ts';
import {
  ReplayManifestSchema,
  ReplayRecordSchema,
} from '../src/contracts/replay.ts';

test('ReplayRecordSchema accepts a fully-populated record', () => {
  const rec = ReplayRecordSchema.parse({
    run_id: 'sdd-escalates-claude-opus_bedrock-linux-20260808T000000Z-ab12',
    scenario: 'sdd-escalates',
    agent: 'claude',
    credential: 'opus_bedrock',
    os: 'linux',
    pool_id: 'https://api.openai.com/v1|openai-responses|gpt-5.6-sol',
    arm: 'baseline',
    wall_ms: 1_440_000,
    coding_ms: 1_200_000,
    gauntlet_ms: 1_500_000,
    pre_exposure_ms: 45_000,
    cost_subject_usd: 1.25,
    cost_grader_usd: 0.15,
    cost_total_usd: 1.4,
  });
  expect(rec.wall_ms).toBe(1_440_000);
});

test('ReplayRecordSchema accepts nulls for nullable fields, rejects bad wall', () => {
  const base = {
    run_id: 'r',
    scenario: 's',
    agent: 'a',
    credential: 'c',
    os: 'linux',
    pool_id: 'p',
    arm: 'single' as const,
    wall_ms: 1,
    coding_ms: null,
    gauntlet_ms: null,
    pre_exposure_ms: null,
    cost_subject_usd: null,
    cost_grader_usd: null,
    cost_total_usd: null,
  };
  expect(ReplayRecordSchema.parse(base).arm).toBe('single');
  expect(() =>
    ReplayRecordSchema.parse({ ...base, wall_ms: Number.NaN }),
  ).toThrow();
  expect(() => ReplayRecordSchema.parse({ ...base, arm: 'middle' })).toThrow();
});

test('ReplayManifestSchema round-trips and pins schema_version', () => {
  const manifest = {
    schema_version: 'quorum.replay-manifest/v1',
    name: 'gate-20260808',
    source_docs: [
      'docs/experiments/2026-08-08-fresh-release-gate.md',
      'docs/experiments/2026-08-09-fresh-release-gate-readout.md',
    ],
    arms: {
      baseline_sha: 'a'.repeat(40),
      treatment_sha: 'b'.repeat(40),
    },
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
            samples: [
              {
                run_id: 'r1',
                arm: 'baseline',
                replicate: 1,
                block_id: 'opus_bedrock/sdd-escalates/1',
                historical_job: 'job-1',
                role: 'scored',
              },
            ],
          },
        ],
      },
    ],
    excluded_run_ids: [{ run_id: 'rx', reason: 'bootstrap-probe' }],
  };
  expect(ReplayManifestSchema.parse(manifest).comparisons).toHaveLength(1);
  expect(() =>
    ReplayManifestSchema.parse({ ...manifest, schema_version: 'v2' }),
  ).toThrow();
  expect(() =>
    ReplayManifestSchema.parse({
      ...manifest,
      arms: { baseline_sha: 'short', treatment_sha: 'b'.repeat(40) },
    }),
  ).toThrow();
});

test('EstimatesArtifactSchema round-trips a minimal artifact', () => {
  const artifact = {
    schema_version: 'quorum.estimates/v1',
    generated_at: '2026-08-09T00:00:00.000Z',
    corpus: { sources: ['corpus/gate-20260808'], run_count: 0, digest: 'x' },
    entries: [],
    fallbacks: {
      scenario_agent: [],
      scenario: [],
      corpus_median: { duration_s: 600, cost_total_usd: null },
    },
  };
  expect(EstimatesArtifactSchema.parse(artifact).schema_version).toBe(
    'quorum.estimates/v1',
  );
});
