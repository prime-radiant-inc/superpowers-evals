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

test('EstimatesArtifactSchema exercises full entries + fallback tiers', () => {
  const stats = {
    duration_s_median: 921.5,
    duration_n: 12,
    cost_subject_usd_median: 1.25,
    cost_grader_usd_median: 0.11,
    cost_total_usd_median: 1.36,
    priced_n: 9,
    spread_s: { p25: 720, p75: 1105 },
    confidence: 'high',
  };
  const artifact = {
    schema_version: 'quorum.estimates/v1',
    generated_at: '2026-08-09T00:00:00.000Z',
    corpus: { sources: ['corpus/gate-20260808'], run_count: 12, digest: 'x' },
    entries: [
      {
        scenario: 'sdd-escalates',
        agent: 'claude',
        credential: 'opus_bedrock',
        os: 'linux',
        // cost_grader_usd_median is the null-cost field for this entry.
        ...stats,
        cost_grader_usd_median: null,
      },
    ],
    fallbacks: {
      scenario_agent: [
        { scenario: 'sdd-escalates', agent: 'claude', ...stats, priced_n: 0 },
      ],
      scenario: [{ scenario: 'sdd-escalates', ...stats }],
      corpus_median: { duration_s: 600, cost_total_usd: null },
    },
  };
  const parsed = EstimatesArtifactSchema.parse(artifact);
  const entry = parsed.entries[0]!;
  const scenarioAgent = parsed.fallbacks.scenario_agent[0]!;
  const scenarioStats = parsed.fallbacks.scenario[0]!;
  expect(parsed.entries).toHaveLength(1);
  expect(entry.scenario).toBe('sdd-escalates');
  expect(entry.agent).toBe('claude');
  expect(entry.credential).toBe('opus_bedrock');
  expect(entry.os).toBe('linux');
  expect(entry.duration_s_median).toBe(921.5);
  expect(entry.duration_n).toBe(12);
  expect(entry.priced_n).toBe(9);
  expect(entry.spread_s.p25).toBe(720);
  expect(entry.spread_s.p75).toBe(1105);
  expect(entry.confidence).toBe('high');
  expect(entry.cost_subject_usd_median).toBe(1.25);
  expect(entry.cost_total_usd_median).toBe(1.36);
  // Nullable cost fields must survive a round-trip as null.
  expect(entry.cost_grader_usd_median).toBeNull();
  expect(parsed.fallbacks.corpus_median.cost_total_usd).toBeNull();
  expect(parsed.fallbacks.scenario_agent).toHaveLength(1);
  expect(scenarioAgent.agent).toBe('claude');
  expect(parsed.fallbacks.scenario).toHaveLength(1);
  expect(scenarioStats.scenario).toBe('sdd-escalates');
  expect(scenarioStats.confidence).toBe('high');
  // An unknown confidence tier must be rejected.
  expect(() =>
    EstimatesArtifactSchema.parse({
      ...artifact,
      entries: [{ ...artifact.entries[0], confidence: 'very-high' }],
    }),
  ).toThrow();
});
