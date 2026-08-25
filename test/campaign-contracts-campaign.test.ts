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
    // Sample arms are ARM NAMES: each block's sample-arm set must equal its
    // comparison's distinct arm set, one sample per arm.
    samples: [
      { sample_id: 's1', cell: 'scn_a@c1', arm: 'base_arm', replicate: 1 },
      { sample_id: 's2', cell: 'scn_a@c1', arm: 'treat_arm', replicate: 1 },
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
      { sample_id: 's1', cell: 'scn_a@c1', arm: 'base_arm', replicate: 1 },
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

test('comparison, block, and sample ids are unique', () => {
  expect(() =>
    CampaignSchema.parse(
      goldenCampaign({
        comparisons: [
          { comparison_id: 'c1', baseline: 'base_arm', treatment: 'treat_arm' },
          { comparison_id: 'c1', arm: 'base_arm' },
        ],
      }),
    ),
  ).toThrow(/duplicate comparison/);
  expect(() =>
    CampaignSchema.parse(
      goldenCampaign({
        samples: [
          { sample_id: 's1', cell: 'scn_a@c1', arm: 'base_arm', replicate: 1 },
          { sample_id: 's1', cell: 'scn_a@c1', arm: 'treat_arm', replicate: 1 },
        ],
        blocks: [
          { block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 's1'] },
        ],
      }),
    ),
  ).toThrow(/duplicate sample/);
  const dupBlocks = goldenCampaign({
    comparisons: [
      { comparison_id: 'c1', baseline: 'base_arm', treatment: 'treat_arm' },
      { comparison_id: 'c2', arm: 'base_arm' },
    ],
    samples: [
      { sample_id: 's1', cell: 'scn_a@c1', arm: 'base_arm', replicate: 1 },
      { sample_id: 's2', cell: 'scn_a@c1', arm: 'treat_arm', replicate: 1 },
      { sample_id: 's3', cell: 'scn_a@c2', arm: 'base_arm', replicate: 1 },
    ],
    blocks: [
      { block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 's2'] },
      { block_id: 'b1', comparison_id: 'c2', sample_ids: ['s3'] },
    ],
  });
  expect(() => CampaignSchema.parse(dupBlocks)).toThrow(/duplicate block/);
});

test('block comparison references must resolve (no dangling comparison_id)', () => {
  expect(() =>
    CampaignSchema.parse(
      goldenCampaign({
        blocks: [
          { block_id: 'b1', comparison_id: 'ghost', sample_ids: ['s1', 's2'] },
        ],
      }),
    ),
  ).toThrow(/unknown comparison/);
});

test("each block's sample-arm set equals its comparison's distinct arm set", () => {
  // Duplicate arm: two samples of the same arm in one block.
  expect(() =>
    CampaignSchema.parse(
      goldenCampaign({
        samples: [
          { sample_id: 's1', cell: 'scn_a@c1', arm: 'base_arm', replicate: 1 },
          { sample_id: 's2', cell: 'scn_a@c1', arm: 'base_arm', replicate: 2 },
        ],
      }),
    ),
  ).toThrow(/arm set/);
  // Missing arm: a rogue arm displaces the comparison's treatment arm.
  expect(() =>
    CampaignSchema.parse(
      goldenCampaign({
        samples: [
          { sample_id: 's1', cell: 'scn_a@c1', arm: 'base_arm', replicate: 1 },
          { sample_id: 's2', cell: 'scn_a@c1', arm: 'rogue_arm', replicate: 1 },
        ],
      }),
    ),
  ).toThrow(/arm set/);
});

test('reverse cardinality: a single-arm block cannot hold two samples', () => {
  expect(() =>
    CampaignSchema.parse(
      goldenCampaign({
        comparisons: [{ comparison_id: 'c1', arm: 'base_arm' }],
        samples: [
          { sample_id: 's1', cell: 'scn_a@c1', arm: 'base_arm', replicate: 1 },
          { sample_id: 's2', cell: 'scn_a@c1', arm: 'base_arm', replicate: 2 },
        ],
        blocks: [
          { block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 's2'] },
        ],
      }),
    ),
  ).toThrow(/arm count/);
});

test('registered_at must be an ISO-8601 datetime', () => {
  expect(() =>
    CampaignSchema.parse(goldenCampaign({ registered_at: 'yesterday' })),
  ).toThrow();
  expect(() =>
    CampaignSchema.parse(goldenCampaign({ registered_at: '2026-08-24' })),
  ).toThrow();
  expect(
    CampaignSchema.parse(
      goldenCampaign({ registered_at: '2026-08-24T12:30:00+02:00' }),
    ).registered_at,
  ).toBe('2026-08-24T12:30:00+02:00');
});

test('campaign numbers are finite (estimates and budget reject Infinity)', () => {
  const infEstimates = goldenCampaign();
  (
    infEstimates.cells as Array<{
      estimates_by_arm: Record<string, { duration_s: number }>;
    }>
  )[0]!.estimates_by_arm['baseline']!.duration_s = Number.POSITIVE_INFINITY;
  expect(() => CampaignSchema.parse(infEstimates)).toThrow();
  expect(() =>
    CampaignSchema.parse(
      goldenCampaign({
        budget: {
          usd_all_in: Number.POSITIVE_INFINITY,
          surcharge_applied: 5,
          priced_coverage: 0.95,
        },
      }),
    ),
  ).toThrow();
});
