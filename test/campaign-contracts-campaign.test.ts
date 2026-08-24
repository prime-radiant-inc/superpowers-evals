// test/campaign-contracts-campaign.test.ts
import { expect, test } from 'bun:test';
import { CampaignSchema } from '../src/contracts/campaign/campaign.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

export function goldenCampaign(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    campaign_id: 'cmp-golden-0001',
    suite: {
      schema_version: 1,
      name: 'golden_suite',
      kind: 'gating',
      budget_usd: 100,
      profile: 'release_gate_v1',
      reserve: 1,
      max_exposure_skew: 600,
      comparisons: [
        {
          baseline: 'base_arm',
          treatment: 'treat_arm',
          scenarios: ['scn_a'],
          n: 1,
        },
      ],
    },
    refs: {
      superpowers_by_arm: { base_arm: SHA_A, treat_arm: SHA_A },
      evals: SHA_B,
      gauntlet: SHA_C,
    },
    grader: { credential: 'grader_fx', model: 'claude-opus-5' },
    cells: [
      {
        scenario: 'scn_a',
        comparison_id: 'c1',
        arms: ['baseline', 'treatment'],
        n: 1,
        class: 'confirmatory',
        coupling: 'arm-independent',
        estimates_by_arm: {
          baseline: { duration_s: 600, cost_usd: 1.5, confidence: 'high' },
          treatment: { duration_s: 610, cost_usd: 1.6, confidence: 'high' },
        },
      },
    ],
    excluded_cells: [],
    samples: [
      { sample_id: 's1', cell: 'scn_a@c1', arm: 'baseline', replicate: 1 },
      { sample_id: 's2', cell: 'scn_a@c1', arm: 'treatment', replicate: 1 },
    ],
    comparisons: [
      { comparison_id: 'c1', baseline: 'base_arm', treatment: 'treat_arm' },
    ],
    blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 's2'] }],
    budget: { usd_all_in: 100, surcharge_applied: 5, priced_coverage: 0.95 },
    registered_at: '2026-08-24T00:00:00Z',
    registered_by: 'drew',
    digest: '0'.repeat(64),
    ...overrides,
  };
}

test('a two-arm campaign round-trips', () => {
  expect(CampaignSchema.parse(goldenCampaign())).toMatchObject({
    campaign_id: 'cmp-golden-0001',
  });
});

test('a single-arm campaign parses (one-sample blocks)', () => {
  const single = goldenCampaign({
    comparisons: [{ comparison_id: 'c1', arm: 'base_arm' }],
    cells: [{ ...goldenCampaign().cells[0], arms: ['baseline'] }],
    samples: [
      { sample_id: 's1', cell: 'scn_a@c1', arm: 'baseline', replicate: 1 },
    ],
    blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1'] }],
  });
  expect(CampaignSchema.parse(single).blocks[0]).toMatchObject({
    sample_ids: ['s1'],
  });
});

test('every sample belongs to exactly one block', () => {
  const dup = goldenCampaign({
    blocks: [
      { block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 's2'] },
      { block_id: 'b2', comparison_id: 'c1', sample_ids: ['s2'] },
    ],
  });
  expect(() => CampaignSchema.parse(dup)).toThrow(/exactly one block/);
  const orphan = goldenCampaign({
    blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1'] }],
  });
  expect(() => CampaignSchema.parse(orphan)).toThrow(/exactly one block/);
});

test('block sample_ids must reference existing samples', () => {
  const ghost = goldenCampaign({
    blocks: [
      { block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 'ghost'] },
    ],
  });
  expect(() => CampaignSchema.parse(ghost)).toThrow();
});

test('two-arm blocks hold two samples; single-arm blocks hold one', () => {
  const wrong = goldenCampaign({
    blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1'] }],
  });
  expect(() => CampaignSchema.parse(wrong)).toThrow(/arm count/);
});

test('pricing_overrides carry the operator escape with rationale', () => {
  const priced = goldenCampaign({
    pricing_overrides: [
      {
        arm: 'base_arm',
        per_token_usd: 0.000003,
        rationale: 'obol-unpriced model',
      },
    ],
  });
  expect(CampaignSchema.parse(priced).pricing_overrides?.[0]).toMatchObject({
    arm: 'base_arm',
  });
});

test('refs resolve to full SHAs; grader stays singular', () => {
  expect(() =>
    CampaignSchema.parse(
      goldenCampaign({
        refs: { superpowers_by_arm: {}, evals: 'short', gauntlet: SHA_C },
      }),
    ),
  ).toThrow();
  expect(CampaignSchema.parse(goldenCampaign()).grader).toEqual({
    credential: 'grader_fx',
    model: 'claude-opus-5',
  });
});

test('digest is 64 lowercase hex chars', () => {
  expect(() =>
    CampaignSchema.parse(goldenCampaign({ digest: 'XYZ' })),
  ).toThrow();
});

test('campaign documents are strict', () => {
  expect(() => CampaignSchema.parse(goldenCampaign({ extra: 1 }))).toThrow();
});
