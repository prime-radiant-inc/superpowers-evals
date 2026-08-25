// test/campaign-contracts-digest.test.ts
import { expect, test } from 'bun:test';
import { CampaignSchema } from '../src/contracts/campaign/campaign.ts';
import {
  campaignDigest,
  jcsCanonicalize,
} from '../src/contracts/campaign/digest.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

// Inferred type (same shape as the fixture in
// campaign-contracts-campaign.test.ts): a Record<string, unknown> annotation
// would force bracket access under noPropertyAccessFromIndexSignature.
// Digest-only fixture, never schema-parsed: its role-labelled sample arms
// predate the block arm-set invariant, and updating them would churn the
// golden hash for no canonicalization change.
function goldenCampaign() {
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
      superpowers_by_arm: { base_arm: A, treat_arm: A },
      evals: B,
      gauntlet: C,
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
  };
}

test('golden vector: digest of the reference campaign', () => {
  // Campaign-level golden: canonical bytes of the exclusion-stripped document
  // and its SHA-256. The canonicalizer itself is verified against RFC 8785
  // vectors in campaign-contracts-jcs.test.ts.
  expect(campaignDigest(goldenCampaign() as never)).toBe(
    '7b116f014e80582de4ce8f356abf260afa2e27df0aba089f4ad73af9225eebec',
  );
});

test('mutating any excluded field leaves the digest invariant', () => {
  const base = campaignDigest(goldenCampaign() as never);
  const mutatedEstimates = goldenCampaign();
  mutatedEstimates.cells[0]!.estimates_by_arm.baseline.duration_s = 999999;
  expect(campaignDigest(mutatedEstimates as never)).toBe(base);

  const mutatedSurcharge = goldenCampaign();
  mutatedSurcharge.budget.surcharge_applied = 42;
  mutatedSurcharge.budget.priced_coverage = 0.1;
  expect(campaignDigest(mutatedSurcharge as never)).toBe(base);

  const mutatedMeta = goldenCampaign();
  mutatedMeta.campaign_id = 'cmp-other';
  mutatedMeta.registered_at = '2030-01-01T00:00:00Z';
  mutatedMeta.registered_by = 'someone-else';
  expect(campaignDigest(mutatedMeta as never)).toBe(base);
});

test('mutating an included field changes the digest', () => {
  const base = campaignDigest(goldenCampaign() as never);
  const mutatedBudget = goldenCampaign();
  mutatedBudget.budget.usd_all_in = 200;
  expect(campaignDigest(mutatedBudget as never)).not.toBe(base);

  const mutatedGrid = goldenCampaign();
  mutatedGrid.blocks[0]!.sample_ids = ['s1'];
  expect(campaignDigest(mutatedGrid as never)).not.toBe(base);
});

test('key insertion order does not affect the digest', () => {
  const forward: Record<string, unknown> = goldenCampaign();
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(forward).reverse())
    reversed[key] = forward[key];
  expect(campaignDigest(reversed as never)).toBe(
    campaignDigest(forward as never),
  );
});

test('a present digest field is excluded from its own computation', () => {
  const without = goldenCampaign();
  const withDigest = { ...goldenCampaign(), digest: 'f'.repeat(64) };
  expect(campaignDigest(withDigest as never)).toBe(
    campaignDigest(without as never),
  );
});

test('digest creation accepts a pre-digest campaign (no placeholder digest)', () => {
  // Registration computes the digest BEFORE the document carries one: the
  // statically-typed pre-digest shape (digest absent) must be accepted and
  // produce the same digest as the completed document.
  const parsed = CampaignSchema.parse({
    ...goldenCampaign(),
    samples: [
      { sample_id: 's1', cell: 'scn_a@c1', arm: 'base_arm', replicate: 1 },
      { sample_id: 's2', cell: 'scn_a@c1', arm: 'treat_arm', replicate: 1 },
    ],
    digest: '0'.repeat(64),
  });
  const { digest: _placeholder, ...preDigest } = parsed;
  expect(campaignDigest(preDigest)).toBe(campaignDigest(parsed));
});

test('lone UTF-16 surrogates reject in string values and object keys (RFC 8785)', () => {
  // A high surrogate with no low partner is not a Unicode string; JCS
  // requires well-formed input before JSON quoting.
  expect(() => jcsCanonicalize('broken \ud800 value')).toThrow(/surrogate/);
  expect(() => jcsCanonicalize({ ok: 'broken \udfff tail' })).toThrow(
    /surrogate/,
  );
  expect(() => jcsCanonicalize({ 'key\ud800': 1 })).toThrow(/surrogate/);
  // Valid surrogate PAIRS stay supported in both positions.
  expect(jcsCanonicalize('😀')).toBe('"😀"');
  expect(jcsCanonicalize({ '😀': 1 })).toBe('{"😀":1}');
});
