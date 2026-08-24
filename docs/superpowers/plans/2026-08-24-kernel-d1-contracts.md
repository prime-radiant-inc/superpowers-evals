# Kernel D1 — Campaign Platform Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every campaign-platform contract of the parent spec's Appendix B as zod schemas and pure functions — documents, JCS digest, journal event vocabulary, state machines, credential/verdict/CheckRecord amendments, pool derivation, profile parameters, scenario frontmatter, arm/suite validation, and the `run_allocated` protocol seam — with zero storage, dispatch, or reporting logic.

**Architecture:** Campaign-domain schemas live in `src/contracts/campaign/` (one focused file per document family — the Phase 0 precedent puts campaign zod under `src/contracts/`); cross-cutting schemas (`credential.ts`, `verdict.ts`) are amended in place. Everything is either a zod schema or a pure function, so every unit is direct-testable with real fixture JSON — no mocks. The single runner change is a one-line protocol emission at the existing `onRunDir` seam.

**Tech Stack:** TypeScript on Bun ≥1.3, zod v3 (existing), `Bun.SHA256` for the digest, `bun:test`. No new dependencies (the JCS canonicalizer is hand-rolled per the spec's implementation contract).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-24-kernel-d1-contracts-design.md` (revision 2) governs; the parent spec `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md` governs the spec. Where this plan and the spec diverge, stop and ask.
- **No new dependencies.** JCS is hand-rolled (RFC 8785 semantics: recursive key sort by UTF-16 code units, ES6 number/string serialization, NaN/Infinity rejected, no whitespace).
- **Layout:** campaign schemas in `src/contracts/campaign/`; amendments to `src/contracts/credential.ts` and `src/contracts/verdict.ts` happen in those files. One spec-layout refinement: the CheckRecord extension amends the existing `CheckRecordSchema` in `src/contracts/verdict.ts` (no separate `check-record.ts` — two CheckRecord schemas would be a duplication bug).
- **Back-compat is structural:** `FinalVerdictSchema` and `CheckRecordSchema` are non-strict objects and every addition is optional — existing shapes must parse unchanged, and tests assert it.
- **No mocked-behavior tests** (repo culture): schemas parse real fixture JSON; pure functions are tested directly; CLI behavior is tested by spawning the real CLI (`test/cli-run.test.ts` harness pattern) or real subprocesses.
- **Digest:** SHA-256 over JCS bytes (`Bun.SHA256.hash(bytes, 'hex')` idiom, per `src/campaign/acquire.ts`), hex-encoded, 64 chars.
- **Error style:** zod schemas use `.strict()` for authored config documents (Arm, Suite) and campaign documents; refinements via `.superRefine`. Appliance-style typed errors are not in scope here.
- **Gate per commit:** `bun run check` (biome + tsc + bun test) green. Run `bun run format` before committing if biome complains.
- **Test naming:** `test/campaign-contracts-<area>.test.ts` (note: `test/campaign-contracts.test.ts` already exists for Phase 0 — do not touch it).
- **Commits:** one task = one commit (or a few tightly-scoped commits), message style lowercase-prefix like recent log (`feat(campaign):`, `test(campaign):`, `fix:`).

---

### Task 1: Arm and Suite schemas

**Files:**
- Create: `src/contracts/campaign/arm.ts`
- Create: `src/contracts/campaign/suite.ts`
- Test: `test/campaign-contracts-arm-suite.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `ArmSchema`, `Arm` (type); `SuiteSchema`, `Suite`, `ComparisonSchema`, `TwoArmComparisonSchema`, `SingleArmComparisonSchema`, `CellOverrideSchema`, `CELL_CLASSES`, `SUITE_KINDS`, `PROFILE_NAMES`, `TIER_SELECTOR_RE` — Task 2 embeds `SuiteSchema` in the Campaign document; Task 12 validates `profile_params` against the profile registry; Task 14 validates arm/suite files against these schemas.

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-arm-suite.test.ts
import { expect, test } from 'bun:test';
import { ArmSchema } from '../src/contracts/campaign/arm.ts';
import { SuiteSchema } from '../src/contracts/campaign/suite.ts';

const ARM = {
  schema_version: 1,
  name: 'claude_superpowers',
  agent: 'claude',
  credential: 'opus_bedrock',
  superpowers: 'v6.1.0',
};

test('an arm document round-trips', () => {
  expect(ArmSchema.parse(ARM)).toEqual(ARM);
  const full = { ...ARM, os: 'linux', labels: { role: 'baseline' } };
  expect(ArmSchema.parse(full)).toEqual(full);
});

test('arm names match the credential-name discipline', () => {
  expect(() => ArmSchema.parse({ ...ARM, name: 'Claude-Superpowers' })).toThrow();
});

test('arm superpowers accepts none, tags, and full SHAs', () => {
  expect(ArmSchema.parse({ ...ARM, superpowers: 'none' }).superpowers).toBe('none');
  expect(ArmSchema.parse({ ...ARM, superpowers: 'a'.repeat(40) }).superpowers).toBe('a'.repeat(40));
  expect(() => ArmSchema.parse({ ...ARM, superpowers: '' })).toThrow();
});

test('arm documents are strict (unknown keys reject)', () => {
  expect(() => ArmSchema.parse({ ...ARM, model: 'claude-opus-5' })).toThrow();
});

function twoArmSuite(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    name: 'harness_compare',
    kind: 'exploratory',
    budget_usd: 150,
    comparisons: [
      {
        baseline: 'claude_superpowers',
        treatment: 'codex_superpowers',
        scenarios: ['sdd-escalates', 'fractals-smoke'],
        n: 5,
        cells: { 'sdd-escalates': { n: 10, class: 'confirmatory' } },
      },
    ],
    ...overrides,
  };
}

test('a two-arm suite round-trips', () => {
  expect(SuiteSchema.parse(twoArmSuite())).toMatchObject({ name: 'harness_compare' });
});

test('a single-arm suite round-trips', () => {
  const suite = twoArmSuite({
    comparisons: [{ arm: 'claude_stock', scenarios: ['fractals-smoke'], n: 2 }],
  });
  expect(SuiteSchema.parse(suite).comparisons[0]).toMatchObject({ arm: 'claude_stock' });
});

test('the tier selector grammar is admitted; no other selector syntax', () => {
  expect(SuiteSchema.parse(
    twoArmSuite({ comparisons: [{ baseline: 'a', treatment: 'b', scenarios: 'tier=sentinel', n: 1 }] }),
  ).comparisons[0]).toMatchObject({ scenarios: 'tier=sentinel' });
  expect(() => SuiteSchema.parse(
    twoArmSuite({ comparisons: [{ baseline: 'a', treatment: 'b', scenarios: 'glob=sdd-*', n: 1 }] }),
  )).toThrow();
  expect(() => SuiteSchema.parse(
    twoArmSuite({ comparisons: [{ baseline: 'a', treatment: 'b', scenarios: [], n: 1 }] }),
  )).toThrow();
});

test('cell classes are the closed 08-08 vocabulary', () => {
  const suite = twoArmSuite({
    comparisons: [{
      baseline: 'a', treatment: 'b', scenarios: ['s'], n: 1,
      cells: { s: { class: 'bogus' } },
    }],
  });
  expect(() => SuiteSchema.parse(suite)).toThrow();
});

test('gating tripwire cells must declare tripwire_expect', () => {
  const gating = twoArmSuite({
    kind: 'gating',
    profile: 'release_gate_v1',
    reserve: 1,
    max_exposure_skew: 600,
    comparisons: [{
      baseline: 'a', treatment: 'b', scenarios: ['s'], n: 1,
      cells: { s: { class: 'tripwire' } },
    }],
  });
  expect(() => SuiteSchema.parse(gating)).toThrow(/tripwire_expect/);
  const fixed = {
    ...gating,
    comparisons: [{ ...gating.comparisons[0], cells: { s: { class: 'tripwire', tripwire_expect: 'fail' } } }],
  };
  expect(SuiteSchema.parse(fixed)).toMatchObject({ kind: 'gating' });
});

test('gating suites require profile, reserve, and max_exposure_skew', () => {
  const gating = twoArmSuite({ kind: 'gating' });
  expect(() => SuiteSchema.parse(gating)).toThrow();
});

test('exploratory suites may carry reserve (optional, never rejected)', () => {
  expect(SuiteSchema.parse(twoArmSuite({ reserve: 2 }))).toMatchObject({ reserve: 2 });
});

test('suites are strict and need at least one comparison', () => {
  expect(() => SuiteSchema.parse(twoArmSuite({ comparisons: [] }))).toThrow();
  expect(() => SuiteSchema.parse(twoArmSuite({ rigor: 'high' }))).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-arm-suite.test.ts`
Expected: FAIL — cannot resolve `../src/contracts/campaign/arm.ts`.

- [ ] **Step 3: Implement the Arm schema**

```ts
// src/contracts/campaign/arm.ts
import { z } from 'zod';

// Arm names follow the credential-name discipline (registry keys interleave).
const NAME_RE = /^[a-z0-9_]+$/;

/** Tag-vs-SHA disambiguation is registration's job (D3's
 *  resolveSuperpowersRef); the schema admits any non-empty ref or "none". */
export const ArmSuperpowersSchema = z.union([
  z.literal('none'),
  z.string().min(1),
]);

export const ArmSchema = z
  .object({
    schema_version: z.literal(1),
    name: z.string().regex(NAME_RE),
    agent: z.string().min(1),
    credential: z.string().min(1),
    superpowers: ArmSuperpowersSchema,
    // Validated against the os-target vocabulary at registration; "windows"
    // parses and is a registration error (parent non-goal).
    os: z.string().min(1).optional(),
    labels: z.record(z.string()).optional(),
  })
  .strict();
export type Arm = z.infer<typeof ArmSchema>;
```

- [ ] **Step 4: Implement the Suite schema**

```ts
// src/contracts/campaign/suite.ts
import { z } from 'zod';

export const CELL_CLASSES = [
  'confirmatory',
  'probe',
  'tripwire',
  'descriptive',
] as const;
export const SUITE_KINDS = ['gating', 'exploratory'] as const;
export const PROFILE_NAMES = ['release_gate_v1', 'descriptive_v1'] as const;
export const TIER_SELECTOR_RE = /^tier=(sentinel|full|adhoc)$/;

const NAME_RE = /^[a-z0-9_]+$/;

export const CellOverrideSchema = z
  .object({
    n: z.number().int().positive().optional(),
    class: z.enum(CELL_CLASSES).optional(),
    tripwire_expect: z.enum(['pass', 'fail']).optional(),
  })
  .strict();
export type CellOverride = z.infer<typeof CellOverrideSchema>;

/** Explicit scenario list, or a tier token registration expands (D3). The
 *  Campaign document always stores the expanded form. */
const ScenarioSelectorSchema = z.union([
  z.array(z.string().min(1)).min(1),
  z.string().regex(TIER_SELECTOR_RE),
]);

export const TwoArmComparisonSchema = z
  .object({
    baseline: z.string().min(1),
    treatment: z.string().min(1),
    scenarios: ScenarioSelectorSchema,
    n: z.number().int().positive(),
    cells: z.record(z.string(), CellOverrideSchema).optional(),
  })
  .strict();

export const SingleArmComparisonSchema = z
  .object({
    arm: z.string().min(1),
    scenarios: ScenarioSelectorSchema,
    n: z.number().int().positive(),
    cells: z.record(z.string(), CellOverrideSchema).optional(),
  })
  .strict();

/** k-arm comparisons are out by parent non-goal: the shapes structurally
 *  admit exactly one or two arms. */
export const ComparisonSchema = z.union([
  TwoArmComparisonSchema,
  SingleArmComparisonSchema,
]);
export type Comparison = z.infer<typeof ComparisonSchema>;

export const SuiteSchema = z
  .object({
    schema_version: z.literal(1),
    name: z.string().regex(NAME_RE),
    kind: z.enum(SUITE_KINDS),
    budget_usd: z.number().positive(),
    profile: z.enum(PROFILE_NAMES).optional(),
    // Validated against the profile parameter registry (profile-params.ts)
    // by quorum check and registration — kept open-typed here.
    profile_params: z.record(z.unknown()).optional(),
    reserve: z.number().int().nonnegative().optional(),
    max_exposure_skew: z.number().positive().optional(),
    attempt_bounds: z
      .object({
        max_time_s: z.number().positive().optional(),
        max_attempts: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    declared_metrics: z
      .array(
        z
          .object({
            name: z.string().min(1),
            unit: z.string().min(1),
            aggregation: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    comparisons: z.array(ComparisonSchema).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    if (suite.kind === 'gating') {
      if (suite.profile === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['profile'],
          message: 'gating suites require a decision profile',
        });
      }
      if (suite.reserve === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reserve'],
          message: 'gating suites require a registered reserve',
        });
      }
      if (suite.max_exposure_skew === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['max_exposure_skew'],
          message: 'gating suites require a registered exposure-skew bound',
        });
      }
    }
    suite.comparisons.forEach((comparison, i) => {
      if (!('cells' in comparison) || comparison.cells === undefined) return;
      for (const [scenario, cell] of Object.entries(comparison.cells)) {
        if (cell.class === 'tripwire' && cell.tripwire_expect === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['comparisons', i, 'cells', scenario, 'tripwire_expect'],
            message:
              'tripwire cells must declare tripwire_expect (the v1 firing criterion)',
          });
        }
      }
    });
  });
export type Suite = z.infer<typeof SuiteSchema>;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-arm-suite.test.ts`
Expected: PASS (all tests). Then `bun run check` — full gate green.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/campaign/arm.ts src/contracts/campaign/suite.ts test/campaign-contracts-arm-suite.test.ts
git commit -m "feat(campaign): kernel D1 Arm + Suite contracts (selector grammar, cell classes, tripwire criterion)"
```

---

### Task 2: Campaign schema with cardinality invariants

**Files:**
- Create: `src/contracts/campaign/campaign.ts`
- Test: `test/campaign-contracts-campaign.test.ts`

**Interfaces:**
- Consumes: `SuiteSchema` from Task 1 (`src/contracts/campaign/suite.ts`); `CELL_CLASSES` from Task 1.
- Produces: `CampaignSchema`, `Campaign`, `CellSchema`, `SampleSchema`, `BlockSchema`, `CampaignComparisonSchema`, `EstimateSchema`, `PricingOverrideSchema` — Task 4's digest strips the exclusion list out of a `Campaign`; Task 14 validates registrations against it later (D3).

- [ ] **Step 1: Write the failing tests**

```ts
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
        { baseline: 'base_arm', treatment: 'treat_arm', scenarios: ['scn_a'], n: 1 },
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
    comparisons: [{ comparison_id: 'c1', baseline: 'base_arm', treatment: 'treat_arm' }],
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
    samples: [{ sample_id: 's1', cell: 'scn_a@c1', arm: 'baseline', replicate: 1 }],
    blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1'] }],
  });
  expect(CampaignSchema.parse(single).blocks[0]).toMatchObject({ sample_ids: ['s1'] });
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
    blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 'ghost'] }],
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
      { arm: 'base_arm', per_token_usd: 0.000003, rationale: 'obol-unpriced model' },
    ],
  });
  expect(CampaignSchema.parse(priced).pricing_overrides?.[0]).toMatchObject({
    arm: 'base_arm',
  });
});

test('refs resolve to full SHAs; grader stays singular', () => {
  expect(() =>
    CampaignSchema.parse(goldenCampaign({ refs: { superpowers_by_arm: {}, evals: 'short', gauntlet: SHA_C } })),
  ).toThrow();
  expect(CampaignSchema.parse(goldenCampaign()).grader).toEqual({
    credential: 'grader_fx',
    model: 'claude-opus-5',
  });
});

test('digest is 64 lowercase hex chars', () => {
  expect(() => CampaignSchema.parse(goldenCampaign({ digest: 'XYZ' }))).toThrow();
});

test('campaign documents are strict', () => {
  expect(() => CampaignSchema.parse(goldenCampaign({ extra: 1 }))).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-campaign.test.ts`
Expected: FAIL — cannot resolve `../src/contracts/campaign/campaign.ts`.

- [ ] **Step 3: Implement the Campaign schema**

```ts
// src/contracts/campaign/campaign.ts
import { z } from 'zod';
import { CELL_CLASSES, SuiteSchema } from './suite.ts';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

// Confidence vocabulary is the Phase 0 estimates contract
// (src/contracts/estimates.ts).
export const EstimateSchema = z
  .object({
    duration_s: z.number().positive(),
    cost_usd: z.number().nonnegative(),
    confidence: z.enum(['high', 'medium', 'low']),
  })
  .strict();
export type Estimate = z.infer<typeof EstimateSchema>;

export const COUPLING_CLASSES = [
  'pins-skill-names',
  'embeds-skill-fixtures',
  'arm-independent',
] as const;

export const CellSchema = z
  .object({
    scenario: z.string().min(1),
    comparison_id: z.string().min(1),
    arms: z.array(z.string().min(1)).min(1).max(2),
    n: z.number().int().positive(),
    class: z.enum(CELL_CLASSES),
    coupling: z.enum(COUPLING_CLASSES),
    estimates_by_arm: z.record(z.string(), EstimateSchema),
  })
  .strict();
export type Cell = z.infer<typeof CellSchema>;

export const SampleSchema = z
  .object({
    sample_id: z.string().min(1),
    cell: z.string().min(1),
    arm: z.string().min(1),
    replicate: z.number().int().positive(),
  })
  .strict();
export type Sample = z.infer<typeof SampleSchema>;

export const BlockSchema = z
  .object({
    block_id: z.string().min(1),
    comparison_id: z.string().min(1),
    sample_ids: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Block = z.infer<typeof BlockSchema>;

export const CampaignComparisonSchema = z.union([
  z
    .object({
      comparison_id: z.string().min(1),
      baseline: z.string().min(1),
      treatment: z.string().min(1),
    })
    .strict(),
  z
    .object({
      comparison_id: z.string().min(1),
      arm: z.string().min(1),
    })
    .strict(),
]);
export type CampaignComparison = z.infer<typeof CampaignComparisonSchema>;

/** The operator-declared per-token escape for unpriced gating models —
 *  parent Concepts records it in campaign.json (Appendix B omission
 *  reconciled in the D1 spec). */
export const PricingOverrideSchema = z
  .object({
    arm: z.string().min(1),
    scenario: z.string().min(1).optional(),
    per_token_usd: z.number().positive(),
    rationale: z.string().min(1),
  })
  .strict();
export type PricingOverride = z.infer<typeof PricingOverrideSchema>;

export const CampaignSchema = z
  .object({
    schema_version: z.literal(1),
    campaign_id: z.string().min(1),
    suite: SuiteSchema,
    refs: z
      .object({
        superpowers_by_arm: z.record(
          z.string(),
          z.union([z.string().regex(FULL_SHA_RE), z.null()]),
        ),
        evals: z.string().regex(FULL_SHA_RE),
        gauntlet: z.string().regex(FULL_SHA_RE),
      })
      .strict(),
    grader: z
      .object({ credential: z.string().min(1), model: z.string().min(1) })
      .strict(),
    cells: z.array(CellSchema),
    excluded_cells: z.array(
      z.object({ cell: z.string().min(1), reason: z.string().min(1) }).strict(),
    ),
    samples: z.array(SampleSchema),
    comparisons: z.array(CampaignComparisonSchema),
    blocks: z.array(BlockSchema),
    pricing_overrides: z.array(PricingOverrideSchema).optional(),
    budget: z
      .object({
        usd_all_in: z.number().positive(),
        surcharge_applied: z.number().nonnegative(),
        priced_coverage: z.number().min(0).max(1),
      })
      .strict(),
    registered_at: z.string().min(1),
    registered_by: z.string().min(1),
    digest: z.string().regex(DIGEST_RE),
  })
  .strict()
  .superRefine((campaign, ctx) => {
    // Cardinality invariants (parent Identity): a two-arm comparison's block
    // holds two samples; a single-arm unit's block holds one; every sample
    // belongs to exactly one block.
    const armsByComparison = new Map<string, number>();
    for (const comparison of campaign.comparisons) {
      armsByComparison.set(
        comparison.comparison_id,
        'arm' in comparison ? 1 : 2,
      );
    }
    const seen = new Set<string>();
    for (const block of campaign.blocks) {
      const arms = armsByComparison.get(block.comparison_id);
      if (arms !== undefined && block.sample_ids.length !== arms) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', campaign.blocks.indexOf(block), 'sample_ids'],
          message: `block ${block.block_id} sample count must match its comparison's arm count (${arms})`,
        });
      }
      for (const sampleId of block.sample_ids) {
        if (seen.has(sampleId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['blocks'],
            message: `sample ${sampleId} belongs to more than one block; every sample belongs to exactly one block`,
          });
        }
        seen.add(sampleId);
        if (!campaign.samples.some((s) => s.sample_id === sampleId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['blocks'],
            message: `block ${block.block_id} references unknown sample ${sampleId}`,
          });
        }
      }
    }
    for (const sample of campaign.samples) {
      if (!seen.has(sample.sample_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['samples'],
          message: `sample ${sample.sample_id} belongs to no block; every sample belongs to exactly one block`,
        });
      }
    }
  });
export type Campaign = z.infer<typeof CampaignSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-campaign.test.ts`
Expected: PASS. Then `bun run check` green.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/campaign/campaign.ts test/campaign-contracts-campaign.test.ts
git commit -m "feat(campaign): kernel D1 Campaign contract (comparisons union, cardinality invariants, pricing overrides)"
```

---

### Task 3: JCS canonicalizer (RFC 8785)

**Files:**
- Create: `src/contracts/campaign/digest.ts` (this task adds `jcsCanonicalize` + `sha256Hex`; Task 4 adds `campaignDigest`)
- Test: `test/campaign-contracts-jcs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `jcsCanonicalize(value: unknown): string` and `sha256Hex(text: string): string` — Task 4 builds the campaign digest on both.

- [ ] **Step 1: Write the failing tests**

The number vectors are RFC 8785 Appendix B Table 1 (the finite entries, verbatim).

```ts
// test/campaign-contracts-jcs.test.ts
import { expect, test } from 'bun:test';
import { jcsCanonicalize, sha256Hex } from '../src/contracts/campaign/digest.ts';

// RFC 8785 Appendix B, Table 1 — ECMAScript-compatible JSON number
// serialization samples (finite entries, verbatim).
const RFC_NUMBER_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [0, '0'],
  [-0, '0'], // minus zero serializes as 0
  [5e-324, '5e-324'],
  [-5e-324, '-5e-324'],
  [1.7976931348623157e308, '1.7976931348623157e+308'],
  [-1.7976931348623157e308, '-1.7976931348623157e+308'],
  [9007199254740992, '9007199254740992'],
  [-9007199254740992, '-9007199254740992'],
  [295147905179352825856, '295147905179352830000'], // ~2**68
  [9.999999999999997e22, '9.999999999999997e+22'],
  [1e23, '1e+23'],
  [1.0000000000000001e23, '1.0000000000000001e+23'],
  [999999999999999700000, '999999999999999700000'],
  [999999999999999900000, '999999999999999900000'],
  [1e21, '1e+21'],
  [9.999999999999997e-7, '9.999999999999997e-7'],
  [0.000001, '0.000001'],
  [333333333.3333332, '333333333.3333332'],
  [333333333.33333325, '333333333.33333325'],
  [333333333.3333333, '333333333.3333333'],
  [333333333.3333334, '333333333.3333334'],
  [333333333.33333343, '333333333.33333343'],
  [-0.0000033333333333333333, '-0.0000033333333333333333'],
  [1424953923781206.2, '1424953923781206.2'], // round-to-even case
];

test('RFC 8785 Appendix B number serialization vectors', () => {
  for (const [value, expected] of RFC_NUMBER_VECTORS) {
    expect(jcsCanonicalize(value)).toBe(expected);
  }
});

test('object keys sort by UTF-16 code units at every depth', () => {
  expect(jcsCanonicalize({ b: 2, a: 1, A: 3 })).toBe('{"A":3,"a":1,"b":2}');
  // Euro sign U+20AC sorts after ASCII letters (0x20AC > 0x007A)…
  expect(jcsCanonicalize({ z: 1, '\u20ac': 2 })).toBe('{"z":1,"\u20ac":2}');
  // …and a surrogate-pair key (U+1F600, first code unit 0xD83D) sorts before
  // U+FFFD (0xFFFD) even though the astral code point is larger.
  expect(jcsCanonicalize({ '\ufffd': 1, '\ud83d\ude00': 2 })).toBe(
    '{"\ud83d\ude00":2,"\ufffd":1}',
  );
  // Nested objects sort too.
  expect(jcsCanonicalize({ outer: { b: 1, a: 2 } })).toBe(
    '{"outer":{"a":2,"b":1}}',
  );
});

test('arrays keep order; strings use ES6 escaping; non-ASCII stays literal', () => {
  expect(jcsCanonicalize([3, 1, 2])).toBe('[3,1,2]');
  expect(jcsCanonicalize('a"b\\\n\t\u0001')).toBe('"a\\"b\\\\\\n\\t\\u0001"');
  expect(jcsCanonicalize('€')).toBe('"€"');
});

test('primitives, null, and empty containers', () => {
  expect(jcsCanonicalize(true)).toBe('true');
  expect(jcsCanonicalize(false)).toBe('false');
  expect(jcsCanonicalize(null)).toBe('null');
  expect(jcsCanonicalize({})).toBe('{}');
  expect(jcsCanonicalize([])).toBe('[]');
});

test('non-finite numbers and non-JSON types are rejected loud', () => {
  expect(() => jcsCanonicalize(Number.NaN)).toThrow(/finite/);
  expect(() => jcsCanonicalize(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  expect(() => jcsCanonicalize(undefined)).toThrow();
  expect(() => jcsCanonicalize(() => 1)).toThrow();
});

test('no whitespace anywhere in canonical output', () => {
  const canonical = jcsCanonicalize({ a: [1, { b: null }], c: 'x' });
  expect(canonical).toBe('{"a":[1,{"b":null}],"c":"x"}');
});

test('sha256Hex digests UTF-8 bytes', () => {
  // Known SHA-256 of the empty string.
  expect(sha256Hex('')).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-jcs.test.ts`
Expected: FAIL — cannot resolve `../src/contracts/campaign/digest.ts`.

- [ ] **Step 3: Implement the canonicalizer**

```ts
// src/contracts/campaign/digest.ts
// JCS (RFC 8785) canonicalization, hand-rolled per the D1 spec's
// implementation contract: no dependency, recursive key sort by UTF-16 code
// units, ES6 number/string serialization (JS semantics already match JCS for
// finite doubles and string escaping), NaN/Infinity rejected. Known failure
// mode this replaces: hashing non-canonicalized JSON.stringify output (see
// src/appliance/container.ts's plain-stringify hash — never do that here).

/** Canonicalize a JSON-domain value per RFC 8785. Throws on non-JSON inputs
 *  (undefined, functions, symbols, NaN, Infinity). */
export function jcsCanonicalize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`JCS rejects non-finite numbers: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => jcsCanonicalize(item)).join(',')}]`;
  }
  if (t === 'object') {
    const record = value as Record<string, unknown>;
    // JS default sort compares strings by UTF-16 code units — exactly the
    // RFC 8785 key ordering.
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${jcsCanonicalize(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`JCS rejects non-JSON values of type ${t}`);
}

/** SHA-256 over the UTF-8 bytes of `text`, hex-encoded. */
export function sha256Hex(text: string): string {
  return Bun.SHA256.hash(new TextEncoder().encode(text), 'hex');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-jcs.test.ts`
Expected: PASS. Then `bun run check` green.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/campaign/digest.ts test/campaign-contracts-jcs.test.ts
git commit -m "feat(campaign): kernel D1 JCS canonicalizer (RFC 8785 vectors, SHA-256 hex)"
```

---

### Task 4: Campaign digest (exclusion list + golden vectors)

**Files:**
- Modify: `src/contracts/campaign/digest.ts` (add `digestInput` + `campaignDigest`)
- Test: `test/campaign-contracts-digest.test.ts`

**Interfaces:**
- Consumes: `jcsCanonicalize`, `sha256Hex` (Task 3); `Campaign` type (Task 2).
- Produces: `campaignDigest(campaign: Campaign): string` — D3 registration computes and stores it; the `sealed` journal event carries the report digest the same way (D4).

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-digest.test.ts
import { expect, test } from 'bun:test';
import { campaignDigest } from '../src/contracts/campaign/digest.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function goldenCampaign(): Record<string, unknown> {
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
        { baseline: 'base_arm', treatment: 'treat_arm', scenarios: ['scn_a'], n: 1 },
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
    comparisons: [{ comparison_id: 'c1', baseline: 'base_arm', treatment: 'treat_arm' }],
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
  (mutatedEstimates.cells as any[])[0].estimates_by_arm.baseline.duration_s = 999999;
  expect(campaignDigest(mutatedEstimates as never)).toBe(base);

  const mutatedSurcharge = goldenCampaign();
  (mutatedSurcharge.budget as any).surcharge_applied = 42;
  (mutatedSurcharge.budget as any).priced_coverage = 0.1;
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
  (mutatedBudget.budget as any).usd_all_in = 200;
  expect(campaignDigest(mutatedBudget as never)).not.toBe(base);

  const mutatedGrid = goldenCampaign();
  (mutatedGrid.blocks as any[])[0].sample_ids = ['s1'];
  expect(campaignDigest(mutatedGrid as never)).not.toBe(base);
});

test('key insertion order does not affect the digest', () => {
  const forward = goldenCampaign();
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(forward).reverse()) reversed[key] = forward[key];
  expect(campaignDigest(reversed as never)).toBe(campaignDigest(forward as never));
});

test('a present digest field is excluded from its own computation', () => {
  const without = goldenCampaign();
  const withDigest = { ...goldenCampaign(), digest: 'f'.repeat(64) };
  expect(campaignDigest(withDigest as never)).toBe(campaignDigest(without as never));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-digest.test.ts`
Expected: FAIL — `campaignDigest` is not exported.

- [ ] **Step 3: Implement the digest**

Append to `src/contracts/campaign/digest.ts`:

```ts
import type { Campaign } from './campaign.ts';

/** Strip the advisory/re-derivable fields out of a campaign before
 *  canonicalization (parent Appendix B digest definition): estimates_by_arm
 *  in every cell, budget.surcharge_applied, budget.priced_coverage,
 *  registered_at, registered_by, campaign_id, and digest itself.
 *  budget.usd_all_in (the registered figure) stays in. */
export function digestInput(campaign: Campaign): Record<string, unknown> {
  const {
    campaign_id: _id,
    registered_at: _at,
    registered_by: _by,
    digest: _digest,
    ...rest
  } = campaign;
  return {
    ...rest,
    cells: campaign.cells.map(({ estimates_by_arm: _e, ...cell }) => cell),
    budget: { usd_all_in: campaign.budget.usd_all_in },
  };
}

/** The campaign's identity: SHA-256 over the JCS-canonicalized digest input,
 *  hex-encoded. Refreshing estimates never forks identity — only the frozen
 *  grid, refs, suite, and registered budget figure do. */
export function campaignDigest(campaign: Campaign): string {
  return sha256Hex(jcsCanonicalize(digestInput(campaign)));
}
```

Note: the unused destructure bindings (`_id`, `_at`, `_by`, `_digest`, `_e`) may trip biome's unused-var lint — if `bun run check` complains, prefix with the repo's accepted pattern or destructure via a helper object; follow biome's suggestion and keep behavior identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-digest.test.ts`
Expected: PASS. Then `bun run check` green.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/campaign/digest.ts test/campaign-contracts-digest.test.ts
git commit -m "feat(campaign): kernel D1 campaign digest (JCS + SHA-256, exclusion-list invariants, golden vector)"
```

---

### Task 5: Typed-failure surface + journal event vocabulary

**Files:**
- Create: `src/contracts/campaign/typed-failures.ts`
- Create: `src/contracts/campaign/journal-events.ts`
- Test: `test/campaign-contracts-journal.test.ts`

**Interfaces:**
- Consumes: nothing new (zod only).
- Produces: `FAILURE_CLASSES`, `FailureClass`, `INSTRUMENT_CAUSES`, `InstrumentCause`, `JOURNAL_EVENT_TYPES`, `JournalEventSchema`, `JournalEventType` — Task 6's transition tables key off `JournalEventType`; D3's journal store persists rows matching `JournalEventSchema`; D3's classifier maps `RunErrorStage` onto `FailureClass`/`InstrumentCause`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-journal.test.ts
import { expect, test } from 'bun:test';
import {
  FAILURE_CLASSES,
  INSTRUMENT_CAUSES,
} from '../src/contracts/campaign/typed-failures.ts';
import {
  JOURNAL_EVENT_TYPES,
  JournalEventSchema,
} from '../src/contracts/campaign/journal-events.ts';

test('the typed-failure codomain is the parent\'s four classes', () => {
  expect(FAILURE_CLASSES).toEqual(['instrument', 'evidence', 'aborted', 'shortfall']);
});

test('the initial instrument-cause vocabulary covers the named grader causes', () => {
  expect(INSTRUMENT_CAUSES).toContain('grader_billing_exhausted');
  expect(INSTRUMENT_CAUSES).toContain('grader_rate_limited');
});

test('the vocabulary holds the parent\'s 19 events plus campaign_cancelled', () => {
  expect(JOURNAL_EVENT_TYPES).toHaveLength(20);
  for (const type of [
    'campaign_opened', 'block_admitted', 'attempt_created', 'run_allocated',
    'exposure_started', 'run_completed', 'instrument_failure', 'block_replaced',
    'sample_disposition', 'slot_exhausted', 'budget_stopped', 'skew_excluded',
    'pool_blocked', 'budget_event', 'amendment', 'adjudication', 'aborted',
    'storage_paused', 'campaign_cancelled', 'sealed',
  ]) {
    expect(JOURNAL_EVENT_TYPES).toContain(type);
  }
});

test('every event type round-trips through the envelope', () => {
  const rows = [
    { seq: 1, ts_ms: 1, type: 'campaign_opened', payload: { campaign_id: 'c', digest: 'd'.repeat(64) } },
    { seq: 2, ts_ms: 2, type: 'block_admitted', payload: { block_id: 'b1', pools: ['p|api|model'] } },
    { seq: 3, ts_ms: 3, type: 'attempt_created', payload: { sample_id: 's1', attempt_id: 'a1' } },
    { seq: 4, ts_ms: 4, type: 'run_allocated', payload: { attempt_id: 'a1', run_id: 'r1', pgid: 4242 } },
    { seq: 5, ts_ms: 5, type: 'run_allocated', payload: { attempt_id: 'a1', run_id: 'r1', pgid: 4242, key_env: 'GRADER_KEY_2' } },
    { seq: 6, ts_ms: 6, type: 'exposure_started', payload: { sample_id: 's1', ts: 6 } },
    { seq: 7, ts_ms: 7, type: 'run_completed', payload: { attempt_id: 'a1', outcome: 'pass' } },
    { seq: 8, ts_ms: 8, type: 'instrument_failure', payload: { attempt_id: 'a1', cause: 'grader_rate_limited' } },
    { seq: 9, ts_ms: 9, type: 'block_replaced', payload: { block_id: 'b1', replacement_block_id: 'b2', cause: 'grader_rate_limited' } },
    { seq: 10, ts_ms: 10, type: 'sample_disposition', payload: { sample_id: 's1', disposition: 'excluded_block_replaced', superseded_by: 's3' } },
    { seq: 11, ts_ms: 11, type: 'slot_exhausted', payload: { sample_id: 's9' } },
    { seq: 12, ts_ms: 12, type: 'budget_stopped', payload: { sample_ids: ['s4', 's5'] } },
    { seq: 13, ts_ms: 13, type: 'skew_excluded', payload: { block_id: 'b3' } },
    { seq: 14, ts_ms: 14, type: 'pool_blocked', payload: { pool_key: 'p', until_ts_ms: 99 } },
    { seq: 15, ts_ms: 15, type: 'budget_event', payload: { kind: 'spend', amount_usd: 1.5 } },
    { seq: 16, ts_ms: 16, type: 'amendment', payload: { kind: 'budget_raise', amount_usd: 20, ts: 16 } },
    { seq: 17, ts_ms: 17, type: 'adjudication', payload: { cell: 'scn@c1', disposition: 'resolved', rationale: 'tripwire explained' } },
    { seq: 18, ts_ms: 18, type: 'aborted', payload: { block_id: 'b1' } },
    { seq: 19, ts_ms: 19, type: 'storage_paused', payload: {} },
    { seq: 20, ts_ms: 20, type: 'campaign_cancelled', payload: { reason: 'operator' } },
    { seq: 21, ts_ms: 21, type: 'sealed', payload: { report_digest: 'e'.repeat(64) } },
  ];
  for (const row of rows) {
    expect(JournalEventSchema.parse(row)).toEqual(row);
  }
});

test('instrument_failure causes are typed', () => {
  expect(() =>
    JournalEventSchema.parse({
      seq: 1, ts_ms: 1, type: 'instrument_failure',
      payload: { attempt_id: 'a1', cause: 'vibes' },
    }),
  ).toThrow();
});

test('envelope rejects unknown types and missing fields', () => {
  expect(() => JournalEventSchema.parse({ seq: 1, ts_ms: 1, type: 'invented', payload: {} })).toThrow();
  expect(() => JournalEventSchema.parse({ ts_ms: 1, type: 'aborted', payload: { block_id: 'b' } })).toThrow();
  expect(() => JournalEventSchema.parse({ seq: 1, type: 'aborted', payload: { block_id: 'b' } })).toThrow();
});

test('run_allocated key_env carries the name only (schema forbids values)', () => {
  // The payload shape is {attempt_id, run_id, pgid, key_env?}: a value-shaped
  // key_env object fails the string schema.
  expect(() =>
    JournalEventSchema.parse({
      seq: 1, ts_ms: 1, type: 'run_allocated',
      payload: { attempt_id: 'a1', run_id: 'r1', pgid: 1, key_env: { value: 'secret' } },
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-journal.test.ts`
Expected: FAIL — cannot resolve the two modules.

- [ ] **Step 3: Implement the typed-failure surface**

```ts
// src/contracts/campaign/typed-failures.ts
// The closed map composer-outcome -> {instrument (replace), evidence
// (indeterminate/pass/fail), aborted, shortfall} is a published kernel
// deliverable (parent Typed failures). D1 pins the type surface shared by
// the journal schema, the D3 classifier, and D4 report accounting; the D3
// classifier completes the closed cause set table-driven over RunErrorStage.

export const FAILURE_CLASSES = [
  'instrument',
  'evidence',
  'aborted',
  'shortfall',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Initial instrument-cause vocabulary (pinned here). The grader causes are
 *  the ones the parent names explicitly; the D3 classifier's RunErrorStage
 *  table closes the set. Unknown causes stay indeterminate and are never
 *  replaced. */
export const INSTRUMENT_CAUSES = [
  'grader_billing_exhausted',
  'grader_rate_limited',
  'subject_spawn_failed',
  'subject_crashed',
  'capture_failed',
  'checks_crashed',
] as const;
export type InstrumentCause = (typeof INSTRUMENT_CAUSES)[number];
```

- [ ] **Step 4: Implement the journal event vocabulary**

```ts
// src/contracts/campaign/journal-events.ts
import { z } from 'zod';
import { INSTRUMENT_CAUSES } from './typed-failures.ts';

/** Envelope (pinned here): single writer under flock makes seq monotonic;
 *  replay in seq order deterministically reconstructs state. The SQLite
 *  store's schema_version row is D3's storage obligation, not part of the
 *  per-event envelope. */
function envelope<T extends z.ZodTypeAny>(type: string, payload: T) {
  return z.object({
    seq: z.number().int().positive(),
    ts_ms: z.number().int().nonnegative(),
    type: z.literal(type),
    payload,
  });
}

const DigestStr = z.string().regex(/^[0-9a-f]{64}$/);

export const CampaignOpenedEvent = envelope(
  'campaign_opened',
  z.object({ campaign_id: z.string().min(1), digest: DigestStr }).strict(),
);
export const BlockAdmittedEvent = envelope(
  'block_admitted',
  z.object({ block_id: z.string().min(1), pools: z.array(z.string().min(1)) }).strict(),
);
export const AttemptCreatedEvent = envelope(
  'attempt_created',
  z.object({ sample_id: z.string().min(1), attempt_id: z.string().min(1) }).strict(),
);
export const RunAllocatedEvent = envelope(
  'run_allocated',
  z
    .object({
      attempt_id: z.string().min(1),
      run_id: z.string().min(1),
      pgid: z.number().int().positive(),
      // Key grant (Decision D-1): name only, never the value, so key-grant
      // accounting is reconstructable from the journal.
      key_env: z.string().min(1).optional(),
    })
    .strict(),
);
export const ExposureStartedEvent = envelope(
  'exposure_started',
  // ts IS analysis_exposure_started_at: the sample's first Coding-Agent
  // generation request (never spawn, never Gauntlet boot).
  z.object({ sample_id: z.string().min(1), ts: z.number().int().nonnegative() }).strict(),
);
export const RunCompletedEvent = envelope(
  'run_completed',
  z.object({ attempt_id: z.string().min(1), outcome: z.string().min(1) }).strict(),
);
export const InstrumentFailureEvent = envelope(
  'instrument_failure',
  z
    .object({
      attempt_id: z.string().min(1),
      cause: z.enum(INSTRUMENT_CAUSES),
    })
    .strict(),
);
export const BlockReplacedEvent = envelope(
  'block_replaced',
  z
    .object({
      block_id: z.string().min(1),
      replacement_block_id: z.string().min(1),
      cause: z.enum(INSTRUMENT_CAUSES),
    })
    .strict(),
);
export const SampleDispositionEvent = envelope(
  'sample_disposition',
  z
    .object({
      sample_id: z.string().min(1),
      disposition: z.enum(['included', 'excluded_block_replaced']),
      superseded_by: z.string().min(1).optional(),
    })
    .strict(),
);
export const SlotExhaustedEvent = envelope(
  'slot_exhausted',
  z.object({ sample_id: z.string().min(1) }).strict(),
);
export const BudgetStoppedEvent = envelope(
  'budget_stopped',
  z.object({ sample_ids: z.array(z.string().min(1)) }).strict(),
);
export const SkewExcludedEvent = envelope(
  'skew_excluded',
  z.object({ block_id: z.string().min(1) }).strict(),
);
export const PoolBlockedEvent = envelope(
  'pool_blocked',
  z.object({ pool_key: z.string().min(1), until_ts_ms: z.number().int().nonnegative() }).strict(),
);
export const BudgetEventEvent = envelope(
  'budget_event',
  z
    .object({
      kind: z.enum(['spend', 'estimate_inflight']),
      amount_usd: z.number().nonnegative(),
    })
    .strict(),
);
export const AmendmentEvent = envelope(
  'amendment',
  z
    .object({
      kind: z.literal('budget_raise'),
      amount_usd: z.number().positive(),
      ts: z.number().int().nonnegative(),
    })
    .strict(),
);
export const AdjudicationEvent = envelope(
  'adjudication',
  z
    .object({
      cell: z.string().min(1),
      disposition: z.string().min(1),
      rationale: z.string().min(1),
    })
    .strict(),
);
export const AbortedEvent = envelope(
  'aborted',
  z.object({ block_id: z.string().min(1) }).strict(),
);
export const StoragePausedEvent = envelope(
  'storage_paused',
  z.object({}).strict(),
);
export const CampaignCancelledEvent = envelope(
  'campaign_cancelled',
  z.object({ reason: z.string().min(1).optional() }).strict(),
);
export const SealedEvent = envelope(
  'sealed',
  z.object({ report_digest: DigestStr }).strict(),
);

export const JournalEventSchema = z.discriminatedUnion('type', [
  CampaignOpenedEvent,
  BlockAdmittedEvent,
  AttemptCreatedEvent,
  RunAllocatedEvent,
  ExposureStartedEvent,
  RunCompletedEvent,
  InstrumentFailureEvent,
  BlockReplacedEvent,
  SampleDispositionEvent,
  SlotExhaustedEvent,
  BudgetStoppedEvent,
  SkewExcludedEvent,
  PoolBlockedEvent,
  BudgetEventEvent,
  AmendmentEvent,
  AdjudicationEvent,
  AbortedEvent,
  StoragePausedEvent,
  CampaignCancelledEvent,
  SealedEvent,
]);
export type JournalEvent = z.infer<typeof JournalEventSchema>;
export type JournalEventType = JournalEvent['type'];

export const JOURNAL_EVENT_TYPES: readonly JournalEventType[] = [
  'campaign_opened',
  'block_admitted',
  'attempt_created',
  'run_allocated',
  'exposure_started',
  'run_completed',
  'instrument_failure',
  'block_replaced',
  'sample_disposition',
  'slot_exhausted',
  'budget_stopped',
  'skew_excluded',
  'pool_blocked',
  'budget_event',
  'amendment',
  'adjudication',
  'aborted',
  'storage_paused',
  'campaign_cancelled',
  'sealed',
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-journal.test.ts`
Expected: PASS. Then `bun run check` green.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/campaign/typed-failures.ts src/contracts/campaign/journal-events.ts test/campaign-contracts-journal.test.ts
git commit -m "feat(campaign): kernel D1 journal event vocabulary (20 events, envelope) + typed-failure surface"
```

---

### Task 6: State machines (three-valued) + crash windows

**Files:**
- Create: `src/contracts/campaign/state-machine.ts`
- Create: `src/contracts/campaign/crash-windows.ts`
- Test: `test/campaign-contracts-state-machine.test.ts`

**Interfaces:**
- Consumes: `JournalEvent`, `JournalEventType` (Task 5).
- Produces: `SAMPLE_STATES`, `SampleState`, `TERMINAL_STATES`, `TransitionOutcome`, `applySampleEvent`, `CAMPAIGN_STATES`, `CampaignState`, `applyCampaignEvent`, `resolveCrashWindows` — D3's journal replay and recovery call these; the exhaustive table tests here are the reference the D3 replay tests check against.

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-state-machine.test.ts
import { expect, test } from 'bun:test';
import {
  applyCampaignEvent,
  applySampleEvent,
  SAMPLE_STATES,
  TERMINAL_STATES,
} from '../src/contracts/campaign/state-machine.ts';
import { resolveCrashWindows } from '../src/contracts/campaign/crash-windows.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';

test('the happy path walks planned -> admitted -> spawned -> exposed -> completed', () => {
  let state = 'planned' as const;
  for (const [event, next] of [
    ['block_admitted', 'admitted'],
    ['run_allocated', 'spawned'],
    ['exposure_started', 'exposed'],
    ['run_completed', 'completed'],
  ] as const) {
    const outcome = applySampleEvent(state, event);
    expect(outcome).toEqual({ result: 'apply', next });
    state = next;
  }
});

test('attempt_created binds without changing state', () => {
  expect(applySampleEvent('admitted', 'attempt_created')).toEqual({
    result: 'apply',
    next: 'admitted',
  });
});

test('admission-bypass edges: slot_exhausted and budget_stopped', () => {
  expect(applySampleEvent('planned', 'slot_exhausted')).toEqual({
    result: 'apply',
    next: 'exhausted',
  });
  expect(applySampleEvent('planned', 'budget_stopped')).toEqual({
    result: 'apply',
    next: 'budget_stopped',
  });
  // Extension pinned by the D1 spec (proposed parent erratum E3).
  expect(applySampleEvent('admitted', 'budget_stopped')).toEqual({
    result: 'apply',
    next: 'budget_stopped',
  });
});

test('the retained-evidence late sequences are ignore-late, not reject', () => {
  // A skew-excluded sample's run still completes (runs are retained).
  expect(applySampleEvent('skew_excluded', 'run_completed')).toEqual({
    result: 'ignore-late',
  });
  // Fast arm completes, then its block is replaced: the innocent arm's
  // disposition overrides a completed state.
  expect(applySampleEvent('completed', 'sample_disposition')).toEqual({
    result: 'apply',
    next: 'excluded_block_replaced',
  });
  expect(applySampleEvent('spawned', 'sample_disposition')).toEqual({
    result: 'apply',
    next: 'excluded_block_replaced',
  });
  // instrument_failure after a replacement disposition was already adjudged.
  expect(applySampleEvent('excluded_block_replaced', 'instrument_failure')).toEqual({
    result: 'ignore-late',
  });
  // First arm can expose after the block is already skew-excluded.
  expect(applySampleEvent('skew_excluded', 'exposure_started')).toEqual({
    result: 'ignore-late',
  });
});

test('instrument_failure applies from spawned or exposed only', () => {
  expect(applySampleEvent('spawned', 'instrument_failure')).toEqual({
    result: 'apply',
    next: 'instrument_failed',
  });
  expect(applySampleEvent('exposed', 'instrument_failure')).toEqual({
    result: 'apply',
    next: 'instrument_failed',
  });
  expect(applySampleEvent('planned', 'instrument_failure').result).toBe('reject');
});

test('abort reaches admitted, spawned, exposed — never terminals', () => {
  for (const state of ['admitted', 'spawned', 'exposed'] as const) {
    expect(applySampleEvent(state, 'aborted')).toEqual({ result: 'apply', next: 'aborted' });
  }
  expect(applySampleEvent('completed', 'aborted').result).toBe('reject');
});

test('every (state x event) pair is decided — no undefined outcomes', () => {
  const events = [
    'block_admitted', 'attempt_created', 'run_allocated', 'exposure_started',
    'run_completed', 'instrument_failure', 'block_replaced', 'sample_disposition',
    'slot_exhausted', 'budget_stopped', 'skew_excluded', 'pool_blocked',
    'budget_event', 'amendment', 'adjudication', 'aborted', 'storage_paused',
    'campaign_cancelled', 'sealed', 'campaign_opened',
  ] as const;
  for (const state of SAMPLE_STATES) {
    for (const event of events) {
      const outcome = applySampleEvent(state, event);
      expect(['apply', 'ignore-late', 'reject']).toContain(outcome.result);
      if (outcome.result === 'apply') {
        expect(SAMPLE_STATES).toContain(outcome.next);
      }
    }
  }
  // Terminals never apply further state changes (ignore-late only).
  for (const terminal of TERMINAL_STATES) {
    for (const event of events) {
      const outcome = applySampleEvent(terminal, event);
      if (outcome.result === 'apply') {
        expect(outcome.next).toBe(terminal); // bind-only at most
      }
    }
  }
});

test('campaign machine: opened, cancelled, sealed, and storage pauses', () => {
  expect(applyCampaignEvent('registered', 'campaign_opened')).toEqual({
    result: 'apply',
    next: 'running',
  });
  expect(applyCampaignEvent('running', 'campaign_cancelled')).toEqual({
    result: 'apply',
    next: 'cancelled',
  });
  expect(applyCampaignEvent('running', 'storage_paused')).toEqual({
    result: 'apply',
    next: 'storage_paused',
  });
  // Derivation rule: first activity after storage_paused resumes running.
  expect(applyCampaignEvent('storage_paused', 'block_admitted')).toEqual({
    result: 'apply',
    next: 'running',
  });
  expect(applyCampaignEvent('sealing', 'sealed')).toEqual({
    result: 'apply',
    next: 'sealed',
  });
  // Sealed and cancelled are terminal.
  expect(applyCampaignEvent('sealed', 'campaign_cancelled').result).toBe('reject');
  expect(applyCampaignEvent('cancelled', 'campaign_opened').result).toBe('reject');
});

function event(seq: number, type: JournalEvent['type'], payload: unknown): JournalEvent {
  return { seq, ts_ms: seq, type, payload } as JournalEvent;
}

test('crash windows: pre-run_allocated voids, post-run_allocated reruns', () => {
  const windows = resolveCrashWindows([
    event(1, 'campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    event(2, 'block_admitted', { block_id: 'b1', pools: ['p'] }),
    event(3, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(4, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 4242 }),
    event(5, 'attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    // Crash: a1 has run_allocated without a terminal; a2 never allocated.
  ]);
  expect(windows.attempts).toEqual([
    { attempt_id: 'a1', resolution: 'kill_pgid_rerun_block', pgid: 4242 },
    { attempt_id: 'a2', resolution: 'void_attempt_readmit' },
  ]);
  expect(windows.campaign).toBe('none');
});

test('crash windows: completed attempts need nothing', () => {
  const windows = resolveCrashWindows([
    event(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    event(3, 'run_completed', { attempt_id: 'a1', outcome: 'pass' }),
  ]);
  expect(windows.attempts).toEqual([]);
});

test('crash windows: all-samples-terminal without sealed means regenerate report', () => {
  const windows = resolveCrashWindows([
    event(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    event(3, 'run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    // No sealed event: the process died post-predicate pre-report.
  ]);
  expect(windows.campaign).toBe('regenerate_report');
  const sealed = resolveCrashWindows([
    event(1, 'attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    event(2, 'run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 42 }),
    event(3, 'run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    event(4, 'sealed', { report_digest: 'e'.repeat(64) }),
  ]);
  expect(sealed.campaign).toBe('none');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-state-machine.test.ts`
Expected: FAIL — cannot resolve the modules.

- [ ] **Step 3: Implement the state machines**

```ts
// src/contracts/campaign/state-machine.ts
// Three-valued transitions (pinned by the D1 spec): apply | ignore-late |
// reject. The parent's retained-evidence design guarantees late events — a
// skew-excluded run still completes, and the innocent arm of a replaced
// block may already be completed when its sibling fails — so a two-valued
// table would make canonical event streams illegal.

export const SAMPLE_STATES = [
  'planned',
  'admitted',
  'spawned',
  'exposed',
  'completed',
  'instrument_failed',
  'aborted',
  'skew_excluded',
  'excluded_block_replaced',
  'exhausted',
  'budget_stopped',
] as const;
export type SampleState = (typeof SAMPLE_STATES)[number];

export const TERMINAL_STATES = [
  'completed',
  'instrument_failed',
  'aborted',
  'skew_excluded',
  'excluded_block_replaced',
  'exhausted',
  'budget_stopped',
] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export type TransitionResult = 'apply' | 'ignore-late' | 'reject';
export type TransitionOutcome =
  | { result: 'apply'; next: SampleState }
  | { result: 'ignore-late' }
  | { result: 'reject' };

const apply = (next: SampleState): TransitionOutcome => ({ result: 'apply', next });
const LATE: TransitionOutcome = { result: 'ignore-late' };
const REJECT: TransitionOutcome = { result: 'reject' };

function isTerminal(state: SampleState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** Advance one sample by one journal event type. Block-scoped events
 *  (block_admitted, skew_excluded, aborted) apply per sample of the block;
 *  callers fan them out. */
export function applySampleEvent(
  state: SampleState,
  eventType: string,
): TransitionOutcome {
  switch (eventType) {
    case 'block_admitted':
      return state === 'planned' ? apply('admitted') : REJECT;
    case 'attempt_created':
      // Binding only (sample <-> attempt); no state change outside terminals.
      return isTerminal(state) ? REJECT : apply(state);
    case 'run_allocated':
      return state === 'admitted' ? apply('spawned') : REJECT;
    case 'exposure_started':
      if (state === 'spawned') return apply('exposed');
      if (state === 'skew_excluded') return LATE; // fast-arm ordering
      return REJECT;
    case 'run_completed':
      if (state === 'exposed') return apply('completed');
      // Retained-evidence semantics: the run dir is kept and
      // journal-referenced either way.
      return isTerminal(state) ? LATE : REJECT;
    case 'instrument_failure':
      if (state === 'spawned' || state === 'exposed') {
        return apply('instrument_failed');
      }
      if (state === 'excluded_block_replaced') return LATE;
      return REJECT;
    case 'sample_disposition':
      // The innocent arm's override; superseded_by set by the payload.
      if (state === 'spawned' || state === 'exposed' || state === 'completed') {
        return apply('excluded_block_replaced');
      }
      return REJECT;
    case 'skew_excluded':
      // Fail-closed absence: a sample whose exposure never established can
      // still be skew-excluded from spawned (exposure-measurement contract).
      if (state === 'exposed' || state === 'spawned') {
        return apply('skew_excluded');
      }
      return REJECT;
    case 'slot_exhausted':
      return state === 'planned' ? apply('exhausted') : REJECT;
    case 'budget_stopped':
      // planned edge is the parent's; admitted extension is the D1 pin
      // (proposed parent erratum E3).
      if (state === 'planned' || state === 'admitted') {
        return apply('budget_stopped');
      }
      return REJECT;
    case 'aborted':
      if (state === 'admitted' || state === 'spawned' || state === 'exposed') {
        return apply('aborted');
      }
      return REJECT;
    default:
      // Campaign-scoped and accounting events never touch sample state.
      return REJECT;
  }
}

export const CAMPAIGN_STATES = [
  'registered',
  'running',
  'sealing',
  'sealed',
  'cancelled',
  'storage_paused',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export type CampaignTransitionOutcome =
  | { result: 'apply'; next: CampaignState }
  | { result: 'reject' };

/** Campaign edge -> event mapping (pinned). `sealing` is a transient
 *  computation state (completeness predicate running) witnessed by `sealed`;
 *  the crash-window resolver covers post-predicate pre-report. */
export function applyCampaignEvent(
  state: CampaignState,
  eventType: string,
): CampaignTransitionOutcome {
  const applyC = (next: CampaignState): CampaignTransitionOutcome => ({
    result: 'apply',
    next,
  });
  switch (state) {
    case 'registered':
      return eventType === 'campaign_opened' ? applyC('running') : { result: 'reject' };
    case 'running':
      if (eventType === 'campaign_cancelled') return applyC('cancelled');
      if (eventType === 'storage_paused') return applyC('storage_paused');
      if (eventType === 'block_admitted' || eventType === 'attempt_created' || eventType === 'budget_event') {
        return applyC('running'); // activity keeps it running
      }
      return { result: 'reject' };
    case 'storage_paused':
      // Derivation rule (pinned): first activity resumes; explicit cancel
      // still lands.
      if (
        eventType === 'block_admitted' ||
        eventType === 'attempt_created' ||
        eventType === 'budget_event'
      ) {
        return applyC('running');
      }
      if (eventType === 'campaign_cancelled') return applyC('cancelled');
      return { result: 'reject' };
    case 'sealing':
      return eventType === 'sealed' ? applyC('sealed') : { result: 'reject' };
    case 'sealed':
    case 'cancelled':
      return { result: 'reject' };
  }
}
```

- [ ] **Step 4: Implement the crash-window resolver**

```ts
// src/contracts/campaign/crash-windows.ts
// Crash-window resolutions (parent Appendix B) as a pure function over a
// journal prefix: pre-run_allocated -> attempt void, re-admit;
// post-run_allocated without terminal -> kill pgid, block rerun;
// post-seal-predicate pre-report -> regenerate report (idempotent).

import type { JournalEvent } from './journal-events.ts';

export interface AttemptCrashWindow {
  readonly attempt_id: string;
  readonly resolution: 'void_attempt_readmit' | 'kill_pgid_rerun_block';
  readonly pgid?: number;
}

export interface CrashWindowReport {
  readonly attempts: AttemptCrashWindow[];
  /** 'regenerate_report' when every journaled attempt is terminal but no
   *  sealed event exists (process died post-predicate pre-report). */
  readonly campaign: 'regenerate_report' | 'none';
}

export function resolveCrashWindows(events: JournalEvent[]): CrashWindowReport {
  const allocated = new Map<string, number>(); // attempt_id -> pgid
  const created = new Set<string>();
  const terminal = new Set<string>();
  let sealed = false;

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case 'attempt_created':
        created.add(String(payload['attempt_id']));
        break;
      case 'run_allocated':
        allocated.set(String(payload['attempt_id']), Number(payload['pgid']));
        break;
      case 'run_completed':
      case 'instrument_failure':
        terminal.add(String(payload['attempt_id']));
        break;
      case 'aborted':
      case 'budget_stopped':
        // Block-scoped terminals retire their attempts too; without the
        // sample->attempt map at this layer, D3 recovery applies the block
        // rule directly. Attempt-level terminals below cover the common path.
        break;
      case 'sealed':
        sealed = true;
        break;
      default:
        break;
    }
  }

  const attempts: AttemptCrashWindow[] = [];
  for (const attemptId of created) {
    if (terminal.has(attemptId)) continue;
    const pgid = allocated.get(attemptId);
    if (pgid !== undefined) {
      attempts.push({
        attempt_id: attemptId,
        resolution: 'kill_pgid_rerun_block',
        pgid,
      });
    } else {
      attempts.push({ attempt_id: attemptId, resolution: 'void_attempt_readmit' });
    }
  }

  const campaign =
    !sealed && created.size > 0 && attempts.length === 0
      ? 'regenerate_report'
      : 'none';
  return { attempts, campaign };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-state-machine.test.ts`
Expected: PASS. Then `bun run check` green.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/campaign/state-machine.ts src/contracts/campaign/crash-windows.ts test/campaign-contracts-state-machine.test.ts
git commit -m "feat(campaign): kernel D1 state machines (three-valued transitions, late-event policy) + crash-window resolver"
```

---

### Task 7: Report schema + byte-stability constants

**Files:**
- Create: `src/contracts/campaign/report.ts`
- Test: `test/campaign-contracts-report.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ReportSchema`, `Report`, `REPORT_VERDICTS`, `REPORT_RENDERING` — D4's report engine renders against `REPORT_RENDERING` and validates its output against `ReportSchema`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-report.test.ts
import { expect, test } from 'bun:test';
import {
  REPORT_RENDERING,
  ReportSchema,
} from '../src/contracts/campaign/report.ts';

function gatingReport(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    campaign_id: 'cmp-0001',
    profile: 'release_gate_v1',
    verdict: 'SHIP',
    cannot_answer: [{ cell: 'scn@c1', mde: 0.12 }],
    comparisons: [
      {
        comparison_id: 'c1',
        cells: [{ scenario: 'scn', class: 'confirmatory', n: 10, delta: 0.02, fisher_p: 0.4, mde: 0.12 }],
      },
    ],
    accounting: {
      instrument_errors: 1,
      indeterminates: 0,
      replacements: 1,
      reserve_draws: 1,
      skew_exclusions: 0,
      skew_caveats: 0,
      budget_events: 3,
      amendments: 0,
      denominators: { scored: 386, planned: 388 },
    },
    provenance: {
      arms: [{ arm: 'treat_arm', registered_model: 'm', observed_model_set: ['m'] }],
      grader: { credential: 'grader_fx', model: 'claude-opus-5', observed: 'claude-opus-5' },
    },
    errata: [],
    ...overrides,
  };
}

test('a gating report round-trips', () => {
  expect(ReportSchema.parse(gatingReport())).toMatchObject({ verdict: 'SHIP' });
});

test('verdict is present iff gating; stamp iff descriptive', () => {
  // Descriptive: stamp present, verdict structurally absent.
  const descriptive = {
    ...gatingReport({ profile: 'descriptive_v1', verdict: undefined, stamp: 'DESCRIPTIVE' }),
  };
  delete (descriptive as Record<string, unknown>).verdict;
  expect(ReportSchema.parse(descriptive)).toMatchObject({ stamp: 'DESCRIPTIVE' });
  // Gating report with a stamp rejects.
  expect(() => ReportSchema.parse(gatingReport({ stamp: 'DESCRIPTIVE' }))).toThrow();
  // Descriptive report with a verdict rejects.
  expect(() =>
    ReportSchema.parse({ ...descriptive, verdict: 'SHIP' }),
  ).toThrow();
});

test('verdict vocabulary is three-valued', () => {
  expect(() => ReportSchema.parse(gatingReport({ verdict: 'GO' }))).toThrow();
  expect(ReportSchema.parse(gatingReport({ verdict: 'UNDERPOWERED_OR_INVESTIGATE' }))).toBeTruthy();
});

test('provenance carries the observed model SET per arm and singular grader', () => {
  const parsed = ReportSchema.parse(gatingReport());
  expect(parsed.provenance.arms[0].observed_model_set).toEqual(['m']);
  expect(parsed.provenance.grader.model).toBe('claude-opus-5');
});

test('byte-stability rules are pinned constants', () => {
  expect(REPORT_RENDERING).toEqual({
    line_ending: '\n',
    key_order: 'sorted',
    numbers: 'shortest-round-trip',
  });
});

test('supersedes and errata support the amendment chain', () => {
  const superseding = gatingReport({
    verdict: 'SHIP',
    supersedes: 'cmp-0000',
    errata: [{ note: 'adjudication resolved tripwire fire' }],
  });
  expect(ReportSchema.parse(superseding).supersedes).toBe('cmp-0000');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-report.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement the Report schema**

```ts
// src/contracts/campaign/report.ts
import { z } from 'zod';
import { CELL_CLASSES } from './suite.ts';

export const REPORT_VERDICTS = [
  'SHIP',
  'NO_SHIP',
  'UNDERPOWERED_OR_INVESTIGATE',
] as const;

/** Byte-stability contract (parent Report engine): shortest round-trip
 *  doubles, sorted keys, LF line endings. D4's renderer is tested against
 *  these constants. */
export const REPORT_RENDERING = {
  line_ending: '\n',
  key_order: 'sorted',
  numbers: 'shortest-round-trip',
} as const;

export const ReportSchema = z
  .object({
    schema_version: z.literal(1),
    campaign_id: z.string().min(1),
    profile: z.enum(['release_gate_v1', 'descriptive_v1']),
    stamp: z.literal('DESCRIPTIVE').optional(),
    verdict: z.enum(REPORT_VERDICTS).optional(),
    cannot_answer: z
      .array(z.object({ cell: z.string().min(1), mde: z.number().positive() }).strict()),
    comparisons: z.array(
      z
        .object({
          comparison_id: z.string().min(1),
          cells: z.array(
            z
              .object({
                scenario: z.string().min(1),
                class: z.enum(CELL_CLASSES),
                n: z.number().int().nonnegative(),
                delta: z.number().optional(),
                fisher_p: z.number().min(0).max(1).optional(),
                mde: z.number().positive().optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    accounting: z
      .object({
        instrument_errors: z.number().int().nonnegative(),
        indeterminates: z.number().int().nonnegative(),
        replacements: z.number().int().nonnegative(),
        reserve_draws: z.number().int().nonnegative(),
        skew_exclusions: z.number().int().nonnegative(),
        skew_caveats: z.number().int().nonnegative(),
        budget_events: z.number().int().nonnegative(),
        amendments: z.number().int().nonnegative(),
        denominators: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    provenance: z
      .object({
        arms: z.array(
          z
            .object({
              arm: z.string().min(1),
              registered_model: z.string().min(1),
              observed_model_set: z.array(z.string().min(1)),
            })
            .strict(),
        ),
        grader: z
          .object({
            credential: z.string().min(1),
            model: z.string().min(1),
            observed: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    supersedes: z.string().min(1).optional(),
    errata: z.array(z.object({ note: z.string().min(1) }).strict()),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.profile === 'release_gate_v1') {
      if (report.stamp !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stamp'],
          message: 'stamps are descriptive-only; gating reports carry a verdict',
        });
      }
      if (report.verdict === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['verdict'],
          message: 'gating reports require a verdict',
        });
      }
    } else {
      if (report.verdict !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['verdict'],
          message: 'descriptive reports have no verdict slot',
        });
      }
      if (report.stamp === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stamp'],
          message: 'descriptive reports are stamped DESCRIPTIVE',
        });
      }
    }
  });
export type Report = z.infer<typeof ReportSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-report.test.ts`
Expected: PASS. Then `bun run check` green.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/campaign/report.ts test/campaign-contracts-report.test.ts
git commit -m "feat(campaign): kernel D1 Report contract (verdict/stamp iff-rules, byte-stability constants)"
```

---

### Task 8: Credential amendments (quota_pool + key_pool)

**Files:**
- Modify: `src/contracts/credential.ts`
- Test: `test/campaign-contracts-credential.test.ts`

**Interfaces:**
- Consumes: the existing `CredentialSchema` / `parseCredentialsFile` (strict) in `src/contracts/credential.ts`.
- Produces: `quota_pool?` and `key_pool?` on `Credential` — Task 11's `poolKey` reads `quota_pool`; D3's spawn layer consumes `key_pool` via the `KeySelector` type; `quorum check` surfaces violations through the existing `checkCredentials` parse path (no code change needed there — schema refinements surface as parse errors).

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-credential.test.ts
import { expect, test } from 'bun:test';
import {
  CredentialSchema,
  parseCredentialsFile,
} from '../src/contracts/credential.ts';
import { checkCredentials } from '../src/credentials/check.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = {
  model: 'claude-opus-5',
  api: 'anthropic',
  auth: 'api-key',
  api_key_env: 'ANTHROPIC_API_KEY',
  harnesses: ['claude'],
};

test('quota_pool and key_pool are optional additions — existing entries parse unchanged', () => {
  expect(CredentialSchema.parse(BASE)).toMatchObject({ model: 'claude-opus-5' });
});

test('quota_pool accepts pool names and rejects other character sets', () => {
  expect(CredentialSchema.parse({ ...BASE, quota_pool: 'openai_responses' }).quota_pool)
    .toBe('openai_responses');
  expect(() => CredentialSchema.parse({ ...BASE, quota_pool: 'pool|with|pipes' })).toThrow();
});

test('key_pool holds env-var names', () => {
  const pooled = CredentialSchema.parse({
    ...BASE,
    api_key_env: undefined,
    key_pool: ['GRADER_KEY_1', 'GRADER_KEY_2', 'GRADER_KEY_3'],
  });
  expect(pooled.key_pool).toEqual(['GRADER_KEY_1', 'GRADER_KEY_2', 'GRADER_KEY_3']);
});

test('key_pool is mutually exclusive with api_key_env', () => {
  expect(() =>
    CredentialSchema.parse({ ...BASE, key_pool: ['K1', 'K2'] }),
  ).toThrow(/key_pool/);
});

test('key_pool requires auth: api-key', () => {
  expect(() =>
    CredentialSchema.parse({
      ...BASE,
      auth: 'oauth',
      api_key_env: undefined,
      key_pool: ['K1'],
    }),
  ).toThrow(/key_pool/);
});

test('key_pool rejects empty arrays and invalid env names', () => {
  expect(() =>
    CredentialSchema.parse({ ...BASE, api_key_env: undefined, key_pool: [] }),
  ).toThrow();
  expect(() =>
    CredentialSchema.parse({ ...BASE, api_key_env: undefined, key_pool: ['9bad'] }),
  ).toThrow();
});

test('checkCredentials surfaces key_pool violations through the parse path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-check-'));
  const agentsDir = join(dir, 'coding-agents');
  const credPath = join(dir, 'credentials.yaml');
  writeFileSync(
    credPath,
    [
      'bad_pool:',
      '  model: claude-opus-5',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: ANTHROPIC_API_KEY',
      '  key_pool: [K1, K2]',
      '  harnesses: [claude]',
    ].join('\n'),
  );
  const { ok, errors } = checkCredentials(credPath, agentsDir);
  expect(ok).toBe(false);
  expect(errors.join('\n')).toMatch(/key_pool/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-credential.test.ts`
Expected: FAIL — `quota_pool`/`key_pool` rejected by the strict schema.

- [ ] **Step 3: Implement the amendments**

In `src/contracts/credential.ts`, add the regex constant near the others, two fields inside the `CredentialSchema` object, and convert the schema to carry a refinement. The schema currently ends in `.strict()`; chain `.superRefine(...)` after it:

```ts
const QUOTA_POOL_RE = /^[a-z0-9_]+$/;
```

Inside the `CredentialSchema` `z.object({...})` literal, after `labels: CredentialLabelsSchema.optional(),`:

```ts
    // Quota pool key (parent Appendix B): when set, campaigns key admission
    // on this instead of the v1 derivation (base_url ?? name)|api|model.
    quota_pool: z.string().regex(QUOTA_POOL_RE).optional(),
    // Multi-key pool (Decision D-1, proposed parent erratum E4): env-var
    // names selected per child at spawn time. Mutually exclusive with
    // api_key_env; api-key auth only. The pool-level cap is
    // max_concurrency; per-key selection is D3's KeySelector.
    key_pool: z.array(z.string().regex(API_KEY_ENV_RE)).min(1).optional(),
```

Then chain the refinement (keeping `.strict()` first):

```ts
  .strict()
  .superRefine((cred, ctx) => {
    if (cred.key_pool === undefined) return;
    if (cred.api_key_env !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key_pool'],
        message: 'key_pool is mutually exclusive with api_key_env',
      });
    }
    if (cred.auth !== 'api-key') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key_pool'],
        message: 'key_pool requires auth: api-key (no key material to pool otherwise)',
      });
    }
  });
```

Verify the `Credential` type export still compiles (`z.infer` over the refined schema is unchanged at the type level).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-credential.test.ts`
Expected: PASS. Then `bun run check` green (this exercises the whole existing credential test surface — regressions would show here).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/credential.ts test/campaign-contracts-credential.test.ts
git commit -m "feat(campaign): kernel D1 credential amendments — quota_pool + key_pool (Decision D-1, erratum E4)"
```

---

### Task 9: Verdict campaign extension + back-compat baseline

**Files:**
- Modify: `src/contracts/verdict.ts` (add optional `campaign` block to `FinalVerdictSchema`)
- Create: `test/fixtures/verdict-full.json` (the one newly created complete fixture)
- Test: `test/campaign-contracts-verdict.test.ts`

**Interfaces:**
- Consumes: `FinalVerdictSchema` as it exists after Task 8 (unchanged by it).
- Produces: the optional `campaign` identity block on every verdict — D3's spawn layer supplies the five ids at launch; the runner stamps them before the first provider token (parent Identity); readers (dashboard) tolerate absence.

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-verdict.test.ts
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FinalVerdict,
  FinalVerdictSchema,
} from '../src/contracts/verdict.ts';

// Back-compat baseline: the inline shapes the repo already tests (the
// on-disk seats/dashboard fixtures are deliberately partial/legacy and sit
// outside FinalVerdictSchema by design).
test('existing verdict shapes parse unchanged (no campaign block)', () => {
  const v: FinalVerdict = {
    schema: 1,
    final: 'pass',
    final_reason: 'Gauntlet-Agent passed; no deterministic checks',
    gauntlet: { status: 'pass', summary: 's', reasoning: 'r', run_id: 'x_20260529T170857Z_32wy' },
    checks: [
      { check: 'git-repo', args: [], negated: false, passed: true, detail: null, phase: 'pre' },
    ],
    error: null,
    economics: null,
  };
  expect(FinalVerdictSchema.parse(v)).toEqual(v);
});

test('a complete real-world fixture parses', () => {
  const raw = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures', 'verdict-full.json'), 'utf8'),
  );
  const parsed = FinalVerdictSchema.parse(raw);
  expect(parsed.campaign).toEqual({
    campaign_id: 'cmp-0001',
    comparison_id: 'c1',
    block_id: 'b1',
    sample_id: 's1',
    execution_attempt_id: 'a1',
  });
});

test('the campaign block is optional and strictly shaped', () => {
  const base = FinalVerdictSchema.parse({
    schema: 1,
    final: 'fail',
    final_reason: 'checks failed',
    gauntlet: null,
    checks: [],
    error: null,
    economics: null,
  });
  expect(base.campaign).toBeUndefined();
  expect(() =>
    FinalVerdictSchema.parse({
      schema: 1,
      final: 'pass',
      final_reason: 'ok',
      gauntlet: null,
      checks: [],
      error: null,
      economics: null,
      campaign: { campaign_id: 'c' }, // missing the other four ids
    }),
  ).toThrow();
});
```

Fixture content — create `test/fixtures/verdict-full.json`:

```json
{
  "schema": 1,
  "final": "pass",
  "final_reason": "Gauntlet-Agent passed; 4/4 deterministic checks",
  "gauntlet": {
    "status": "pass",
    "summary": "ACs met with evidence",
    "reasoning": "Output verified against fixture expectations",
    "run_id": "cost-checkbox-copilot-linux-20260805T211930Z-e719"
  },
  "checks": [
    { "check": "file-exists", "args": ["out.txt"], "negated": false, "passed": true, "detail": null, "phase": "post" }
  ],
  "error": null,
  "economics": {
    "coding_agent": { "duration_ms": 42000 },
    "gauntlet": { "duration_ms": 75000 }
  },
  "scenario": "cost-checkbox-over-trigger",
  "coding_agent": "copilot",
  "started_at": "2026-08-05T21:19:30Z",
  "finished_at": "2026-08-05T21:22:10Z",
  "credential": "copilot_opus5",
  "os": "linux",
  "provenance": {
    "superpowers_rev": null,
    "superpowers_dirty": null,
    "harness_rev": "f93e95b",
    "agent_cli_version": "0.0.300",
    "gauntlet_version": "0.1.0"
  },
  "campaign": {
    "campaign_id": "cmp-0001",
    "comparison_id": "c1",
    "block_id": "b1",
    "sample_id": "s1",
    "execution_attempt_id": "a1"
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-verdict.test.ts`
Expected: FAIL — `campaign` unknown/stripped (fixture parse mismatch or missing field).

- [ ] **Step 3: Implement the extension**

In `src/contracts/verdict.ts`, add before the closing of the `FinalVerdictSchema` object (after the `provenance` field):

```ts
  // Campaign identity sub-block (parent Identity): stamped by the runner
  // before the first provider token. Optional — legacy runs and the
  // dashboard never carry it.
  campaign: z
    .object({
      campaign_id: z.string().min(1),
      comparison_id: z.string().min(1),
      block_id: z.string().min(1),
      sample_id: z.string().min(1),
      execution_attempt_id: z.string().min(1),
    })
    .strict()
    .optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-verdict.test.ts`
Expected: PASS. Then `bun run check` green.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/verdict.ts test/fixtures/verdict-full.json test/campaign-contracts-verdict.test.ts
git commit -m "feat(campaign): kernel D1 verdict campaign identity block (optional, back-compat baseline)"
```

---

### Task 10: CheckRecord extension + unknown-key fold rule

**Files:**
- Modify: `src/contracts/verdict.ts` (`CheckRecordSchema` gains optional fields)
- Modify: `src/checks/index.ts` (fold rule in `readRecords`)
- Test: `test/campaign-contracts-check-record.test.ts`

**Interfaces:**
- Consumes: `CheckRecordSchema` (verdict.ts) and `readRecords`/`SinkRecordSchema` (`src/checks/index.ts:24,200-217`).
- Produces: extended collected records flowing to the composer and (later) D4's declared-metric aggregation; the fold rule keeps unknown emitter keys visible instead of silently stripped.

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-check-record.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckRecordSchema } from '../src/contracts/verdict.ts';

// readRecords is module-private; drive it through runPhase's public surface
// is too heavy for a contract test, so this suite covers the schema half
// and the fold half via the exported fold helper (implemented in step 3).
import { foldUnknownKeys } from '../src/checks/record-fold.ts';

test('CheckRecord keeps its base shape and gains optional extensions', () => {
  const base = {
    check: 'file-contains',
    args: ['out.txt', 'done'],
    negated: false,
    passed: true,
    detail: null,
    phase: 'post',
  };
  expect(CheckRecordSchema.parse(base)).toEqual(base);
  const extended = {
    ...base,
    score: 0.92,
    metrics: { latency_ms: 120 },
    tags: ['smoke'],
    notes: 'borderline',
  };
  expect(CheckRecordSchema.parse(extended)).toEqual(extended);
});

test('unknown keys fold into detail with the pinned format', () => {
  const folded = foldUnknownKeys({
    check: 'custom-verb',
    args: [],
    negated: false,
    passed: true,
    detail: null,
    phase: 'post',
    verbosity: 3,
    note: 'ad hoc',
  });
  expect(folded.detail).toBe('folded: note=ad hoc; verbosity=3');
  expect('verbosity' in folded).toBe(false);
  expect('note' in folded).toBe(false);
});

test('fold appends after an existing detail with a separator', () => {
  const folded = foldUnknownKeys({
    check: 'c',
    args: [],
    negated: false,
    passed: false,
    detail: 'original',
    extra: 'x',
  });
  expect(folded.detail).toBe('original | folded: extra=x');
});

test('no unknown keys means untouched output', () => {
  const record = { check: 'c', args: [], negated: false, passed: true, detail: null, phase: 'pre' };
  expect(foldUnknownKeys(record)).toBe(record); // same reference, no copy
});

test('folded non-string values serialize as JSON', () => {
  const folded = foldUnknownKeys({ check: 'c', args: [], negated: false, passed: true, detail: null, cfg: { a: 1 } });
  expect(folded.detail).toBe('folded: cfg={"a":1}');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-check-record.test.ts`
Expected: FAIL — `foldUnknownKeys` missing; extension fields stripped/rejected.

- [ ] **Step 3: Implement**

In `src/contracts/verdict.ts`, extend `CheckRecordSchema` (add inside the object, before the closing brace):

```ts
  // smevals-style check-result extensions (parent Checks): optional runtime
  // values; manifests pin identity fields only, so expected-check matching
  // is unaffected.
  score: z.number().optional(),
  metrics: z.record(z.string(), z.number()).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
```

Create `src/checks/record-fold.ts`:

```ts
// Write-side fold rule (parent Checks): unknown keys on an emitted check
// record fold into `detail` instead of being silently stripped by the zod
// parse. Implemented, not a zod default. Folded pairs render `key=value`
// (non-string values JSON-serialized), sorted by key, joined by `; `,
// appended after an existing detail with a ` | ` separator.

const KNOWN_RECORD_KEYS: ReadonlySet<string> = new Set([
  'check',
  'args',
  'negated',
  'passed',
  'detail',
  'phase',
  'score',
  'metrics',
  'tags',
  'notes',
]);

export function foldUnknownKeys(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const unknown = Object.keys(raw)
    .filter((key) => !KNOWN_RECORD_KEYS.has(key))
    .sort();
  if (unknown.length === 0) return raw;
  const foldedText = unknown
    .map((key) => {
      const value = raw[key];
      return `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`;
    })
    .join('; ');
  const existing = typeof raw['detail'] === 'string' && raw['detail'] !== ''
    ? raw['detail']
    : null;
  const detail = existing === null ? `folded: ${foldedText}` : `${existing} | folded: ${foldedText}`;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (KNOWN_RECORD_KEYS.has(key)) out[key] = raw[key];
  }
  out['detail'] = detail;
  return out;
}
```

In `src/checks/index.ts`, update `readRecords` (line ~213) to fold before parsing:

```ts
import { foldUnknownKeys } from './record-fold.ts';
```

and inside the loop:

```ts
    const parsed = SinkRecordSchema.parse(
      foldUnknownKeys(JSON.parse(line) as Record<string, unknown>),
    );
```

(`SinkRecordSchema` is `CheckRecordSchema.omit({ phase: true })` — the omit picks up the new optional fields automatically. The fold's `phase` passthrough is harmless here because `readRecords` injects `phase` itself after the parse.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-check-record.test.ts`
Expected: PASS. Then `bun run check` green (the manifest/composer suites exercise `readRecords` — no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/verdict.ts src/checks/record-fold.ts src/checks/index.ts test/campaign-contracts-check-record.test.ts
git commit -m "feat(campaign): kernel D1 CheckRecord extensions (score/metrics/tags/notes) + unknown-key fold rule"
```

---

### Task 11: poolKey, KeySelector, and hermetic golden fixtures

**Files:**
- Create: `src/contracts/campaign/pool.ts`
- Create: `test/fixtures/gate-era-credentials-64b99fc.yaml` (extracted, see step 1)
- Test: `test/campaign-contracts-pool.test.ts`

**Interfaces:**
- Consumes: `Credential` type (`src/contracts/credential.ts`, after Task 8); `parseCredentialsFile`; the committed gate replay manifest `src/campaign/replay-manifest.gate-20260808.json`.
- Produces: `poolKey(cred, name): string` — D3 admission and registration key pools on it (legacy `limiterKey` untouched); `KeySelector` type + `KeyGrant` — D3 implements selection.

- [ ] **Step 1: Extract the hermetic fixture and write the failing tests**

Extract the gate-era credential registry (the snapshot Phase 0's curation used; `git cat-file -e` verifies the rev exists first):

```bash
git cat-file -e 64b99fc^{commit} && git show 64b99fc:credentials.yaml > test/fixtures/gate-era-credentials-64b99fc.yaml
grep -q 'opus_bedrock:' test/fixtures/gate-era-credentials-64b99fc.yaml
```

```ts
// test/campaign-contracts-pool.test.ts
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseCredentialsFile } from '../src/contracts/credential.ts';
import { poolKey } from '../src/contracts/campaign/pool.ts';

test('v1 derivation: quota_pool, else (base_url ?? name)|api|model', () => {
  const base = {
    model: 'gpt-5.6-sol',
    api: 'openai-responses',
    base_url: 'https://api.openai.com/v1',
    auth: 'api-key',
    api_key_env: 'OPENAI_API_KEY',
    harnesses: ['codex'],
  } as const;
  expect(poolKey({ ...base }, 'openai_responses_56sol')).toBe(
    'https://api.openai.com/v1|openai-responses|gpt-5.6-sol',
  );
  expect(poolKey({ ...base, quota_pool: 'shared_bucket' }, 'whatever')).toBe(
    'shared_bucket',
  );
  // Name fallback when there is no base_url (native endpoints).
  expect(poolKey(
    { model: 'anthropic.claude-opus-4-8', api: 'mantle', auth: 'bedrock-bearer', harnesses: ['claude'] } as never,
    'opus_bedrock',
  )).toBe('opus_bedrock|mantle|anthropic.claude-opus-4-8');
});

test('golden fixtures: the function reproduces the gate manifest pool IDs', () => {
  // Hermetic on both sides: the gate-era credential snapshot (frozen rev
  // 64b99fc) and the committed Phase 0 manifest. Never recomputed from
  // today's credentials.yaml (Phase 0 plan's rule).
  const snapshot = parseCredentialsFile(
    parseYaml(readFileSync(join(import.meta.dir, 'fixtures', 'gate-era-credentials-64b99fc.yaml'), 'utf8')),
  );
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'src', 'campaign', 'replay-manifest.gate-20260808.json'), 'utf8'),
  ) as { comparisons: { credential: string; pool_id: string }[] };
  expect(manifest.comparisons.length).toBeGreaterThanOrEqual(4);
  for (const comparison of manifest.comparisons) {
    const cred = snapshot[comparison.credential];
    expect(cred).toBeDefined();
    if (cred !== undefined) {
      expect(poolKey(cred, comparison.credential)).toBe(comparison.pool_id);
    }
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-pool.test.ts`
Expected: FAIL — `poolKey` missing.

- [ ] **Step 3: Implement**

```ts
// src/contracts/campaign/pool.ts
import type { Credential } from '../credential.ts';

/** The campaign v1 quota-pool derivation (parent Execution): per-model
 *  splitting without merging distinct endpoints or orgs; the explicit
 *  quota_pool key covers entries genuinely sharing one provider bucket.
 *  Legacy run-all keeps limiterKey — the two derivations coexist until
 *  run-all retirement is decided. */
export function poolKey(cred: Credential, name: string): string {
  return cred.quota_pool ?? `${cred.base_url ?? name}|${cred.api}|${cred.model}`;
}

/** Key selection is a spawn-time concern strictly below admission
 *  (Decision D-1). D3 implements it; D1 pins the contract. */
export interface KeyGrant {
  readonly envName: string;
}

export type KeySelector = (
  cred: Credential,
  inFlight: Readonly<Record<string, number>>,
) => { kind: 'use'; grant: KeyGrant } | { kind: 'wait' };

// Authority relationship (pinned): the pool-level admission cap is
// authoritative. Since len(keys) * ceil(cap / len(keys)) >= cap, `wait` is
// unreachable under honest admission and guards miscalibration and recovery
// rebuild only. Resolution must fail loud for key_pool credentials lacking a
// grant — the harness-conventional-env fallback is forbidden for them.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-pool.test.ts`
Expected: PASS. Then `bun run check` green.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/campaign/pool.ts test/fixtures/gate-era-credentials-64b99fc.yaml test/campaign-contracts-pool.test.ts
git commit -m "feat(campaign): kernel D1 poolKey (v1 derivation) + KeySelector contract, hermetic gate-era golden fixtures"
```

---

### Task 12: Profile parameter registry

**Files:**
- Create: `src/contracts/campaign/profile-params.ts`
- Test: `test/campaign-contracts-profile-params.test.ts`

**Interfaces:**
- Consumes: zod only.
- Produces: `ReleaseGateV1ParamsSchema`, `DescriptiveV1ParamsSchema`, `PROFILE_PARAM_SCHEMAS`, `profileParamsSchema(name)` — Task 14 validates suite `profile_params` through the registry; D4's profile evaluation modules consume the same schemas.

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-profile-params.test.ts
import { expect, test } from 'bun:test';
import {
  PROFILE_PARAM_SCHEMAS,
  ReleaseGateV1ParamsSchema,
  profileParamsSchema,
} from '../src/contracts/campaign/profile-params.ts';

const VALID = {
  alpha: 0.05,
  determinate_n_floor: 4,
  completion_divergence_max: 0.2,
  mde_by_scenario: { 'sdd-escalates': 0.15, 'fractals-smoke': 0.2 },
};

test('release_gate_v1 parameters (alphas, floors, deltas) validate', () => {
  expect(ReleaseGateV1ParamsSchema.parse(VALID)).toEqual(VALID);
});

test('parameter ranges are enforced', () => {
  expect(() => ReleaseGateV1ParamsSchema.parse({ ...VALID, alpha: 1 })).toThrow();
  expect(() => ReleaseGateV1ParamsSchema.parse({ ...VALID, alpha: 0 })).toThrow();
  expect(() => ReleaseGateV1ParamsSchema.parse({ ...VALID, determinate_n_floor: 0 })).toThrow();
  expect(() => ReleaseGateV1ParamsSchema.parse({ ...VALID, completion_divergence_max: 1.5 })).toThrow();
  expect(() => ReleaseGateV1ParamsSchema.parse({ ...VALID, mde_by_scenario: { s: -1 } })).toThrow();
});

test('the registry is a frozen built-in map, not a mutable global', () => {
  expect(Object.isFrozen(PROFILE_PARAM_SCHEMAS)).toBe(true);
  expect(profileParamsSchema('release_gate_v1')).toBe(ReleaseGateV1ParamsSchema);
  expect(profileParamsSchema('descriptive_v1')).toBeDefined();
  expect(profileParamsSchema('invented_v9')).toBeUndefined();
});

test('descriptive_v1 takes no parameters', () => {
  expect(profileParamsSchema('descriptive_v1')?.parse({})).toEqual({});
  expect(() => profileParamsSchema('descriptive_v1')?.parse({ alpha: 0.1 })).toThrow();
});

test('unknown parameter keys reject (strict)', () => {
  expect(() => ReleaseGateV1ParamsSchema.parse({ ...VALID, p_hacking: true })).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-profile-params.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

```ts
// src/contracts/campaign/profile-params.ts
// Profile parameter schemas (parent Decision profiles: "Suites bind a
// profile and its declared numeric parameters (alphas, floors, deltas)").
// The registry is a frozen built-in map: no mutable global registration —
// growing the profile list or a profile's vocabulary is a platform PR
// editing this file, never a campaign-time extension.

import { z } from 'zod';

export const ReleaseGateV1ParamsSchema = z
  .object({
    // Per-cell two-sided significance level for confirmatory cells.
    alpha: z.number().gt(0).lt(1),
    // Determinate-n floor per confirmatory cell (below floor reads
    // UNDERPOWERED and joins the cannot-answer list).
    determinate_n_floor: z.number().int().positive(),
    // The 08-08 completion-collapse tripwire threshold: cross-arm
    // completion divergence beyond this fires the tripwire family.
    completion_divergence_max: z.number().gt(0).lte(1),
    // Pre-registered minimum-detectable-effect per scenario carrying
    // confirmatory cells ("deltas") — rendered on every SHIP.
    mde_by_scenario: z.record(z.string(), z.number().positive()),
  })
  .strict();
export type ReleaseGateV1Params = z.infer<typeof ReleaseGateV1ParamsSchema>;

export const DescriptiveV1ParamsSchema = z.object({}).strict();
export type DescriptiveV1Params = z.infer<typeof DescriptiveV1ParamsSchema>;

export const PROFILE_PARAM_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> =
  Object.freeze({
    release_gate_v1: ReleaseGateV1ParamsSchema,
    descriptive_v1: DescriptiveV1ParamsSchema,
  });

export function profileParamsSchema(profile: string): z.ZodTypeAny | undefined {
  return PROFILE_PARAM_SCHEMAS[profile];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-profile-params.test.ts`
Expected: PASS. Then `bun run check` green.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/campaign/profile-params.ts test/campaign-contracts-profile-params.test.ts
git commit -m "feat(campaign): kernel D1 profile parameter registry (release_gate_v1 alphas/floors/deltas, frozen map)"
```

---

### Task 13: Scenario frontmatter + static scan

**Files:**
- Create: `src/contracts/campaign/scenario-meta.ts`
- Modify: `src/story-meta.ts` (two new readers following the existing pattern)
- Test: `test/campaign-contracts-scenario-meta.test.ts`

**Interfaces:**
- Consumes: the lenient frontmatter machinery in `src/story-meta.ts` (private `frontmatter()` + `StoryMetaError`).
- Produces: `COUPLING_CLASSES`, `ScenarioMetaSchema`, `scanCouplingDefault(scenarioDir)`, `readRequiresSuperpowers(storyPath)`, `readCoupling(storyPath)` — Task 14 wires them into `quorum check`; D2/D3 eligibility filters consume the values.

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-scenario-meta.test.ts
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryMetaError } from '../src/story-meta.ts';
import { readCoupling, readRequiresSuperpowers } from '../src/story-meta.ts';
import {
  scanCouplingDefault,
  ScenarioMetaSchema,
} from '../src/contracts/campaign/scenario-meta.ts';

function scenario(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-meta-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

test('frontmatter readers: requires_superpowers and coupling', () => {
  const dir = scenario({
    'story.md': '---\nrequires_superpowers: true\ncoupling: pins-skill-names\n---\nBody.',
  });
  expect(readRequiresSuperpowers(join(dir, 'story.md'))).toBe(true);
  expect(readCoupling(join(dir, 'story.md'))).toBe('pins-skill-names');
});

test('absent frontmatter yields null (scan defaults apply downstream)', () => {
  const dir = scenario({ 'story.md': 'No frontmatter here.' });
  expect(readRequiresSuperpowers(join(dir, 'story.md'))).toBeNull();
  expect(readCoupling(join(dir, 'story.md'))).toBeNull();
});

test('malformed values throw StoryMetaError', () => {
  const dir = scenario({
    'story.md': '---\nrequires_superpowers: maybe\ncoupling: sideways\n---\nBody.',
  });
  expect(() => readRequiresSuperpowers(join(dir, 'story.md'))).toThrow(StoryMetaError);
  expect(() => readCoupling(join(dir, 'story.md'))).toThrow(StoryMetaError);
});

test('scan: skill path shapes pin skill names', () => {
  const dir = scenario({
    'story.md': 'Use skills/test-driven-development/SKILL.md discipline.',
    'checks.sh': 'pre() { :; }',
  });
  expect(scanCouplingDefault(dir)).toBe('pins-skill-names');
  const superpowersRef = scenario({
    'story.md': 'Invoke superpowers:brainstorming before coding.',
    'checks.sh': 'pre() { :; }',
  });
  expect(scanCouplingDefault(superpowersRef)).toBe('pins-skill-names');
});

test('scan: skill-shaped fixture files embed skill fixtures', () => {
  const dir = scenario({
    'story.md': 'Plain story.',
    'checks.sh': 'pre() { :; }',
    'fixtures/skills/writing-plans/plan.md': 'fixture body',
  });
  mkdirSync(join(dir, 'fixtures/skills/writing-plans'), { recursive: true });
  writeFileSync(join(dir, 'fixtures/skills/writing-plans/plan.md'), 'fixture body');
  expect(scanCouplingDefault(dir)).toBe('embeds-skill-fixtures');
});

test('scan: neither signal is arm-independent', () => {
  const dir = scenario({
    'story.md': 'Plain story.',
    'setup.sh': '#!/usr/bin/env bash\n:\n',
    'checks.sh': 'pre() { :; }',
  });
  chmodSync(join(dir, 'setup.sh'), 0o755);
  expect(scanCouplingDefault(dir)).toBe('arm-independent');
});

test('the schema validates the resolved pair', () => {
  expect(
    ScenarioMetaSchema.parse({ requires_superpowers: false, coupling: 'arm-independent' }),
  ).toBeTruthy();
  expect(() =>
    ScenarioMetaSchema.parse({ requires_superpowers: false, coupling: 'nope' }),
  ).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-scenario-meta.test.ts`
Expected: FAIL — readers and scan missing.

- [ ] **Step 3: Implement the readers**

Append to `src/story-meta.ts` (following the `readQuorumTier` pattern):

```ts
/** The story's `requires_superpowers`, or `null` when omitted (the scan
 *  default applies downstream). Throws {@link StoryMetaError} outside
 *  true/false. */
export function readRequiresSuperpowers(storyPath: string): boolean | null {
  const v = frontmatter(storyPath).get('requires_superpowers');
  if (v === undefined) return null;
  if (v !== 'true' && v !== 'false') {
    throw new StoryMetaError(`invalid requires_superpowers: ${v}`);
  }
  return v === 'true';
}

export const COUPLING_VALUES = [
  'pins-skill-names',
  'embeds-skill-fixtures',
  'arm-independent',
] as const;
export type CouplingValue = (typeof COUPLING_VALUES)[number];

/** The story's `coupling` override, or `null` when omitted. Throws
 *  {@link StoryMetaError} outside the closed vocabulary. */
export function readCoupling(storyPath: string): CouplingValue | null {
  const v = frontmatter(storyPath).get('coupling');
  if (v === undefined) return null;
  if (
    v !== 'pins-skill-names' &&
    v !== 'embeds-skill-fixtures' &&
    v !== 'arm-independent'
  ) {
    throw new StoryMetaError(`invalid coupling: ${v}`);
  }
  return v;
}
```

- [ ] **Step 4: Implement the schema + static scan**

```ts
// src/contracts/campaign/scenario-meta.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const COUPLING_CLASSES = [
  'pins-skill-names',
  'embeds-skill-fixtures',
  'arm-independent',
] as const;

export const ScenarioMetaSchema = z
  .object({
    requires_superpowers: z.boolean(),
    coupling: z.enum(COUPLING_CLASSES),
  })
  .strict();
export type ScenarioMeta = z.infer<typeof ScenarioMetaSchema>;

// Path-shaped heuristics (pinned): no skill inventory, no SUPERPOWERS_ROOT —
// quorum check must not need either. Conservative: committed frontmatter
// always wins over the scan.
const SKILL_REF_RE = /skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md|superpowers:[a-z0-9][a-z0-9-]*/;
const SKILL_FIXTURE_RE = /^skills$/;

function reads(dir: string, name: string): string {
  const path = join(dir, name);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

/** Default coupling class for a scenario dir: skill-shaped references in
 *  story/setup/checks pin skill names; skill-shaped fixture subtrees embed
 *  skill fixtures; neither is arm-independent. */
export function scanCouplingDefault(
  scenarioDir: string,
): (typeof COUPLING_CLASSES)[number] {
  const text =
    reads(scenarioDir, 'story.md') +
    reads(scenarioDir, 'setup.sh') +
    reads(scenarioDir, 'checks.sh');
  if (SKILL_REF_RE.test(text)) return 'pins-skill-names';

  const fixturesDir = join(scenarioDir, 'fixtures');
  if (existsSync(fixturesDir) && statSync(fixturesDir).isDirectory()) {
    for (const entry of readdirSync(fixturesDir)) {
      if (SKILL_FIXTURE_RE.test(entry) && statSync(join(fixturesDir, entry)).isDirectory()) {
        return 'embeds-skill-fixtures';
      }
    }
  }
  return 'arm-independent';
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-scenario-meta.test.ts`
Expected: PASS. Then `bun run check` green.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/campaign/scenario-meta.ts src/story-meta.ts test/campaign-contracts-scenario-meta.test.ts
git commit -m "feat(campaign): kernel D1 scenario frontmatter (requires_superpowers, coupling) + inventory-free static scan"
```

---

### Task 14: quorum check — arm/suite discovery and validation

**Files:**
- Create: `src/campaign/arm-suite-check.ts`
- Modify: `src/cli/index.ts` (the `check` command action wires the new validation after scenario checks)
- Test: `test/campaign-contracts-arm-suite-check.test.ts`

**Interfaces:**
- Consumes: `ArmSchema`, `SuiteSchema` (Task 1), `profileParamsSchema` (Task 12), `readCoupling`/`readRequiresSuperpowers`/`scanCouplingDefault` (Task 13), `parseCredentialsFile` (`src/contracts/credential.ts`), `loadAgentConfigForValidation` (`src/contracts/agent-config.ts`).
- Produces: `checkArmSuiteFiles(opts): { ok, errors, warnings }` — D3 registration reuses the same validators when it reads suites.

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-arm-suite-check.test.ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkArmSuiteFiles } from '../src/campaign/arm-suite-check.ts';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'arm-suite-check-'));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

const AGENT_YAML = 'runtime_family: claude\ndefault_credential: opus_fx\n';
const CREDENTIALS = [
  'opus_fx:',
  '  model: claude-opus-5',
  '  api: anthropic',
  '  auth: api-key',
  '  api_key_env: ANTHROPIC_API_KEY',
  '  harnesses: [claude]',
].join('\n');
const ARM = [
  'schema_version: 1',
  'name: claude_fx',
  'agent: claude',
  'credential: opus_fx',
  'superpowers: none',
].join('\n');
const SUITE = [
  'schema_version: 1',
  'name: compare_fx',
  'kind: exploratory',
  'budget_usd: 50',
  'comparisons:',
  '  - baseline: claude_fx',
  '    treatment: claude_fx',
  '    scenarios: [scn_a]',
  '    n: 1',
].join('\n');

test('missing arms/ and suites/ directories are tolerated (v1 has none yet)', () => {
  const root = repo({});
  const result = checkArmSuiteFiles({
    repoRoot: root,
    codingAgentsDir: join(root, 'coding-agents'),
    credentialsPath: join(root, 'credentials.yaml'),
    scenariosRoot: join(root, 'scenarios'),
  });
  expect(result).toEqual({ ok: true, errors: [], warnings: [] });
});

test('valid arm + suite files cross-reference cleanly', () => {
  const root = repo({
    'arms/claude_fx.yaml': ARM,
    'suites/compare_fx.yaml': SUITE,
    'coding-agents/claude.yaml': AGENT_YAML,
    'credentials.yaml': CREDENTIALS,
  });
  const result = checkArmSuiteFiles({
    repoRoot: root,
    codingAgentsDir: join(root, 'coding-agents'),
    credentialsPath: join(root, 'credentials.yaml'),
    scenariosRoot: join(root, 'scenarios'),
  });
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});

test('arm cross-references fail loud', () => {
  const root = repo({
    'arms/bad.yaml': ARM.replace('agent: claude', 'agent: ghost').replace('credential: opus_fx', 'credential: ghost_cred'),
    'coding-agents/claude.yaml': AGENT_YAML,
    'credentials.yaml': CREDENTIALS,
  });
  const result = checkArmSuiteFiles({
    repoRoot: root,
    codingAgentsDir: join(root, 'coding-agents'),
    credentialsPath: join(root, 'credentials.yaml'),
    scenariosRoot: join(root, 'scenarios'),
  });
  expect(result.ok).toBe(false);
  expect(result.errors.join('\n')).toMatch(/ghost/);
  expect(result.errors.join('\n')).toMatch(/ghost_cred/);
});

test('suite schema errors surface with the file name', () => {
  const root = repo({
    'suites/broken.yaml': SUITE.replace('budget_usd: 50', 'budget_usd: -5'),
  });
  const result = checkArmSuiteFiles({
    repoRoot: root,
    codingAgentsDir: join(root, 'coding-agents'),
    credentialsPath: join(root, 'credentials.yaml'),
    scenariosRoot: join(root, 'scenarios'),
  });
  expect(result.ok).toBe(false);
  expect(result.errors.join('\n')).toMatch(/broken\.yaml/);
});

test('gating suite profile params validate against the registry', () => {
  const gating = [
    'schema_version: 1',
    'name: gate_fx',
    'kind: gating',
    'budget_usd: 850',
    'profile: release_gate_v1',
    'reserve: 2',
    'max_exposure_skew: 600',
    'profile_params:',
    '  alpha: 0.05',
    '  determinate_n_floor: 4',
    '  completion_divergence_max: 0.2',
    '  mde_by_scenario: { scn_a: 0.15 }',
    'comparisons:',
    '  - baseline: claude_fx',
    '    treatment: claude_fx',
    '    scenarios: [scn_a]',
    '    n: 5',
    '    cells: { scn_a: { class: confirmatory } }',
  ].join('\n');
  const root = repo({ 'suites/gate_fx.yaml': gating });
  const okResult = checkArmSuiteFiles({
    repoRoot: root,
    codingAgentsDir: join(root, 'coding-agents'),
    credentialsPath: join(root, 'credentials.yaml'),
    scenariosRoot: join(root, 'scenarios'),
  });
  expect(okResult.errors).toEqual([]);
  const badParams = gating.replace('alpha: 0.05', 'alpha: 2');
  const badRoot = repo({ 'suites/gate_fx.yaml': badParams });
  const badResult = checkArmSuiteFiles({
    repoRoot: badRoot,
    codingAgentsDir: join(root, 'coding-agents'),
    credentialsPath: join(root, 'credentials.yaml'),
    scenariosRoot: join(root, 'scenarios'),
  });
  expect(badResult.ok).toBe(false);
  expect(badResult.errors.join('\n')).toMatch(/alpha/);
});

test('frontmatter overrides contradicting the scan warn (not error)', () => {
  const root = repo({
    'suites/compare_fx.yaml': SUITE,
    'scenarios/scn_a/story.md':
      '---\ncoupling: pins-skill-names\n---\nPlain story with no skill refs.',
    'scenarios/scn_a/checks.sh': 'pre() { :; }\npost() { :; }\n',
  });
  const result = checkArmSuiteFiles({
    repoRoot: root,
    codingAgentsDir: join(root, 'coding-agents'),
    credentialsPath: join(root, 'credentials.yaml'),
    scenariosRoot: join(root, 'scenarios'),
  });
  expect(result.ok).toBe(true);
  expect(result.warnings.join('\n')).toMatch(/scn_a.*coupling|coupling.*scn_a/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-arm-suite-check.test.ts`
Expected: FAIL — `checkArmSuiteFiles` missing.

- [ ] **Step 3: Implement**

```ts
// src/campaign/arm-suite-check.ts
// quorum check's arm/suite validation (parent Testing: "quorum check
// validates arm and suite files including profile parameters"). Discovery:
// arms/ and suites/ at the repo root (parent Concepts examples); missing
// dirs are tolerated — v1 ships no documents yet.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadAgentConfigForValidation } from '../contracts/agent-config.ts';
import { ArmSchema } from '../contracts/campaign/arm.ts';
import { profileParamsSchema } from '../contracts/campaign/profile-params.ts';
import { scanCouplingDefault } from '../contracts/campaign/scenario-meta.ts';
import { SuiteSchema } from '../contracts/campaign/suite.ts';
import { parseCredentialsFile } from '../contracts/credential.ts';
import { readCoupling } from '../story-meta.ts';

export interface ArmSuiteCheckOptions {
  readonly repoRoot: string;
  readonly codingAgentsDir: string;
  readonly credentialsPath: string;
  readonly scenariosRoot: string;
}

export interface ArmSuiteCheckResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort();
}

export function checkArmSuiteFiles(
  opts: ArmSuiteCheckOptions,
): ArmSuiteCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const credentialNames = new Set<string>();
  if (existsSync(opts.credentialsPath)) {
    try {
      const parsed = parseCredentialsFile(
        parseYaml(readFileSync(opts.credentialsPath, 'utf8')),
      );
      for (const name of Object.keys(parsed)) credentialNames.add(name);
    } catch (err) {
      errors.push(
        `credentials file error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const armNames = new Set<string>();
  for (const file of yamlFiles(join(opts.repoRoot, 'arms'))) {
    const path = join(opts.repoRoot, 'arms', file);
    let arm;
    try {
      arm = ArmSchema.parse(parseYaml(readFileSync(path, 'utf8')));
    } catch (err) {
      errors.push(`arms/${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    armNames.add(arm.name);
    try {
      loadAgentConfigForValidation(opts.codingAgentsDir, arm.agent);
    } catch {
      errors.push(`arms/${file}: agent '${arm.agent}' has no coding-agents/${arm.agent}.yaml`);
    }
    if (!credentialNames.has(arm.credential)) {
      errors.push(`arms/${file}: credential '${arm.credential}' not in credentials.yaml`);
    }
  }

  for (const file of yamlFiles(join(opts.repoRoot, 'suites'))) {
    const path = join(opts.repoRoot, 'suites', file);
    let suite;
    try {
      suite = SuiteSchema.parse(parseYaml(readFileSync(path, 'utf8')));
    } catch (err) {
      errors.push(`suites/${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (suite.profile !== undefined && suite.profile_params !== undefined) {
      const schema = profileParamsSchema(suite.profile);
      if (schema === undefined) {
        errors.push(`suites/${file}: unknown profile '${suite.profile}'`);
      } else {
        const result = schema.safeParse(suite.profile_params);
        if (!result.success) {
          errors.push(
            `suites/${file}: profile_params for ${suite.profile}: ${result.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')}`,
          );
        }
      }
    }
    for (const comparison of suite.comparisons) {
      const refs = 'arm' in comparison ? [comparison.arm] : [comparison.baseline, comparison.treatment];
      for (const ref of refs) {
        if (armNames.size > 0 && !armNames.has(ref)) {
          errors.push(`suites/${file}: comparison references unknown arm '${ref}'`);
        }
      }
      // Frontmatter-vs-scan contradiction warnings for explicit scenario
      // lists (tier selectors expand at registration, D3).
      if (Array.isArray(comparison.scenarios)) {
        for (const scenarioName of comparison.scenarios) {
          const scenarioDir = join(opts.scenariosRoot, scenarioName);
          const storyPath = join(scenarioDir, 'story.md');
          if (!existsSync(storyPath)) continue;
          let declared;
          try {
            declared = readCoupling(storyPath);
          } catch {
            continue; // malformed frontmatter is scenario validation's job
          }
          if (declared !== null && declared !== scanCouplingDefault(scenarioDir)) {
            warnings.push(
              `scenarios/${scenarioName}: declared coupling '${declared}' contradicts the static scan default`,
            );
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
```

Wire into the `check` command in `src/cli/index.ts`. The action aggregates via a `let failed = 0` counter: each failing section does `failed += 1`, prints `FAIL <section>` plus `  - <problem>` bullets, and passing sections print `ok   <section>` (see the `checkCredentials` block for the exact pattern). Add the import:

```ts
import { checkArmSuiteFiles } from '../campaign/arm-suite-check.ts';
```

and insert immediately after the credentials block, following its shape verbatim:

```ts
      // Validate arms/ and suites/ documents (parent Testing: "quorum check
      // validates arm and suite files including profile parameters").
      const armSuite = checkArmSuiteFiles({
        repoRoot: process.cwd(),
        codingAgentsDir: resolve(opts.codingAgentsDir),
        credentialsPath: resolve(opts.credentialsFile ?? 'credentials.yaml'),
        scenariosRoot: root,
      });
      for (const warning of armSuite.warnings) {
        process.stdout.write(`warn ${warning}\n`);
      }
      if (!armSuite.ok) {
        failed += 1;
        process.stdout.write('FAIL arms/suites\n');
        for (const err of armSuite.errors) {
          process.stdout.write(`  - ${err}\n`);
        }
      } else {
        process.stdout.write('ok   arms/suites\n');
      }
```

The existing exit-code decision at the end of the action already keys off `failed`; no change there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-arm-suite-check.test.ts`
Expected: PASS. Then `bun run check` green, and `bun run quorum check` still green on the real repo (arms/ and suites/ absent → tolerated).

- [ ] **Step 5: Commit**

```bash
git add src/campaign/arm-suite-check.ts src/cli/index.ts test/campaign-contracts-arm-suite-check.test.ts
git commit -m "feat(campaign): kernel D1 quorum check validates arms/ + suites/ (cross-refs, profile params, scan warnings)"
```

---

### Task 15: run_allocated protocol seam

**Files:**
- Modify: `src/cli/run-command.ts` (emit the protocol line in the `onRunDir` handler)
- Test: `test/campaign-contracts-run-allocated.test.ts` (format + parser tolerance)
- Test: modify `test/cli-run.test.ts` (real-CLI emission ordering)

**Interfaces:**
- Consumes: the existing `onRunDir` seam (`src/runner/index.ts:409`, fired immediately after `allocateRunDir`), `runId(runDir)` in `src/cli/run-command.ts`, `spawnCollectRunId` (`src/run-all/index.ts:110`) for the parser-tolerance test.
- Produces: the machine-facing `run_allocated: <run_id>` line on `quorum run` stdout at allocation time — D3's dispatcher correlates by launch identity and journals `run_allocated(attempt, run_id, pgid)` (the pgid is the dispatcher's, never the runner's).

- [ ] **Step 1: Write the failing tests**

```ts
// test/campaign-contracts-run-allocated.test.ts
import { expect, test } from 'bun:test';
import { spawnCollectRunId } from '../src/run-all/index.ts';
import { runAllocatedLine } from '../src/cli/run-command.ts';

const RUN_DIR = 'results/scn-claude-linux-20260824T120000Z-ab12';

test('the protocol line carries the run-id minted at allocation', () => {
  expect(runAllocatedLine(RUN_DIR)).toBe(
    'run_allocated: scn-claude-linux-20260824T120000Z-ab12\n',
  );
});

test('run-all\'s run-id collection tolerates the allocation line (hermetic printf child)', () => {
  // The parent-pinned protocol is additive: existing parsers scan for the
  // 'run-id: ' prefix and must be unaffected by the earlier machine line.
  // spawnCollectRunId args: {command, args, env, timeoutSeconds?, onPid?,
  // onStderr?} (src/run-all/index.ts); ChildResult is
  // {run_id, exit_code, error}.
  return spawnCollectRunId({
    command: 'printf',
    args: [
      'run_allocated: scn-claude-linux-20260824T120000Z-ab12\nrun-id: scn-claude-linux-20260824T120000Z-ab12\n',
    ],
    env: process.env,
  }).then((child) => {
    expect(child.run_id).toBe('scn-claude-linux-20260824T120000Z-ab12');
  });
});
```

Append to `test/cli-run.test.ts` (inside the existing file, using its `runCli` helper):

```ts
test('quorum run emits run_allocated before the exit run-id line', () => {
  const { status, stdout } = runCli('pass');
  expect(status).toBe(0);
  const lines = stdout.split('\n');
  const allocatedIndex = lines.findIndex((l) => l.startsWith('run_allocated: '));
  const runIdIndex = lines.findIndex((l) => l.startsWith('run-id:'));
  expect(allocatedIndex).toBeGreaterThanOrEqual(0);
  expect(runIdIndex).toBeGreaterThan(allocatedIndex);
  expect(lines[allocatedIndex]).toBe(`run_allocated: ${lines[runIdIndex]?.slice('run-id: '.length)}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-run-allocated.test.ts test/cli-run.test.ts`
Expected: FAIL — `runAllocatedLine` not exported; no `run_allocated` line in CLI output.

- [ ] **Step 3: Implement**

In `src/cli/run-command.ts`, near the existing `runId` helper:

```ts
/** The machine-facing allocation line (parent Identity): emitted at run-dir
 *  allocation, before the first provider token, so a spawner can bind
 *  attempt -> run_id without waiting for exit. Legacy human output (the
 *  exit-time 'run-id:' line + rendered verdict) is unchanged. */
export function runAllocatedLine(runDir: string): string {
  return `run_allocated: ${runId(runDir)}\n`;
}
```

Extend the `onRunDir` handler in the `runScenario` call:

```ts
    onRunDir: (dir) => {
      runDirForStop = dir;
      process.stdout.write(runAllocatedLine(dir));
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-run-allocated.test.ts test/cli-run.test.ts`
Expected: PASS. Then `bun run check` green (full suite — the run-all and appliance suites exercise the parser paths).

- [ ] **Step 5: Commit**

```bash
git add src/cli/run-command.ts test/campaign-contracts-run-allocated.test.ts test/cli-run.test.ts
git commit -m "feat(campaign): kernel D1 run_allocated protocol seam (allocation-time emission, parser-tolerant)"
```

---

## Final verification

- [ ] **Run the full gate one last time**

Run: `bun run check`
Expected: biome clean, tsc clean, all tests pass.

- [ ] **Run scenario validation** (arm/suite discovery must not disturb it)

Run: `bun run quorum check`
Expected: all scenarios ok, credentials ok, no new failures.

- [ ] **Spec-coverage sweep:** walk the D1 spec's scope list (10 items) and confirm each has a task above: (1) document schemas → Tasks 1, 2, 7; (2) digest → Tasks 3, 4; (3) event vocabulary + state machines → Tasks 5, 6; (4) verdict + CheckRecord extensions → Tasks 9, 10; (5) credential amendments → Task 8; (6) scenario frontmatter → Task 13; (7) poolKey + KeySelector → Task 11; (8) profile parameters → Task 12; (9) quorum check arm/suite validation → Task 14; (10) run_allocated seam → Task 15. The typed-failure surface rides with Task 5.

## Notes for the executor

- The plan's golden digest (`7b116f…eebec`, Task 4) was computed against the exact golden fixture in the test — if the fixture changes, recompute with `bun -e` using `jcsCanonicalize` + `sha256Hex` rather than hand-editing the hex.
- Task 14's CLI wiring point ("fold into the existing ok/exit-code logic") requires reading the check action's aggregation first; the behavior contract is the pinned part, the exact insertion is local judgment.
- Biome may object to unused destructure bindings in Task 4's `digestInput`; rename with an underscore prefix or restructure until lint passes — behavior must not change.
- Errata E3/E4/E5 (proposed parent amendments) are tracked on PRI-2874; they do not gate this plan's tasks.
