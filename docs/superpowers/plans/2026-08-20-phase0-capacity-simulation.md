# Phase 0: Capacity Simulation + Estimate Artifact — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 0 capacity simulation (replay the 2026-08-08/09 gate's recorded durations through the campaign dispatch policy) and the `quorum.estimates/v1` artifact, per the approved child spec.

**Architecture:** New `src/campaign/` module — acquisition profile (appliance-side corpus pull), run-ID-exact replay manifest + loader, synchronous discrete-event simulation engine, estimates builder — behind thin `quorum campaign acquire|estimates|simulate` CLI verbs. No live spend; no changes to `src/scheduler/`, `src/run-all/`, or the dashboard.

**Tech Stack:** TypeScript on Bun (≥1.3), zod (contracts), bun:test, commander 12 (CLI), biome (lint/format).

**Spec (authoritative):** `docs/superpowers/specs/2026-08-20-phase0-capacity-simulation-design.md`
**Review record:** `docs/experiments/2026-08-20-phase0-spec-multiharness-review.md`
**Linear:** PRI-2935 (parent PRI-2874)

## Global Constraints

- **No live spend.** Nothing in this plan launches an eval, calls a provider, or mutates the appliance beyond the read-only acquisition profile.
- **Repo culture: no mocked-behavior tests.** Real fixture files on disk (tmpdir or committed fixtures), real zod parsing, real event engine. No test doubles for our own code.
- **Determinism:** every artifact and simulation output must be reproducible byte-for-byte from its inputs. No `Date.now()` in library code — time inputs are injected.
- **TDD:** failing test first for every behavior; run the single test to see it fail; implement; run again; commit per task.
- **Checks after every task:** `bun test test/<file>.test.ts`, and before each commit `bun run check` (biome + tsc + bun test) and `bun run quorum check` must stay green.
- **Pool identity:** target-policy `pool_id` = `quota_pool` key if set, else `(base_url ?? credential-name)|api|model` — frozen INTO the replay manifest at curation time. Never recomputed from today's `credentials.yaml` at load time.
- **Estimates keying:** scenario×agent×credential×os, fallback scenario×agent → scenario → corpus median (parent errata E1/E2 — recorded, ratified on PRI-2874).
- **8h verdict rule:** issued ONLY on target-identity, estimate-ordered, allowance-inclusive runs. Everything else is a labeled conditional prediction.
- Commit style: repo conventional commits (`feat:`, `test:`, `docs:`, `fix:`).

---

### Task 1: Contracts — replay + estimates zod schemas

**Files:**
- Create: `src/contracts/replay.ts`
- Create: `src/contracts/estimates.ts`
- Test: `test/campaign-contracts.test.ts`
- Modify: `.gitignore` (add `corpus/`)

**Interfaces:**
- Consumes: nothing (zod only).
- Produces: `ReplayRecordSchema`/`ReplayRecord`, `ReplayManifestSchema`/`ReplayManifest`, `EstimateStatsSchema`/`EstimateStats`, `EstimateEntrySchema`/`EstimateEntry`, `EstimatesArtifactSchema`/`EstimatesArtifact` — used by every later task.

- [ ] **Step 1: Write the failing test**

```ts
// test/campaign-contracts.test.ts
import { expect, test } from 'bun:test';
import {
  ReplayManifestSchema,
  ReplayRecordSchema,
} from '../src/contracts/replay.ts';
import { EstimatesArtifactSchema } from '../src/contracts/estimates.ts';

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
  expect(() =>
    ReplayRecordSchema.parse({ ...base, arm: 'middle' }),
  ).toThrow();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/campaign-contracts.test.ts`
Expected: FAIL — module not found (`../src/contracts/replay.ts`).

- [ ] **Step 3: Write the schemas**

```ts
// src/contracts/replay.ts
import { z } from 'zod';

/** One imported run reduced to the fields the simulation and estimates
 *  consume. wall_ms is the run's total wall (finished_at − started_at);
 *  it is the service time. Everything else is nullable evidence. */
export const ReplayRecordSchema = z.object({
  run_id: z.string(),
  scenario: z.string(),
  agent: z.string(),
  credential: z.string(),
  os: z.string(),
  pool_id: z.string(),
  arm: z.enum(['baseline', 'treatment', 'single']),
  wall_ms: z.number().finite().nonnegative(),
  coding_ms: z.number().finite().nonnegative().nullable(),
  gauntlet_ms: z.number().finite().nonnegative().nullable(),
  pre_exposure_ms: z.number().finite().nonnegative().nullable(),
  cost_subject_usd: z.number().nullable(),
  cost_grader_usd: z.number().nullable(),
  cost_total_usd: z.number().nullable(),
});
export type ReplayRecord = z.infer<typeof ReplayRecordSchema>;

export const ManifestSampleSchema = z.object({
  run_id: z.string(),
  arm: z.enum(['baseline', 'treatment']),
  replicate: z.number().int().positive(),
  block_id: z.string(),
  historical_job: z.string(),
  role: z.enum(['scored', 'retry-load']),
});
export type ManifestSample = z.infer<typeof ManifestSampleSchema>;

export const ManifestCellSchema = z.object({
  scenario: z.string(),
  class: z.enum(['confirmatory', 'probe', 'tripwire', 'descriptive']),
  samples: z.array(ManifestSampleSchema),
});
export type ManifestCell = z.infer<typeof ManifestCellSchema>;

export const ManifestComparisonSchema = z.object({
  comparison_id: z.string(),
  credential: z.string(),
  pool_id: z.string(),
  legacy_pool_id: z.string(),
  cells: z.array(ManifestCellSchema),
});
export type ManifestComparison = z.infer<typeof ManifestComparisonSchema>;

/** Canonical, run-ID-exact structural source for a replay. Curation-time
 *  frozen: pool_ids are resolved from gate-era credential definitions and
 *  never recomputed at load. */
export const ReplayManifestSchema = z.object({
  schema_version: z.literal('quorum.replay-manifest/v1'),
  name: z.string(),
  source_docs: z.array(z.string()),
  arms: z.object({
    baseline_sha: z.string().length(40),
    treatment_sha: z.string().length(40),
  }),
  comparisons: z.array(ManifestComparisonSchema),
  excluded_run_ids: z.array(z.object({ run_id: z.string(), reason: z.string() })),
});
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;
```

```ts
// src/contracts/estimates.ts
import { z } from 'zod';

/** Statistics shared by every fallback tier. Cost medians are computed
 *  over non-null observations only; null when priced_n is 0. */
export const EstimateStatsSchema = z.object({
  duration_s_median: z.number(),
  duration_n: z.number().int().nonnegative(),
  cost_subject_usd_median: z.number().nullable(),
  cost_grader_usd_median: z.number().nullable(),
  cost_total_usd_median: z.number().nullable(),
  priced_n: z.number().int().nonnegative(),
  spread_s: z.object({ p25: z.number(), p75: z.number() }),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type EstimateStats = z.infer<typeof EstimateStatsSchema>;

export const EstimateEntrySchema = EstimateStatsSchema.extend({
  scenario: z.string(),
  agent: z.string(),
  credential: z.string(),
  os: z.string(),
});
export type EstimateEntry = z.infer<typeof EstimateEntrySchema>;

export const ScenarioAgentStatsSchema = EstimateStatsSchema.extend({
  scenario: z.string(),
  agent: z.string(),
});
export type ScenarioAgentStats = z.infer<typeof ScenarioAgentStatsSchema>;

export const ScenarioStatsSchema = EstimateStatsSchema.extend({
  scenario: z.string(),
});
export type ScenarioStats = z.infer<typeof ScenarioStatsSchema>;

export const EstimatesArtifactSchema = z.object({
  schema_version: z.literal('quorum.estimates/v1'),
  /** Data-derived: max finished_at across included inputs. Never a wall
   *  clock — byte-identical regeneration is a hard requirement. */
  generated_at: z.string(),
  corpus: z.object({
    sources: z.array(z.string()),
    run_count: z.number().int().nonnegative(),
    digest: z.string(),
  }),
  entries: z.array(EstimateEntrySchema),
  fallbacks: z.object({
    scenario_agent: z.array(ScenarioAgentStatsSchema),
    scenario: z.array(ScenarioStatsSchema),
    corpus_median: z.object({
      duration_s: z.number(),
      cost_total_usd: z.number().nullable(),
    }),
  }),
});
export type EstimatesArtifact = z.infer<typeof EstimatesArtifactSchema>;
```

- [ ] **Step 4: Run test to verify it passes, add `corpus/` to `.gitignore`**

Run: `bun test test/campaign-contracts.test.ts`
Expected: PASS (4 tests).
Then append one line to `.gitignore`: `corpus/`

- [ ] **Step 5: Commit**

```bash
git add src/contracts/replay.ts src/contracts/estimates.ts test/campaign-contracts.test.ts .gitignore
git commit -m "feat(contracts): replay + estimates zod schemas for Phase 0"
```

---

### Task 2: Estimates builder + fallback lookup

**Files:**
- Create: `src/campaign/estimates.ts`
- Test: `test/campaign-estimates.test.ts`

**Interfaces:**
- Consumes: `ReplayRecord` (Task 1).
- Produces:
  - `buildEstimates(inputs: EstimateInput[], opts: { sources: string[] }): EstimatesArtifact` where `EstimateInput = { record: ReplayRecord; finished_at: string }`
  - `lookupEstimate(artifact: EstimatesArtifact, key: { scenario: string; agent: string; credential: string; os: string }): EstimateLookup` where `EstimateLookup = { duration_s: number; cost_total_usd: number | null; tier: 'scenario_agent_credential_os' | 'scenario_agent' | 'scenario' | 'corpus'; confidence: 'high' | 'medium' | 'low' | null }`
  - `serializeEstimates(artifact: EstimatesArtifact): string` — pinned serialization (2-space JSON, LF, sorted keys per the artifact's fixed field order). Used by the CLI (Task 6).

Rules (from spec — pinned): confidence from `duration_n` (≥8 high, 3–7 medium, 1–2 low); `priced_n` counts non-null `cost_total_usd`; cost medians over non-null values only; even-n median = average of two middles; entries sorted by (scenario, agent, credential, os); fallback tiers sorted by their keys; `generated_at` = max `finished_at`; `corpus.digest` = sha256 hex of the sorted run_id list joined with `\n`; merge rule = union by run_id, first input wins on duplicate (loader guarantees gate corpus first), duplicates counted and excluded from stats; p25/p75 via the same median-of-halves convention as a standard quantile over the sorted durations (p25 = median of lower half, p75 = median of upper half; n<4 → p25 = min, p75 = max).

- [ ] **Step 1: Write the failing test**

```ts
// test/campaign-estimates.test.ts
import { expect, test } from 'bun:test';
import type { ReplayRecord } from '../src/contracts/replay.ts';
import {
  buildEstimates,
  type EstimateInput,
  lookupEstimate,
  serializeEstimates,
} from '../src/campaign/estimates.ts';

function rec(over: Partial<ReplayRecord>): ReplayRecord {
  return {
    run_id: 'r',
    scenario: 'sdd-escalates',
    agent: 'claude',
    credential: 'opus_bedrock',
    os: 'linux',
    pool_id: 'p',
    arm: 'baseline',
    wall_ms: 600_000,
    coding_ms: 500_000,
    gauntlet_ms: 660_000,
    pre_exposure_ms: 30_000,
    cost_subject_usd: 1.0,
    cost_grader_usd: 0.1,
    cost_total_usd: 1.1,
    ...over,
  };
}

function input(record: ReplayRecord, finished_at = '2026-08-08T01:00:00.000Z'): EstimateInput {
  return { record, finished_at };
}

test('medians: odd n picks middle, even n averages two middles', () => {
  const inputs = [
    input(rec({ run_id: 'a', wall_ms: 100_000 })),
    input(rec({ run_id: 'b', wall_ms: 200_000 })),
    input(rec({ run_id: 'c', wall_ms: 300_000 })),
    input(rec({ run_id: 'd', wall_ms: 400_000 })),
  ];
  const art = buildEstimates(inputs, { sources: ['fixture'] });
  expect(art.entries).toHaveLength(1);
  expect(art.entries[0]!.duration_s_median).toBe(250); // (200+300)/2, in s
  expect(art.entries[0]!.duration_n).toBe(4);
  expect(art.entries[0]!.confidence).toBe('medium'); // 3..7
  expect(art.entries[0]!.priced_n).toBe(4);
});

test('cost medians skip nulls; priced_n=0 yields null cost, not 0', () => {
  const inputs = [
    input(rec({ run_id: 'a', cost_total_usd: null, cost_subject_usd: null, cost_grader_usd: null })),
    input(rec({ run_id: 'b', cost_total_usd: 2.0 })),
  ];
  const art = buildEstimates(inputs, { sources: ['fixture'] });
  expect(art.entries[0]!.priced_n).toBe(1);
  expect(art.entries[0]!.cost_total_usd_median).toBe(2.0);
  const onlyNull = buildEstimates(
    [input(rec({ run_id: 'a', cost_total_usd: null }))],
    { sources: ['fixture'] },
  );
  expect(onlyNull.entries[0]!.cost_total_usd_median).toBeNull();
});

test('fallback chain: credential-specific, then scenario_agent, scenario, corpus', () => {
  const inputs = [
    // 8 runs for claude/opus_bedrock (high-confidence tier-1)
    ...Array.from({ length: 8 }, (_, i) =>
      input(rec({ run_id: `ob${i}`, wall_ms: 600_000 + i * 1000 })),
    ),
    // 1 run for claude/opus5_bedrock (low-confidence tier-1)
    input(rec({ run_id: 'o5', credential: 'opus5_bedrock', wall_ms: 3_000_000 })),
    // 1 run for codex on another scenario
    input(rec({ run_id: 'cx', scenario: 'other-scenario', agent: 'codex', credential: 'openai_responses_56sol', wall_ms: 900_000 })),
  ];
  const art = buildEstimates(inputs, { sources: ['fixture'] });

  const direct = lookupEstimate(art, {
    scenario: 'sdd-escalates', agent: 'claude', credential: 'opus_bedrock', os: 'linux',
  });
  expect(direct.tier).toBe('scenario_agent_credential_os');
  expect(direct.confidence).toBe('high');
  expect(direct.duration_s).toBe(603.5);

  const lowConf = lookupEstimate(art, {
    scenario: 'sdd-escalates', agent: 'claude', credential: 'opus5_bedrock', os: 'linux',
  });
  expect(lowConf.tier).toBe('scenario_agent_credential_os');
  expect(lowConf.confidence).toBe('low');

  // Unknown credential on a known scenario×agent falls to scenario_agent.
  const sa = lookupEstimate(art, {
    scenario: 'sdd-escalates', agent: 'claude', credential: 'never_seen', os: 'linux',
  });
  expect(sa.tier).toBe('scenario_agent');
  expect(sa.duration_s).toBe(art.fallbacks.scenario_agent[0]!.duration_s_median);

  // Unknown agent on a known scenario falls to scenario.
  const sc = lookupEstimate(art, {
    scenario: 'sdd-escalates', agent: 'gemini', credential: 'x', os: 'linux',
  });
  expect(sc.tier).toBe('scenario');

  // Unknown scenario falls to corpus.
  const co = lookupEstimate(art, {
    scenario: 'nope', agent: 'gemini', credential: 'x', os: 'linux',
  });
  expect(co.tier).toBe('corpus');
  expect(co.duration_s).toBe(art.fallbacks.corpus_median.duration_s);
});

test('duplicate run_id: first input wins, duplicates excluded from stats', () => {
  const dup = rec({ run_id: 'a', wall_ms: 100_000 });
  const art = buildEstimates(
    [input(dup), input(rec({ run_id: 'a', wall_ms: 9_000_000 }))],
    { sources: ['fixture'] },
  );
  expect(art.entries[0]!.duration_n).toBe(1);
  expect(art.entries[0]!.duration_s_median).toBe(100);
  expect(art.corpus.run_count).toBe(1);
});

test('generated_at is max finished_at; serialization is byte-stable', () => {
  const inputs = [
    input(rec({ run_id: 'a' }), '2026-08-08T01:00:00.000Z'),
    input(rec({ run_id: 'b' }), '2026-08-09T02:00:00.000Z'),
  ];
  const a1 = buildEstimates(inputs, { sources: ['fixture'] });
  const a2 = buildEstimates(inputs, { sources: ['fixture'] });
  expect(a1.generated_at).toBe('2026-08-09T02:00:00.000Z');
  expect(serializeEstimates(a1)).toBe(serializeEstimates(a2));
  expect(serializeEstimates(a1).endsWith('\n')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/campaign-estimates.test.ts`
Expected: FAIL — module not found (`../src/campaign/estimates.ts`).

- [ ] **Step 3: Implement the builder**

```ts
// src/campaign/estimates.ts
import type {
  EstimateEntry,
  EstimateStats,
  EstimatesArtifact,
  ScenarioAgentStats,
  ScenarioStats,
} from '../contracts/estimates.ts';
import type { ReplayRecord } from '../contracts/replay.ts';

export interface EstimateInput {
  record: ReplayRecord;
  finished_at: string;
}

export type EstimateTier =
  | 'scenario_agent_credential_os'
  | 'scenario_agent'
  | 'scenario'
  | 'corpus';

export interface EstimateLookup {
  duration_s: number;
  cost_total_usd: number | null;
  tier: EstimateTier;
  confidence: 'high' | 'medium' | 'low' | null;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) throw new Error('median of empty');
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function medianOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return present.length === 0 ? null : median(present);
}

function confidence(durationN: number): 'high' | 'medium' | 'low' {
  if (durationN >= 8) return 'high';
  if (durationN >= 3) return 'medium';
  return 'low';
}

function statsOf(records: ReplayRecord[]): EstimateStats {
  const durations = records.map((r) => r.wall_ms / 1000).sort((a, b) => a - b);
  const n = durations.length;
  const mid = Math.floor(n / 2);
  const lower = durations.slice(0, mid);
  const upper = durations.slice(n % 2 === 1 ? mid + 1 : mid);
  return {
    duration_s_median: median(durations),
    duration_n: n,
    cost_subject_usd_median: medianOrNull(records.map((r) => r.cost_subject_usd)),
    cost_grader_usd_median: medianOrNull(records.map((r) => r.cost_grader_usd)),
    cost_total_usd_median: medianOrNull(records.map((r) => r.cost_total_usd)),
    priced_n: records.filter((r) => r.cost_total_usd !== null).length,
    spread_s:
      n < 4
        ? { p25: durations[0]!, p75: durations[n - 1]! }
        : { p25: median(lower), p75: median(upper) },
    confidence: confidence(n),
  };
}

function byKey<K>(records: ReplayRecord[], keyOf: (r: ReplayRecord) => K): Map<K, ReplayRecord[]> {
  const groups = new Map<K, ReplayRecord[]>();
  for (const r of records) {
    const k = keyOf(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return groups;
}

export function buildEstimates(
  inputs: EstimateInput[],
  opts: { sources: string[] },
): EstimatesArtifact {
  // Merge rule: union by run_id, first input wins; duplicates counted out.
  const seen = new Set<string>();
  const records: ReplayRecord[] = [];
  const finishedAts: string[] = [];
  for (const { record, finished_at } of inputs) {
    if (seen.has(record.run_id)) continue;
    seen.add(record.run_id);
    records.push(record);
    finishedAts.push(finished_at);
  }
  if (records.length === 0) throw new Error('buildEstimates: no inputs');

  const entries: EstimateEntry[] = [...byKey(records, (r) => `${r.scenario}${r.agent}${r.credential}${r.os}`).entries()]
    .map(([key, rs]): EstimateEntry => {
      const [scenario, agent, credential, os] = key.split('');
      return { scenario: scenario!, agent: agent!, credential: credential!, os: os!, ...statsOf(rs) };
    })
    .sort((a, b) =>
      `${a.scenario}${a.agent}${a.credential}${a.os}`.localeCompare(
        `${b.scenario}${b.agent}${b.credential}${b.os}`,
      ),
    );

  const scenarioAgent: ScenarioAgentStats[] = [...byKey(records, (r) => `${r.scenario}${r.agent}`).entries()]
    .map(([key, rs]): ScenarioAgentStats => {
      const [scenario, agent] = key.split('');
      return { scenario: scenario!, agent: agent!, ...statsOf(rs) };
    })
    .sort((a, b) => `${a.scenario}${a.agent}`.localeCompare(`${b.scenario}${b.agent}`));

  const scenario: ScenarioStats[] = [...byKey(records, (r) => r.scenario).entries()]
    .map(([sc, rs]): ScenarioStats => ({ scenario: sc, ...statsOf(rs) }))
    .sort((a, b) => a.scenario.localeCompare(b.scenario));

  const digest = Bun.SHA256.hash([...seen].sort().join('\n'), 'hex');

  return {
    schema_version: 'quorum.estimates/v1',
    generated_at: finishedAts.sort().at(-1)!,
    corpus: { sources: opts.sources, run_count: records.length, digest },
    entries,
    fallbacks: {
      scenario_agent: scenarioAgent,
      scenario,
      corpus_median: {
        duration_s: statsOf(records).duration_s_median,
        cost_total_usd: medianOrNull(records.map((r) => r.cost_total_usd)),
      },
    },
  };
}

export function lookupEstimate(
  artifact: EstimatesArtifact,
  key: { scenario: string; agent: string; credential: string; os: string },
): EstimateLookup {
  const direct = artifact.entries.find(
    (e) =>
      e.scenario === key.scenario &&
      e.agent === key.agent &&
      e.credential === key.credential &&
      e.os === key.os,
  );
  if (direct) {
    return {
      duration_s: direct.duration_s_median,
      cost_total_usd: direct.cost_total_usd_median,
      tier: 'scenario_agent_credential_os',
      confidence: direct.confidence,
    };
  }
  const sa = artifact.fallbacks.scenario_agent.find(
    (e) => e.scenario === key.scenario && e.agent === key.agent,
  );
  if (sa) {
    return {
      duration_s: sa.duration_s_median,
      cost_total_usd: sa.cost_total_usd_median,
      tier: 'scenario_agent',
      confidence: sa.confidence,
    };
  }
  const sc = artifact.fallbacks.scenario.find((e) => e.scenario === key.scenario);
  if (sc) {
    return {
      duration_s: sc.duration_s_median,
      cost_total_usd: sc.cost_total_usd_median,
      tier: 'scenario',
      confidence: sc.confidence,
    };
  }
  return {
    duration_s: artifact.fallbacks.corpus_median.duration_s,
    cost_total_usd: artifact.fallbacks.corpus_median.cost_total_usd,
    tier: 'corpus',
    confidence: null,
  };
}

/** Pinned serialization: 2-space JSON, LF, trailing newline. The artifact's
 *  field order is fixed by construction in buildEstimates; regeneration
 *  from identical inputs is byte-identical (tested). */
export function serializeEstimates(artifact: EstimatesArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/campaign-estimates.test.ts`
Expected: PASS (5 tests). Note: `duration_s` values are seconds — the test's 603.5 is the median of [600..607] (8 values, average of 603 and 604).

- [ ] **Step 5: Commit**

```bash
git add src/campaign/estimates.ts test/campaign-estimates.test.ts
git commit -m "feat(campaign): estimates builder with pinned fallback chain + determinism"
```

---

### Task 3: Acquisition profile (`acquireCorpus`)

**Files:**
- Create: `src/campaign/acquire.ts`
- Test: `test/campaign-acquire.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure FS + injected time).
- Produces:
  - `acquireCorpus(args: AcquireArgs): Promise<SelectionManifest>` — used by the CLI verb (Task 6) and run on the appliance (Task 8).
  - `SelectionManifest` (`quorum.corpus-selection/v1`) — lands as `<outDir>/selection-manifest.json`; Task 8 records it in the experiment entry.
  - `PAYLOAD_RUN_FILES` — the per-run payload list, exported for the test and the runbook.

Payload per run dir: `verdict.json`, `trajectory.json`, `coding-agent-token-usage.json`, and `gauntlet-agent/results/<id>/result.json` (exactly one `<id>` dir expected; zero or ≥2 → the run lands in `missing_run_ids` with the reason noted in a per-run `notes` field). Batch metadata: for every `<batchesRoot>/<batch>/results.jsonl` that names any allowlisted run_id, copy that batch's `batch.json` + `results.jsonl`. Missing run dirs are listed in `missing_run_ids` (NOT fatal — the replay loader in Task 4 is what errors loudly if the manifest needs them).

- [ ] **Step 1: Write the failing test**

```ts
// test/campaign-acquire.test.ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCorpus, PAYLOAD_RUN_FILES } from '../src/campaign/acquire.ts';

function makeResultsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'acquire-src-'));
  const run = 'sdd-escalates-claude-opus_bedrock-linux-20260808T000000Z-ab12';
  const runDir = join(root, run);
  mkdirSync(join(runDir, 'gauntlet-agent', 'results', 'g1'), { recursive: true });
  writeFileSync(join(runDir, 'verdict.json'), '{"final":"pass"}');
  writeFileSync(join(runDir, 'trajectory.json'), '{"steps":[]}');
  writeFileSync(join(runDir, 'coding-agent-token-usage.json'), '{}');
  writeFileSync(join(runDir, 'gauntlet-agent', 'results', 'g1', 'result.json'), '{"duration_ms":56000}');
  // home/ must never be copied:
  mkdirSync(join(runDir, 'home', '.claude'), { recursive: true });
  writeFileSync(join(runDir, 'home', '.claude', 'oauth'), 'SECRET');
  // batches: one batch references the run, one does not
  mkdirSync(join(root, 'batches', 'batch-20260808T000000Z-aaaa'), { recursive: true });
  writeFileSync(join(root, 'batches', 'batch-20260808T000000Z-aaaa', 'batch.json'), '{"id":"batch-20260808T000000Z-aaaa"}');
  writeFileSync(
    join(root, 'batches', 'batch-20260808T000000Z-aaaa', 'results.jsonl'),
    `${JSON.stringify({ scenario: 'sdd-escalates', coding_agent: 'claude', run_id: run })}\n`,
  );
  mkdirSync(join(root, 'batches', 'batch-other'), { recursive: true });
  writeFileSync(join(root, 'batches', 'batch-other', 'batch.json'), '{"id":"batch-other"}');
  writeFileSync(join(root, 'batches', 'batch-other', 'results.jsonl'), '{"run_id":"someone-else"}\n');
  return root;
}

test('acquireCorpus copies the payload, never homes, and writes the selection manifest', async () => {
  const src = makeResultsRoot();
  const out = mkdtempSync(join(tmpdir(), 'acquire-out-'));
  const run = 'sdd-escalates-claude-opus_bedrock-linux-20260808T000000Z-ab12';
  const manifest = await acquireCorpus({
    resultsRoot: src,
    runIds: [run, 'missing-run'],
    outDir: out,
    sourceHost: 'quorum-appliance',
    now: '2026-08-20T00:00:00.000Z',
    command: 'quorum campaign acquire --runs-file runs.txt',
  });
  expect(manifest.runs).toHaveLength(1);
  expect(manifest.runs[0]!.run_id).toBe(run);
  expect(manifest.missing_run_ids).toEqual(['missing-run']);
  for (const f of PAYLOAD_RUN_FILES) {
    expect(manifest.runs[0]!.files.some((x) => x.path === f)).toBe(true);
  }
  // gauntlet result.json present, home absent
  expect(
    manifest.runs[0]!.files.some((x) => x.path === 'gauntlet-agent/results/g1/result.json'),
  ).toBe(true);
  expect(manifest.runs[0]!.files.some((x) => x.path.startsWith('home/'))).toBe(false);
  // batch metadata: only the batch that references the run
  expect(manifest.batches.map((b) => b.batch_id)).toEqual(['batch-20260808T000000Z-aaaa']);
  // files actually landed
  const landed = readFileSync(join(out, run, 'verdict.json'), 'utf8');
  expect(landed).toBe('{"final":"pass"}');
  const sel = JSON.parse(readFileSync(join(out, 'selection-manifest.json'), 'utf8'));
  expect(sel.schema_version).toBe('quorum.corpus-selection/v1');
  expect(sel.source_host).toBe('quorum-appliance');
  expect(sel.pulled_at).toBe('2026-08-20T00:00:00.000Z');
  expect(sel.runs[0].files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  rmSync(src, { recursive: true });
  rmSync(out, { recursive: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/campaign-acquire.test.ts`
Expected: FAIL — module not found (`../src/campaign/acquire.ts`).

- [ ] **Step 3: Implement the acquisition profile**

```ts
// src/campaign/acquire.ts
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Per-run payload: durations, costs, identity, trajectory (skew scalar).
 *  Deliberately excludes homes (OAuth material), transcripts beyond the
 *  ATIF trajectory, and workdirs. */
export const PAYLOAD_RUN_FILES = [
  'verdict.json',
  'trajectory.json',
  'coding-agent-token-usage.json',
] as const;

export interface AcquireArgs {
  /** Flat results root on the source host (run dirs directly inside; a
   *  `batches/` subdirectory is consulted for batch metadata). */
  resultsRoot: string;
  /** Exact run-dir names to select. */
  runIds: readonly string[];
  outDir: string;
  sourceHost: string;
  /** ISO timestamp, injected (never Date.now) for reproducibility. */
  now: string;
  /** The exact command line, recorded in the selection manifest. */
  command: string;
}

export interface SelectionFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface SelectionManifest {
  schema_version: 'quorum.corpus-selection/v1';
  source_host: string;
  pulled_at: string;
  command: string;
  runs: Array<{ run_id: string; files: SelectionFileEntry[]; notes: string[] }>;
  batches: Array<{ batch_id: string; files: SelectionFileEntry[] }>;
  missing_run_ids: string[];
}

function sha256File(path: string): string {
  return Bun.SHA256.hash(readFileSync(path), 'hex');
}

function writePrivate(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, { mode: 0o600 });
}

function copyRecorded(
  srcAbs: string,
  destAbs: string,
  relPath: string,
): SelectionFileEntry {
  mkdirSync(join(destAbs, '..'), { recursive: true });
  copyFileSync(srcAbs, destAbs);
  return {
    path: relPath,
    sha256: sha256File(srcAbs),
    bytes: statSync(srcAbs).size,
  };
}

export async function acquireCorpus(args: AcquireArgs): Promise<SelectionManifest> {
  const manifest: SelectionManifest = {
    schema_version: 'quorum.corpus-selection/v1',
    source_host: args.sourceHost,
    pulled_at: args.now,
    command: args.command,
    runs: [],
    batches: [],
    missing_run_ids: [],
  };

  const wanted = new Set(args.runIds);

  for (const runId of [...wanted].sort()) {
    const runDir = join(args.resultsRoot, runId);
    if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
      manifest.missing_run_ids.push(runId);
      continue;
    }
    const files: SelectionFileEntry[] = [];
    const notes: string[] = [];
    for (const rel of PAYLOAD_RUN_FILES) {
      const srcAbs = join(runDir, rel);
      if (!existsSync(srcAbs)) {
        notes.push(`missing payload file: ${rel}`);
        continue;
      }
      files.push(copyRecorded(srcAbs, join(args.outDir, runId, rel), rel));
    }
    // gauntlet-agent/results/<id>/result.json — exactly one id expected.
    const gResults = join(runDir, 'gauntlet-agent', 'results');
    if (existsSync(gResults)) {
      const ids = readdirSync(gResults, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      if (ids.length !== 1) {
        notes.push(`gauntlet-agent/results holds ${ids.length} run dirs (expected 1)`);
      }
      for (const id of ids) {
        const rel = join('gauntlet-agent', 'results', id, 'result.json');
        const srcAbs = join(gResults, id, 'result.json');
        if (existsSync(srcAbs)) {
          files.push(copyRecorded(srcAbs, join(args.outDir, runId, rel), rel));
        }
      }
    } else {
      notes.push('no gauntlet-agent/results dir');
    }
    manifest.runs.push({ run_id: runId, files, notes });
  }

  // Batch metadata: any batch whose results.jsonl references a wanted run.
  const batchesRoot = join(args.resultsRoot, 'batches');
  if (existsSync(batchesRoot)) {
    for (const batch of readdirSync(batchesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      const resultsJsonl = join(batchesRoot, batch, 'results.jsonl');
      const batchJson = join(batchesRoot, batch, 'batch.json');
      if (!existsSync(resultsJsonl)) continue;
      const text = readFileSync(resultsJsonl, 'utf8');
      if (![...wanted].some((id) => text.includes(id))) continue;
      const files: SelectionFileEntry[] = [];
      for (const rel of ['batch.json', 'results.jsonl']) {
        const srcAbs = join(batchesRoot, batch, rel);
        if (existsSync(srcAbs)) {
          files.push(
            copyRecorded(srcAbs, join(args.outDir, 'batches', batch, rel), rel),
          );
        }
      }
      manifest.batches.push({ batch_id: batch, files });
    }
  }

  writePrivate(
    join(args.outDir, 'selection-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/campaign-acquire.test.ts`
Expected: PASS (1 test). Also `bun run lint` for biome cleanliness.

- [ ] **Step 5: Commit**

```bash
git add src/campaign/acquire.ts test/campaign-acquire.test.ts
git commit -m "feat(campaign): appliance-side corpus acquisition profile with selection manifest"
```

---

### Task 4: Replay loader (manifest + corpus → replay records → sim blocks)

**Files:**
- Create: `src/campaign/replay.ts`
- Test: `test/campaign-replay.test.ts`

**Interfaces:**
- Consumes: `ReplayRecord`/`ReplayManifest` (Task 1).
- Produces (consumed by Tasks 5, 6, 8, 9):
  - `class ReplayLoadError extends Error`
  - `loadManifest(path: string): ReplayManifest` — reads + zod-parses; `ReplayLoadError` on failure.
  - `recordFromRunDir(runDir: string, runId: string): ReplayRecord` — tolerant economics read (the `src/cli/costs.ts` pattern), NO strict schema on the economics block. Missing/invalid `verdict.json` identity or non-finite wall → `ReplayLoadError` naming the run_id. `provenance.superpowers_rev` is read by `verifyArm` below, not here.
  - `loadCorpus(corpusDir: string, manifest: ReplayManifest): LoadedCorpus` where:

```ts
export interface LoadedCorpus {
  records: Map<string, ReplayRecord>; // by run_id, scored + retry-load
  blocks: SimBlockInput[];            // two-arm scored blocks + single-sample retry blocks
  coverage: {
    listed_runs: number;
    excluded_runs_present: number;
    missing_listed_runs: string[];    // always [] on success (loud error otherwise)
    surplus_corpus_dirs: string[];    // always [] on success
    null_coding_ms: number;
    null_gauntlet_ms: number;
    null_pre_exposure_ms: number;
    gauntlet_lt_coding_anomalies: string[]; // preserved, never clamped
  };
}
export interface SimBlockInput {
  block_id: string;
  comparison_id: string;
  cell: string;
  replicate: number;
  order_key: string; // `${comparison_id}|${cell}|${replicate padded 4}|${block_id}`
  historical_job: string;
  samples: Array<{ run_id: string; subject_pool: string }>;
}
```

Rules:
- Arm verification: for each manifest sample, read the run's `verdict.json .provenance.superpowers_rev`; must equal `manifest.arms.baseline_sha` for `arm: 'baseline'`, `treatment_sha` for `'treatment'`. Null, unknown, or `superpowers_dirty: true` → `ReplayLoadError` naming the run_id.
- Pool assignment: `record.pool_id = comparison.pool_id`; `SimBlockInput.samples[].subject_pool` likewise. (`legacy_pool_id` is used only by the CLI's counterfactual mode, Task 6.)
- `pre_exposure_ms`: parse `trajectory.json`, take the earliest `.steps[].timestamp` parseable as a date; `pre_exposure_ms = ts − started_at`. Missing trajectory/steps → null (counted in coverage). Negative → `ReplayLoadError`.
- `gauntlet_ms`: from `gauntlet-agent/results/<id>/result.json .duration_ms` (fallback: `.economics.gauntlet.duration_ms` in the verdict). `gauntlet_ms < coding_ms` → record the run_id in `gauntlet_lt_coding_anomalies`, keep both values.
- Retry-load samples become single-sample blocks (`block_id + '/retry'`); scored samples are grouped by `block_id` (exactly 2 samples per block — one baseline, one treatment — else `ReplayLoadError`).
- Loader loud errors: any corpus run dir not named by the manifest (samples or `excluded_run_ids`) → surplus error; any manifest sample missing on disk → missing error. Excluded run dirs present on disk are counted (`excluded_runs_present`) and skipped.

- [ ] **Step 1: Write the failing test**

```ts
// test/campaign-replay.test.ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReplayManifest } from '../src/contracts/replay.ts';
import { loadCorpus, ReplayLoadError } from '../src/campaign/replay.ts';

const BASE = 'a'.repeat(40);
const TREAT = 'b'.repeat(40);

function manifest(samples: Array<{ run_id: string; arm: 'baseline' | 'treatment'; role?: 'scored' | 'retry-load' }>): ReplayManifest {
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
            samples: samples.map((s, i) => ({
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

function writeRun(dir: string, rev: string | null, opts?: { wallMs?: number; gauntletMs?: number | null; firstStepTs?: string }) {
  const wallMs = opts?.wallMs ?? 600_000;
  mkdirSync(join(dir, 'gauntlet-agent', 'results', 'g1'), { recursive: true });
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final: 'pass',
      scenario: 'sdd-escalates',
      coding_agent: 'claude',
      credential: 'opus_bedrock',
      os: 'linux',
      started_at: '2026-08-08T00:00:00.000Z',
      finished_at: new Date(Date.parse('2026-08-08T00:00:00.000Z') + wallMs).toISOString(),
      provenance: rev === null ? {} : { superpowers_rev: rev },
      economics: {
        coding_agent: { duration_ms: 500_000, est_cost_usd: 1.0 },
        gauntlet: opts?.gauntletMs === null ? {} : { duration_ms: opts?.gauntletMs ?? 560_000, est_cost_usd: 0.1 },
        total_est_cost_usd: 1.1,
      },
    }),
  );
  writeFileSync(
    join(dir, 'trajectory.json'),
    JSON.stringify({ steps: [{ timestamp: opts?.firstStepTs ?? '2026-08-08T00:00:30.000Z' }] }),
  );
  writeFileSync(join(dir, 'coding-agent-token-usage.json'), '{}');
  writeFileSync(join(dir, 'gauntlet-agent', 'results', 'g1', 'result.json'), '{}');
}

test('loadCorpus builds two-arm blocks and coverage; verifies arm SHAs', () => {
  const corpus = mkdtempSync(join(tmpdir(), 'corpus-'));
  writeRun(join(corpus, 'run-base'), BASE);
  writeRun(join(corpus, 'run-treat'), TREAT);
  mkdirSync(join(corpus, 'excluded-run'), { recursive: true }); // present, excluded
  const loaded = loadCorpus(corpus, manifest([
    { run_id: 'run-base', arm: 'baseline' },
    { run_id: 'run-treat', arm: 'treatment' },
  ]));
  expect(loaded.blocks).toHaveLength(1);
  expect(loaded.blocks[0]!.samples.map((s) => s.run_id).sort()).toEqual(['run-base', 'run-treat']);
  expect(loaded.blocks[0]!.samples[0]!.subject_pool).toBe('bedrock|anthropic|claude-opus-4-8');
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
    loadCorpus(corpus, manifest([
      { run_id: 'run-base', arm: 'baseline' },
      { run_id: 'run-treat', arm: 'treatment' },
    ])),
  ).toThrow(ReplayLoadError);
  rmSync(corpus, { recursive: true });
});

test('surplus corpus dir and missing listed run are loud errors', () => {
  const corpus = mkdtempSync(join(tmpdir(), 'corpus-'));
  writeRun(join(corpus, 'surprise-run'), BASE);
  expect(() =>
    loadCorpus(corpus, manifest([
      { run_id: 'run-base', arm: 'baseline' },
      { run_id: 'run-treat', arm: 'treatment' },
    ])),
  ).toThrow(/surprise-run|missing/);
  rmSync(corpus, { recursive: true });
});

test('retry-load samples become single-sample blocks; a block missing an arm errors', () => {
  const corpus = mkdtempSync(join(tmpdir(), 'corpus-'));
  writeRun(join(corpus, 'run-base'), BASE);
  writeRun(join(corpus, 'run-retry'), TREAT);
  expect(() =>
    loadCorpus(corpus, manifest([
      { run_id: 'run-base', arm: 'baseline' },
      { run_id: 'run-retry', arm: 'treatment', role: 'retry-load' },
    ])),
  ).toThrow(ReplayLoadError); // scored block has only one arm
  const loaded = loadCorpus(corpus, manifest([
    { run_id: 'run-base', arm: 'baseline', role: 'retry-load' },
    { run_id: 'run-retry', arm: 'treatment', role: 'retry-load' },
  ]));
  expect(loaded.blocks).toHaveLength(2);
  expect(loaded.blocks.every((b) => b.samples.length === 1)).toBe(true);
  rmSync(corpus, { recursive: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/campaign-replay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the loader**

```ts
// src/campaign/replay.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ReplayManifest,
  ReplayManifestSchema,
  type ReplayRecord,
} from '../contracts/replay.ts';

export class ReplayLoadError extends Error {}

export interface SimBlockInput {
  block_id: string;
  comparison_id: string;
  cell: string;
  replicate: number;
  order_key: string;
  historical_job: string;
  samples: Array<{ run_id: string; subject_pool: string }>;
}

export interface LoadedCorpus {
  records: Map<string, ReplayRecord>;
  blocks: SimBlockInput[];
  coverage: {
    listed_runs: number;
    excluded_runs_present: number;
    missing_listed_runs: string[];
    surplus_corpus_dirs: string[];
    null_coding_ms: number;
    null_gauntlet_ms: number;
    null_pre_exposure_ms: number;
    gauntlet_lt_coding_anomalies: string[];
  };
}

export function loadManifest(path: string): ReplayManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ReplayLoadError(`manifest unreadable: ${path}: ${String(err)}`);
  }
  const parsed = ReplayManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReplayLoadError(`manifest invalid: ${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Tolerant economics read (the src/cli/costs.ts pattern): the economics
 *  block is opaque in FinalVerdictSchema; pick fields defensively. */
export function recordFromRunDir(runDir: string, runId: string): ReplayRecord {
  const verdict = readJson(join(runDir, 'verdict.json'));
  if (!verdict) throw new ReplayLoadError(`${runId}: verdict.json missing/unparseable`);
  const startedAt = Date.parse(str(verdict.started_at) ?? '');
  const finishedAt = Date.parse(str(verdict.finished_at) ?? '');
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    throw new ReplayLoadError(`${runId}: invalid started_at/finished_at`);
  }
  const economics = (verdict.economics ?? {}) as Record<string, unknown>;
  const coding = (economics.coding_agent ?? {}) as Record<string, unknown>;
  const gauntlet = (economics.gauntlet ?? {}) as Record<string, unknown>;

  let gauntletMs = num(gauntlet.duration_ms);
  if (gauntletMs === null) {
    const gResultsDir = join(runDir, 'gauntlet-agent', 'results');
    if (existsSync(gResultsDir)) {
      for (const id of readdirSync(gResultsDir)) {
        const result = readJson(join(gResultsDir, id, 'result.json'));
        const d = result ? num(result.duration_ms) : null;
        if (d !== null) {
          gauntletMs = d;
          break;
        }
      }
    }
  }

  let preExposureMs: number | null = null;
  const trajectory = readJson(join(runDir, 'trajectory.json'));
  const steps = trajectory?.steps;
  if (Array.isArray(steps)) {
    const stamps = steps
      .map((s) => Date.parse(str((s as Record<string, unknown>).timestamp) ?? ''))
      .filter((t) => Number.isFinite(t));
    if (stamps.length > 0) {
      const first = Math.min(...stamps);
      if (first < startedAt) {
        throw new ReplayLoadError(`${runId}: first trajectory step predates started_at`);
      }
      preExposureMs = first - startedAt;
    }
  }

  return {
    run_id: runId,
    scenario: str(verdict.scenario) ?? '?',
    agent: str(verdict.coding_agent) ?? '?',
    credential: str(verdict.credential) ?? '?',
    os: str(verdict.os) ?? 'linux',
    pool_id: '', // assigned by loadCorpus from the manifest
    arm: 'single', // assigned by loadCorpus
    wall_ms: finishedAt - startedAt,
    coding_ms: num(coding.duration_ms),
    gauntlet_ms: gauntletMs,
    pre_exposure_ms: preExposureMs,
    cost_subject_usd: num(coding.est_cost_usd),
    cost_grader_usd: num(gauntlet.est_cost_usd),
    cost_total_usd: num(economics.total_est_cost_usd),
  };
}

export function loadCorpus(corpusDir: string, manifest: ReplayManifest): LoadedCorpus {
  const listed = new Map<string, { arm: 'baseline' | 'treatment'; poolId: string }>();
  const sampleMeta = new Map<
    string,
    { comparisonId: string; cell: string; replicate: number; blockId: string; historicalJob: string; role: 'scored' | 'retry-load' }
  >();
  for (const comparison of manifest.comparisons) {
    for (const cell of comparison.cells) {
      for (const sample of cell.samples) {
        listed.set(sample.run_id, { arm: sample.arm, poolId: comparison.pool_id });
        sampleMeta.set(sample.run_id, {
          comparisonId: comparison.comparison_id,
          cell: cell.scenario,
          replicate: sample.replicate,
          blockId: sample.block_id,
          historicalJob: sample.historical_job,
          role: sample.role,
        });
      }
    }
  }
  const excluded = new Set(manifest.excluded_run_ids.map((x) => x.run_id));

  const onDisk = existsSync(corpusDir)
    ? readdirSync(corpusDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'batches')
        .map((e) => e.name)
    : [];
  const surplus = onDisk.filter((d) => !listed.has(d) && !excluded.has(d)).sort();
  if (surplus.length > 0) {
    throw new ReplayLoadError(`surplus corpus run dirs not in manifest: ${surplus.join(', ')}`);
  }
  const missing = [...listed.keys()].filter((id) => !onDisk.includes(id)).sort();
  if (missing.length > 0) {
    throw new ReplayLoadError(`manifest runs missing from corpus: ${missing.join(', ')}`);
  }

  const coverage = {
    listed_runs: listed.size,
    excluded_runs_present: onDisk.filter((d) => excluded.has(d)).length,
    missing_listed_runs: [] as string[],
    surplus_corpus_dirs: [] as string[],
    null_coding_ms: 0,
    null_gauntlet_ms: 0,
    null_pre_exposure_ms: 0,
    gauntlet_lt_coding_anomalies: [] as string[],
  };

  const records = new Map<string, ReplayRecord>();
  for (const [runId, meta] of listed) {
    const runDir = join(corpusDir, runId);
    if (!statSync(runDir).isDirectory()) continue;
    const rec = recordFromRunDir(runDir, runId);
    // Arm verification against the frozen SHAs.
    const verdict = readJson(join(runDir, 'verdict.json'))!;
    const provenance = (verdict.provenance ?? {}) as Record<string, unknown>;
    const rev = str(provenance.superpowers_rev);
    const expected = meta.arm === 'baseline' ? manifest.arms.baseline_sha : manifest.arms.treatment_sha;
    if (rev !== expected) {
      throw new ReplayLoadError(
        `${runId}: superpowers_rev ${rev ?? 'null'} does not match ${meta.arm} SHA ${expected}`,
      );
    }
    if (provenance.superpowers_dirty === true) {
      throw new ReplayLoadError(`${runId}: superpowers_dirty is true — corpus contamination`);
    }
    records.set(runId, { ...rec, pool_id: meta.poolId, arm: meta.arm });
    if (rec.coding_ms === null) coverage.null_coding_ms++;
    if (rec.gauntlet_ms === null) coverage.null_gauntlet_ms++;
    if (rec.pre_exposure_ms === null) coverage.null_pre_exposure_ms++;
    if (rec.gauntlet_ms !== null && rec.coding_ms !== null && rec.gauntlet_ms < rec.coding_ms) {
      coverage.gauntlet_lt_coding_anomalies.push(runId);
    }
  }

  // Blocks: scored pairs grouped by block_id; retry-load → single-sample.
  const scoredGroups = new Map<string, string[]>();
  const blocks: SimBlockInput[] = [];
  for (const [runId, meta] of sampleMeta) {
    if (!records.has(runId)) continue;
    if (meta.role === 'retry-load') {
      blocks.push({
        block_id: `${meta.blockId}/retry-${runId}`,
        comparison_id: meta.comparisonId,
        cell: meta.cell,
        replicate: meta.replicate,
        order_key: `${meta.comparisonId}|${meta.cell}|${String(meta.replicate).padStart(4, '0')}|retry-${runId}`,
        historical_job: meta.historicalJob,
        samples: [{ run_id: runId, subject_pool: listed.get(runId)!.poolId }],
      });
      continue;
    }
    const group = scoredGroups.get(meta.blockId) ?? [];
    group.push(runId);
    scoredGroups.set(meta.blockId, group);
  }
  for (const [blockId, runIds] of scoredGroups) {
    if (runIds.length !== 2) {
      throw new ReplayLoadError(`scored block ${blockId} has ${runIds.length} samples (expected 2)`);
    }
    const arms = new Set(runIds.map((id) => listed.get(id)!.arm));
    if (arms.size !== 2) {
      throw new ReplayLoadError(`scored block ${blockId} does not hold one baseline + one treatment`);
    }
    const meta = sampleMeta.get(runIds[0]!)!;
    blocks.push({
      block_id: blockId,
      comparison_id: meta.comparisonId,
      cell: meta.cell,
      replicate: meta.replicate,
      order_key: `${meta.comparisonId}|${meta.cell}|${String(meta.replicate).padStart(4, '0')}|${blockId}`,
      historical_job: meta.historicalJob,
      samples: runIds.sort().map((id) => ({ run_id: id, subject_pool: listed.get(id)!.poolId })),
    });
  }
  blocks.sort((a, b) => a.order_key.localeCompare(b.order_key));

  return { records, blocks, coverage };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/campaign-replay.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/campaign/replay.ts test/campaign-replay.test.ts
git commit -m "feat(campaign): run-ID-exact replay loader with arm verification + loud raggedness errors"
```

---

### Task 5: Simulation engine core (`simulate`)

**Files:**
- Create: `src/campaign/simulate.ts`
- Test: `test/campaign-simulate.test.ts`

**Interfaces:**
- Consumes: `SimBlockInput` (Task 4), `ReplayRecord` (Task 1).
- Produces (consumed by Tasks 6, 8, 9):
  - `simulate(blocks: SimBlock[], config: SimConfig): SimResult`
  - `toSimBlocks(loaded: LoadedCorpus, estimateFor: (runId: string) => number): SimBlock[]` — adapter from Task 4's output; `estimateFor` supplies each run's ordering estimate in ms (the CLI wires it to `lookupEstimate`; tests wire constants).
  - Types below. Ordering modes: `'estimates' | 'oracle' | 'historical-fifo'`. Grader occupancy modes: `'gauntlet' | 'gauntlet-active' | 'wall'`.

Semantics (pinned by spec):
- Demand per sample: 1 slot in `subject_pool`, 1 in `__grader__`, 1 in `__global__` — aggregated per pool per block (same pool twice = 2), atomic at one instant, or the block waits.
- Per-sample release: subject+global at `start + wall_ms`; grader at `start + graderHoldMs` where `graderHoldMs` = `gauntlet_ms ?? wall_ms` (mode `gauntlet`), `max(0, (gauntlet_ms ?? wall_ms) − (coding_ms ?? 0))` (mode `gauntlet-active`), or `wall_ms` (mode `wall`).
- Greedy scan with backfill at every event instant; ordering per mode with `order_key` tie-break; `historical-fifo` = manifest order, no sort.
- Cap-1 subject pool + two-arm same-pool block → `SimConfigError` (loud, at engine start).
- Wait attribution: at a block's first failed instant, the binding pool(s) = demanded pools whose next-available instant is latest (ties → split the charge); on admission, charge `admit − firstWait` to the binding pool(s) evenly.
- `busy_slot_ms` per pool: sum of actual holds (subject/global: each sample's `wall_ms`; grader: each sample's `graderHoldMs`). `lower_bound_ms = busy_slot_ms / cap`. `saturation_ms`: time at cap.

- [ ] **Step 1: Write the failing test (synthetic exact oracles)**

```ts
// test/campaign-simulate.test.ts
import { expect, test } from 'bun:test';
import { simulate, SimConfigError, type SimBlock } from '../src/campaign/simulate.ts';

function block(id: string, pool: string, walls: number[], orderKey?: string): SimBlock {
  return {
    block_id: id,
    comparison_id: 'cmp',
    cell: 'cell',
    replicate: 1,
    order_key: orderKey ?? id,
    samples: walls.map((w, i) => ({
      run_id: `${id}-s${i}`,
      subject_pool: pool,
      wall_ms: w,
      gauntlet_ms: w,
      coding_ms: w,
      pre_exposure_ms: null,
      estimate_ms: w,
    })),
  };
}

const CFG = (over: Partial<Parameters<typeof simulate>[1]>): Parameters<typeof simulate>[1] => ({
  subject_caps: { p1: 5 },
  grader_cap: 100,
  global_cap: 100,
  ordering: 'oracle',
  grader_occupancy: 'gauntlet',
  ...over,
});

test('single block: makespan = max arm wall; busy slots accumulate per sample', () => {
  const r = simulate([block('b1', 'p1', [100, 200])], CFG({}));
  expect(r.makespan_ms).toBe(200);
  expect(r.per_pool.p1!.busy_slot_ms).toBe(300); // 100+200
  expect(r.per_pool.__grader__!.busy_slot_ms).toBe(300);
  expect(r.per_pool.__global__!.busy_slot_ms).toBe(300);
});

test('same-pool two-arm blocks draw 2 slots: cap 2 serializes, cap 4 pairs', () => {
  const blocks = [block('b1', 'p1', [100, 100]), block('b2', 'p1', [100, 100])];
  expect(simulate(blocks, CFG({ subject_caps: { p1: 2 } })).makespan_ms).toBe(200);
  expect(simulate(blocks, CFG({ subject_caps: { p1: 4 } })).makespan_ms).toBe(100);
});

test('cap-1 pool with a same-pool two-arm block is a loud infeasibility', () => {
  expect(() => simulate([block('b1', 'p1', [100, 100])], CFG({ subject_caps: { p1: 1 } }))).toThrow(SimConfigError);
});

test('grader pool binds: two blocks, grader_cap 1 → serialized despite subject headroom', () => {
  const blocks = [block('b1', 'p1', [100]), block('b2', 'p2', [100])];
  const r = simulate(blocks, CFG({ subject_caps: { p1: 5, p2: 5 }, grader_cap: 1 }));
  expect(r.makespan_ms).toBe(200);
});

test('global cap counts runs: two-arm block needs 2 global slots', () => {
  const blocks = [block('b1', 'p1', [100, 100]), block('b2', 'p1', [100])];
  const r = simulate(blocks, CFG({ subject_caps: { p1: 9 }, global_cap: 2 }));
  expect(r.makespan_ms).toBe(200); // b1 fills both slots; b2 waits
});

test('oracle ordering: longest first; backfill admits shorter blocks past a waiting giant', () => {
  // giant needs 2 slots of cap 3; two smalls need 1 each. At t=0 with
  // oracle order giant+small+small all fit (3 slots). Force the giant to
  // wait: add a filler block b0 (2 slots, wall 50) ahead.
  const giant = block('giant', 'p1', [300, 300]);
  const small1 = block('small1', 'p1', [100]);
  const small2 = block('small2', 'p1', [100]);
  const filler = block('filler', 'p1', [50, 50], 'aaa-filler');
  // oracle order: giant(300) > small(100) > filler(50)? filler wall 50.
  // Reorder: oracle sorts by max wall desc → giant, small1, small2, filler.
  // cap 3: giant fits (2/3), small1 fits (3/3), small2 waits, filler skipped-over? filler fits? 3/3 used → waits.
  const r = simulate([giant, small1, small2, filler], CFG({ subject_caps: { p1: 3 } }));
  // t=0: giant(0-300,2 slots), small1(0-100). t=100: small1 done → small2
  // AND filler both fit (2 free). Backfill admits both in one instant.
  expect(r.makespan_ms).toBe(300);
  expect(r.per_pool.p1!.busy_slot_ms).toBe(300 + 300 + 100 + 100 + 100);
});

test('wait attribution: waiting block charges the binding pool', () => {
  const a = block('a', 'p1', [200, 200]);
  const b = block('b', 'p2', [200, 200], 'bbb');
  const r = simulate([a, b], CFG({ subject_caps: { p1: 2, p2: 2 }, grader_cap: 3, global_cap: 2 }));
  // global cap 2: a fits (2 slots), b waits 200ms on __global__.
  expect(r.makespan_ms).toBe(400);
  expect(r.per_pool.__global__!.attributed_wait_ms).toBe(200);
  expect(r.per_pool.p2!.attributed_wait_ms).toBe(0);
});

test('historical-fifo preserves manifest order regardless of wall length', () => {
  const long = block('long', 'p1', [400], 'aaa');
  const short = block('short', 'p1', [100], 'zzz');
  const r = simulate([long, short], CFG({ subject_caps: { p1: 1 }, ordering: 'historical-fifo' }));
  expect(r.makespan_ms).toBe(500); // long first (400), then short (100)
  const r2 = simulate([long, short], CFG({ subject_caps: { p1: 1 }, ordering: 'oracle' }));
  expect(r2.makespan_ms).toBe(500); // same here; order check is in the sequence — see admission log
  expect(r.admission_sequence).toEqual(['long', 'short']);
});

test('grader occupancy modes change grader busy time, not makespan drivers', () => {
  const b = block('b1', 'p1', [200]);
  b.samples[0]!.gauntlet_ms = 200;
  b.samples[0]!.coding_ms = 150;
  const full = simulate([b], CFG({}));
  const active = simulate([{ ...b }], CFG({ grader_occupancy: 'gauntlet-active' }));
  expect(full.per_pool.__grader__!.busy_slot_ms).toBe(200);
  expect(active.per_pool.__grader__!.busy_slot_ms).toBe(50);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/campaign-simulate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

```ts
// src/campaign/simulate.ts
import type { LoadedCorpus } from './replay.ts';

export class SimConfigError extends Error {}

export interface SimSample {
  run_id: string;
  subject_pool: string;
  wall_ms: number;
  gauntlet_ms: number | null;
  coding_ms: number | null;
  pre_exposure_ms: number | null;
  estimate_ms: number;
}

export interface SimBlock {
  block_id: string;
  comparison_id: string;
  cell: string;
  replicate: number;
  order_key: string;
  samples: SimSample[];
}

export interface SimConfig {
  subject_caps: Record<string, number>;
  grader_cap: number;
  global_cap: number;
  ordering: 'estimates' | 'oracle' | 'historical-fifo';
  grader_occupancy: 'gauntlet' | 'gauntlet-active' | 'wall';
}

export interface PoolStats {
  busy_slot_ms: number;
  lower_bound_ms: number;
  attributed_wait_ms: number;
  saturation_ms: number;
}

export interface SimResult {
  makespan_ms: number;
  per_pool: Record<string, PoolStats>;
  blocks_completed: number;
  samples_completed: number;
  admission_sequence: string[];
}

export const GRADER_POOL = '__grader__';
export const GLOBAL_POOL = '__global__';

export function toSimBlocks(
  loaded: LoadedCorpus,
  estimateFor: (runId: string) => number,
): SimBlock[] {
  return loaded.blocks.map((b) => ({
    block_id: b.block_id,
    comparison_id: b.comparison_id,
    cell: b.cell,
    replicate: b.replicate,
    order_key: b.order_key,
    samples: b.samples.map((s) => {
      const rec = loaded.records.get(s.run_id);
      if (!rec) throw new SimConfigError(`missing record for ${s.run_id}`);
      return {
        run_id: s.run_id,
        subject_pool: s.subject_pool,
        wall_ms: rec.wall_ms,
        gauntlet_ms: rec.gauntlet_ms,
        coding_ms: rec.coding_ms,
        pre_exposure_ms: rec.pre_exposure_ms,
        estimate_ms: estimateFor(s.run_id),
      };
    }),
  }));
}

interface Active {
  blockId: string;
  runId: string;
  subjectPool: string;
  wallMs: number;
  graderHoldMs: number;
  subjectReleaseAt: number;
  graderReleaseAt: number;
}

function graderHold(sample: SimSample, mode: SimConfig['grader_occupancy']): number {
  const g = sample.gauntlet_ms ?? sample.wall_ms;
  if (mode === 'gauntlet') return g;
  if (mode === 'wall') return sample.wall_ms;
  return Math.max(0, g - (sample.coding_ms ?? 0)); // gauntlet-active
}

function blockPriority(block: SimBlock, ordering: SimConfig['ordering']): number {
  if (ordering === 'oracle') return Math.max(...block.samples.map((s) => s.wall_ms));
  return Math.max(...block.samples.map((s) => s.estimate_ms)); // estimates
}

export function simulate(blocks: SimBlock[], config: SimConfig): SimResult {
  // Structural infeasibility: cap-1 (or < demand) pools, loud at start.
  const demandOf = (b: SimBlock): Map<string, number> => {
    const d = new Map<string, number>();
    for (const s of b.samples) {
      d.set(s.subject_pool, (d.get(s.subject_pool) ?? 0) + 1);
      d.set(GRADER_POOL, (d.get(GRADER_POOL) ?? 0) + 1);
      d.set(GLOBAL_POOL, (d.get(GLOBAL_POOL) ?? 0) + 1);
    }
    return d;
  };
  const caps = new Map<string, number>(Object.entries(config.subject_caps));
  caps.set(GRADER_POOL, config.grader_cap);
  caps.set(GLOBAL_POOL, config.global_cap);
  for (const b of blocks) {
    for (const [pool, need] of demandOf(b)) {
      const cap = caps.get(pool);
      if (cap === undefined) throw new SimConfigError(`no cap for pool ${pool} (block ${b.block_id})`);
      if (cap < need) {
        throw new SimConfigError(
          `block ${b.block_id} demands ${need} slots from pool ${pool} with cap ${cap} — structurally infeasible`,
        );
      }
    }
  }

  const queue =
    config.ordering === 'historical-fifo'
      ? [...blocks]
      : [...blocks].sort(
          (a, b2) =>
            blockPriority(b2, config.ordering) - blockPriority(a, config.ordering) ||
            a.order_key.localeCompare(b2.order_key),
        );

  const active: Active[] = [];
  const stats = new Map<string, PoolStats>();
  const poolIds = new Set<string>([...caps.keys()]);
  for (const id of poolIds) {
    stats.set(id, { busy_slot_ms: 0, lower_bound_ms: 0, attributed_wait_ms: 0, saturation_ms: 0 });
  }
  const atCapSince = new Map<string, number | null>();
  const firstWaitAt = new Map<string, number>();
  const waitBinding = new Map<string, string[]>();
  const admissionSequence: string[] = [];

  const activeCount = (pool: string, t: number): number => {
    let n = 0;
    for (const a of active) {
      if (pool === a.subjectPool && a.subjectReleaseAt > t) n++;
      else if (pool === GRADER_POOL && a.graderReleaseAt > t) n++;
      else if (pool === GLOBAL_POOL && a.subjectReleaseAt > t) n++;
    }
    return n;
  };

  const nextAvailable = (pool: string, t: number): number => {
    const cap = caps.get(pool)!;
    if (activeCount(pool, t) < cap) return t;
    const releases = active
      .map((a) => (pool === GRADER_POOL ? a.graderReleaseAt : a.subjectReleaseAt))
      .filter((x) => x > t)
      .sort((x, y) => x - y);
    return releases[0] ?? t;
  };

  const fits = (b: SimBlock, t: number): boolean => {
    for (const [pool, need] of demandOf(b)) {
      if (activeCount(pool, t) + need > caps.get(pool)!) return false;
    }
    return true;
  };

  let t = 0;
  let makespan = 0;
  let samplesCompleted = 0;

  const markSaturation = (newT: number) => {
    if (newT === t) return;
    for (const id of poolIds) {
      if (atCapSince.get(id) != null) {
        stats.get(id)!.saturation_ms += newT - t;
        atCapSince.set(id, null);
      }
      if (activeCount(id, newT) >= caps.get(id)!) atCapSince.set(id, newT);
    }
  };

  for (;;) {
    // Admit (greedy scan with backfill).
    for (const b of [...queue]) {
      if (!fits(b, t)) {
        if (!firstWaitAt.has(b.block_id)) {
          firstWaitAt.set(b.block_id, t);
          const demanded = [...demandOf(b).keys()];
          const latest = Math.max(...demanded.map((p) => nextAvailable(p, t)));
          waitBinding.set(
            b.block_id,
            demanded.filter((p) => nextAvailable(p, t) === latest),
          );
        }
        continue;
      }
      queue.splice(queue.indexOf(b), 1);
      for (const s of b.samples) {
        const hold = graderHold(s, config.grader_occupancy);
        active.push({
          blockId: b.block_id,
          runId: s.run_id,
          subjectPool: s.subject_pool,
          wallMs: s.wall_ms,
          graderHoldMs: hold,
          subjectReleaseAt: t + s.wall_ms,
          graderReleaseAt: t + hold,
        });
        stats.get(s.subjectPool)!.busy_slot_ms += s.wall_ms;
        stats.get(GLOBAL_POOL)!.busy_slot_ms += s.wall_ms;
        stats.get(GRADER_POOL)!.busy_slot_ms += hold;
        makespan = Math.max(makespan, t + s.wall_ms);
        samplesCompleted++;
      }
      admissionSequence.push(b.block_id);
      if (firstWaitAt.has(b.block_id)) {
        const wait = t - firstWaitAt.get(b.block_id)!;
        const binding = waitBinding.get(b.block_id)!;
        for (const p of binding) stats.get(p)!.attributed_wait_ms += wait / binding.length;
      }
    }
    if (queue.length === 0 && active.length === 0) break;

    // Advance to the next release instant.
    const nextT = Math.min(
      ...active.flatMap((a) => [a.subjectReleaseAt, a.graderReleaseAt].filter((x) => x > t)),
    );
    if (!Number.isFinite(nextT)) break;
    markSaturation(nextT);
    t = nextT;
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i]!.subjectReleaseAt <= t && active[i]!.graderReleaseAt <= t) {
        active.splice(i, 1);
      }
    }
  }

  const per_pool: Record<string, PoolStats> = {};
  for (const [id, s] of stats) {
    const cap = caps.get(id)!;
    per_pool[id] = { ...s, lower_bound_ms: cap > 0 ? s.busy_slot_ms / cap : 0 };
  }
  return {
    makespan_ms: makespan,
    per_pool,
    blocks_completed: admissionSequence.length,
    samples_completed: samplesCompleted,
    admission_sequence: admissionSequence,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-simulate.test.ts`
Expected: PASS (9 tests). If the backfill or attribution test disagrees with the implementation, THE TEST IS THE ORACLE — fix the implementation, not the expectation, unless the expectation's arithmetic is demonstrably wrong (document why in the commit message).

- [ ] **Step 5: Commit**

```bash
git add src/campaign/simulate.ts test/campaign-simulate.test.ts
git commit -m "feat(campaign): discrete-event simulation engine — atomic demand vectors, per-sample release, backfill, wait attribution"
```

---

### Task 6: CLI verbs (`campaign acquire|estimates|simulate`) + registration

**Files:**
- Create: `src/cli/campaign.ts`
- Modify: `src/cli/index.ts` (register the `campaign` parent command after `export-runs`, before `show`)
- Test: `test/cli-campaign.test.ts`
- Modify: `AGENTS.md` (Architecture: add `src/campaign/` bullet)

**Interfaces:**
- Consumes: `acquireCorpus` (Task 3), `loadManifest`/`loadCorpus` (Task 4), `buildEstimates`/`lookupEstimate`/`serializeEstimates` (Task 2), `simulate`/`toSimBlocks` (Task 5).
- Produces (consumed by Tasks 8, 9): three verbs —
  - `quorum campaign acquire --runs-file <path> --results-root <dir> --out <dir>`
  - `quorum campaign estimates --corpus <dir> --manifest <path> [--scan-results <resultsRoot> | --inclusion <path>] --out <path>`
  - `quorum campaign simulate --corpus <dir> --manifest <path> --estimates <path> [--sweep <name=default> | --config <json>] [--pool-identity target|legacy] [--ordering estimates|oracle|historical-fifo] [--grader-occupancy gauntlet|gauntlet-active|wall] [--seal-allowance-min <n=15>] --out <dir>`

Sweep definition (the `default` preset): subject caps {5,15,20} × global {8,12,20,24} × grader caps {5,15,20}, run under BOTH pool identities (72 runs), ordering `estimates`, grader occupancy `gauntlet`. Sensitivity presets (each labeled, target identity only): `oracle` (ordering), `grader-active` (occupancy). Output per run appended to `<out>/sweep-results.jsonl` (one JSON per line: config + SimResult + allowance-inclusive makespan) plus `<out>/sweep-table.md` (the experiment-entry table: config, nominal makespan, +reserve stress, +allowance, wait attribution per pool, 8h verdict).

Reserve stress (pinned): for each cell, duplicate the slowest ceil(20%) of its blocks (the gate's authorized +20% retry budget), tagged `synthetic-reserve`, durations = the duplicated blocks' own walls; rerun the sweep with the inflated block set; report as the stress column.

`--config <json>`: single explicit run, e.g. `{"subject_caps":{"*":15},"grader_cap":15,"global_cap":12,"ordering":"estimates","grader_occupancy":"gauntlet"}` — `"*"` applies one cap to all subject pools. Prints the single result as JSON to stdout.

Estimates verb modes: `--scan-results <resultsRoot>` prints an inclusion manifest (JSON: `{run_ids: [...], hashes: {run_id: sha256-of-verdict}}`) for local runs whose verdict parses with valid wall/identity — maintainer reviews and commits it; `--inclusion <path>` builds records from those local run dirs (via `recordFromRunDir`, arm `'single'`, `pool_id` from each run's own verdict credential resolved against the gate-era credential map embedded in the manifest file's `credential_pools` field — for v1, `pool_id` = the credential name; estimates don't dispatch on these, they only aggregate).

- [ ] **Step 1: Write the failing test (CLI end-to-end on fixtures)**

```ts
// test/cli-campaign.test.ts
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const p = spawnSync('bun', [CLI, ...args], { encoding: 'utf8' });
  return { status: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
}

const BASE = 'a'.repeat(40);
const TREAT = 'b'.repeat(40);

function writeRun(dir: string, rev: string, wallMs: number) {
  mkdirSync(join(dir, 'gauntlet-agent', 'results', 'g1'), { recursive: true });
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify({
    schema: 1, final: 'pass', scenario: 'sdd-escalates', coding_agent: 'claude',
    credential: 'opus_bedrock', os: 'linux',
    started_at: '2026-08-08T00:00:00.000Z',
    finished_at: new Date(Date.parse('2026-08-08T00:00:00.000Z') + wallMs).toISOString(),
    provenance: { superpowers_rev: rev },
    economics: {
      coding_agent: { duration_ms: wallMs - 100_000, est_cost_usd: 1.0 },
      gauntlet: { duration_ms: wallMs - 40_000, est_cost_usd: 0.1 },
      total_est_cost_usd: 1.1,
    },
  }));
  writeFileSync(join(dir, 'trajectory.json'), JSON.stringify({ steps: [{ timestamp: '2026-08-08T00:00:30.000Z' }] }));
  writeFileSync(join(dir, 'coding-agent-token-usage.json'), '{}');
  writeFileSync(join(dir, 'gauntlet-agent', 'results', 'g1', 'result.json'), JSON.stringify({ duration_ms: wallMs - 40_000 }));
}

function fixture(): { corpus: string; manifest: string } {
  const corpus = mkdtempSync(join(tmpdir(), 'cli-corpus-'));
  writeRun(join(corpus, 'run-base'), BASE, 600_000);
  writeRun(join(corpus, 'run-treat'), TREAT, 660_000);
  const manifest = join(corpus, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({
    schema_version: 'quorum.replay-manifest/v1',
    name: 'fixture',
    source_docs: ['docs/experiments/2026-08-08-fresh-release-gate.md'],
    arms: { baseline_sha: BASE, treatment_sha: TREAT },
    comparisons: [{
      comparison_id: 'opus_bedrock', credential: 'opus_bedrock',
      pool_id: 'poolP', legacy_pool_id: 'poolLegacy',
      cells: [{ scenario: 'sdd-escalates', class: 'confirmatory', samples: [
        { run_id: 'run-base', arm: 'baseline', replicate: 1, block_id: 'c/1', historical_job: 'j1', role: 'scored' },
        { run_id: 'run-treat', arm: 'treatment', replicate: 1, block_id: 'c/1', historical_job: 'j1', role: 'scored' },
      ] }],
    }],
    excluded_run_ids: [],
  }));
  return { corpus, manifest };
}

test('campaign estimates then campaign simulate --config end-to-end', () => {
  const { corpus, manifest } = fixture();
  const estimatesPath = join(corpus, 'estimates.json');
  const est = run(['campaign', 'estimates', '--corpus', corpus, '--manifest', manifest, '--out', estimatesPath]);
  expect(est.status).toBe(0);
  const artifact = JSON.parse(readFileSync(estimatesPath, 'utf8'));
  expect(artifact.schema_version).toBe('quorum.estimates/v1');
  expect(artifact.entries[0].duration_s_median).toBe(630);

  const out = mkdtempSync(join(tmpdir(), 'cli-sim-'));
  const sim = run([
    'campaign', 'simulate', '--corpus', corpus, '--manifest', manifest,
    '--estimates', estimatesPath,
    '--config', '{"subject_caps":{"*":2},"grader_cap":2,"global_cap":4,"ordering":"estimates","grader_occupancy":"gauntlet"}',
    '--out', out,
  ]);
  expect(sim.status).toBe(0);
  const result = JSON.parse(sim.stdout);
  expect(result.makespan_ms).toBe(660_000);
  expect(result.per_pool.poolP.busy_slot_ms).toBe(1_260_000);
  rmSync(corpus, { recursive: true });
  rmSync(out, { recursive: true });
});

test('campaign simulate --sweep default emits results.jsonl + table.md with 8h verdicts', () => {
  const { corpus, manifest } = fixture();
  const estimatesPath = join(corpus, 'estimates.json');
  expect(run(['campaign', 'estimates', '--corpus', corpus, '--manifest', manifest, '--out', estimatesPath]).status).toBe(0);
  const out = mkdtempSync(join(tmpdir(), 'cli-sweep-'));
  const sim = run(['campaign', 'simulate', '--corpus', corpus, '--manifest', manifest, '--estimates', estimatesPath, '--sweep', 'default', '--out', out]);
  expect(sim.status).toBe(0);
  const lines = readFileSync(join(out, 'sweep-results.jsonl'), 'utf8').trim().split('\n');
  expect(lines).toHaveLength(72); // 36 configs × 2 pool identities
  const first = JSON.parse(lines[0]!);
  expect(first.config.pool_identity).toBeDefined();
  expect(typeof first.allowance_inclusive_makespan_ms).toBe('number');
  expect(readFileSync(join(out, 'sweep-table.md'), 'utf8')).toContain('8h verdict');
  rmSync(corpus, { recursive: true });
  rmSync(out, { recursive: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli-campaign.test.ts`
Expected: FAIL — `campaign` is not a known command.

- [ ] **Step 3: Implement `src/cli/campaign.ts` and register it**

```ts
// src/cli/campaign.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireCorpus } from '../campaign/acquire.ts';
import { buildEstimates, serializeEstimates } from '../campaign/estimates.ts';
import { loadCorpus, loadManifest, recordFromRunDir } from '../campaign/replay.ts';
import { simulate, toSimBlocks, type SimBlock, type SimConfig, type SimResult } from '../campaign/simulate.ts';
import { lookupEstimate } from '../campaign/estimates.ts';
import { EstimatesArtifactSchema } from '../contracts/estimates.ts';
import { hostname } from 'node:os';

export interface CampaignAcquireOptions {
  runsFile: string;
  resultsRoot: string;
  out: string;
}

export function campaignAcquire(opts: CampaignAcquireOptions): void {
  const runIds = readFileSync(opts.runsFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const command = `quorum campaign acquire --runs-file ${opts.runsFile} --results-root ${opts.resultsRoot} --out ${opts.out}`;
  const manifest = acquireCorpus({
    resultsRoot: opts.resultsRoot,
    runIds,
    outDir: opts.out,
    sourceHost: hostname(),
    now: new Date().toISOString(), // CLI boundary: wall time OK here (recorded, not hashed)
    command,
  }).then((m) => {
    process.stdout.write(
      `acquired ${m.runs.length} runs (${m.missing_run_ids.length} missing) + ${m.batches.length} batches → ${opts.out}\n`,
    );
    return m;
  });
  void manifest;
}

export interface CampaignEstimatesOptions {
  corpus: string;
  manifest: string;
  scanResults?: string;
  inclusion?: string;
  out: string;
}

export function campaignEstimates(opts: CampaignEstimatesOptions): void {
  const manifest = loadManifest(opts.manifest);
  const loaded = loadCorpus(opts.corpus, manifest);
  const inputs = [...loaded.records.values()].map((record) => {
    // finished_at re-read for generated_at derivation: wall + started.
    const verdict = JSON.parse(
      readFileSync(join(opts.corpus, record.run_id, 'verdict.json'), 'utf8'),
    ) as { finished_at: string };
    return { record, finished_at: verdict.finished_at };
  });
  if (opts.scanResults && !opts.inclusion) {
    // Inclusion-scan PRINT mode (no artifact written): emit the inclusion
    // manifest for maintainer review + commit. When --inclusion is also
    // set, --scan-results instead names the results root inclusion reads
    // from (default 'results').
    const { readdirSync, existsSync } = require('node:fs') as typeof import('node:fs');
    const rows: Array<{ run_id: string; sha256: string }> = [];
    for (const name of readdirSync(opts.scanResults).sort()) {
      const dir = join(opts.scanResults, name);
      if (!existsSync(join(dir, 'verdict.json'))) continue;
      try {
        recordFromRunDir(dir, name);
      } catch {
        continue; // invalid wall/identity → excluded from inclusion
      }
      rows.push({
        run_id: name,
        sha256: Bun.SHA256.hash(readFileSync(join(dir, 'verdict.json')), 'hex'),
      });
    }
    process.stdout.write(`${JSON.stringify({ run_ids: rows.map((r) => r.run_id), hashes: Object.fromEntries(rows.map((r) => [r.run_id, r.sha256])) }, null, 2)}\n`);
    return;
  }
  if (opts.inclusion) {
    const inclusion = JSON.parse(readFileSync(opts.inclusion, 'utf8')) as { run_ids: string[] };
    for (const runId of inclusion.run_ids) {
      const dir = join(opts.scanResults ?? 'results', runId);
      try {
        const record = recordFromRunDir(dir, runId);
        const verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')) as { finished_at: string };
        inputs.push({ record: { ...record, pool_id: record.credential }, finished_at: verdict.finished_at });
      } catch {
        // invalid runs are excluded; the inclusion manifest records the set
      }
    }
  }
  const artifact = buildEstimates(inputs, {
    sources: [opts.corpus, ...(opts.inclusion ? [opts.scanResults ?? 'results'] : [])],
  });
  mkdirSync(join(opts.out, '..'), { recursive: true });
  writeFileSync(opts.out, serializeEstimates(artifact), { mode: 0o644 });
  process.stdout.write(`estimates: ${artifact.entries.length} entries, ${artifact.corpus.run_count} runs → ${opts.out}\n`);
}

interface SweepConfig extends SimConfig {
  pool_identity: 'target' | 'legacy';
}

export interface CampaignSimulateOptions {
  corpus: string;
  manifest: string;
  estimates: string;
  sweep?: string;
  config?: string;
  poolIdentity?: 'target' | 'legacy';
  ordering?: SimConfig['ordering'];
  graderOccupancy?: SimConfig['grader_occupancy'];
  sealAllowanceMin?: string;
  out: string;
}

const SUBJECT_CAPS = [5, 15, 20];
const GLOBAL_CAPS = [8, 12, 20, 24];
const GRADER_CAPS = [5, 15, 20];

function defaultSweep(loadedPools: string[]): SweepConfig[] {
  const configs: SweepConfig[] = [];
  for (const pool_identity of ['target', 'legacy'] as const) {
    for (const sc of SUBJECT_CAPS)
      for (const gc of GLOBAL_CAPS)
        for (const rc of GRADER_CAPS)
          configs.push({
            pool_identity,
            subject_caps: Object.fromEntries(loadedPools.map((p) => [p, sc])),
            grader_cap: rc,
            global_cap: gc,
            ordering: 'estimates',
            grader_occupancy: 'gauntlet',
          });
  }
  return configs;
}

export function campaignSimulate(opts: CampaignSimulateOptions): void {
  const manifest = loadManifest(opts.manifest);
  const loaded = loadCorpus(opts.corpus, manifest);
  const estimates = EstimatesArtifactSchema.parse(
    JSON.parse(readFileSync(opts.estimates, 'utf8')),
  );
  const allowanceMs = Number.parseInt(opts.sealAllowanceMin ?? '15', 10) * 60_000;

  // Pool identity selection: legacy swaps subject_pool per comparison.
  const legacyByComparison = new Map(
    manifest.comparisons.map((c) => [c.comparison_id, c.legacy_pool_id] as const),
  );
  const blocksFor = (identity: 'target' | 'legacy'): SimBlock[] =>
    toSimBlocks(loaded, (runId) => {
      const rec = loaded.records.get(runId)!;
      return lookupEstimate(estimates, {
        scenario: rec.scenario, agent: rec.agent, credential: rec.credential, os: rec.os,
      }).duration_s * 1000;
    }).map((b) =>
      identity === 'target'
        ? b
        : {
            ...b,
            samples: b.samples.map((s) => ({
              ...s,
              subject_pool: legacyByComparison.get(b.comparison_id) ?? s.subject_pool,
            })),
          },
    );

  const runOne = (cfg: SweepConfig): SimResult & { config: SweepConfig; allowance_inclusive_makespan_ms: number } => {
    const result = simulate(blocksFor(cfg.pool_identity), cfg);
    return { ...result, config: cfg, allowance_inclusive_makespan_ms: result.makespan_ms + allowanceMs };
  };

  mkdirSync(opts.out, { recursive: true });

  if (opts.config) {
    const raw = JSON.parse(opts.config) as {
      subject_caps: Record<string, number>;
      grader_cap: number;
      global_cap: number;
      ordering: SimConfig['ordering'];
      grader_occupancy: SimConfig['grader_occupancy'];
    };
    const pools = [...new Set(loaded.blocks.flatMap((b) => b.samples.map((s) => s.subject_pool)))];
    const subject_caps = raw.subject_caps['*'] !== undefined
      ? Object.fromEntries(pools.map((p) => [p, raw.subject_caps['*']!]))
      : raw.subject_caps;
    const cfg: SweepConfig = {
      pool_identity: opts.poolIdentity ?? 'target',
      subject_caps,
      grader_cap: raw.grader_cap,
      global_cap: raw.global_cap,
      ordering: raw.ordering,
      grader_occupancy: raw.grader_occupancy,
    };
    process.stdout.write(`${JSON.stringify(runOne(cfg), null, 2)}\n`);
    return;
  }

  const pools = [...new Set(loaded.blocks.flatMap((b) => b.samples.map((s) => s.subject_pool)))];
  const configs = defaultSweep(pools);
  const results = configs.map(runOne);
  const eightHoursMs = 8 * 3_600_000;

  // Reserve stress (spec-pinned): per cell, duplicate the slowest
  // ceil(20%) of its blocks (the gate's authorized +20% retry budget),
  // tagged synthetic-reserve; rerun the same configs on the inflated set.
  const stressed = (identity: 'target' | 'legacy'): SimBlock[] => {
    const base = blocksFor(identity);
    const byCell = new Map<string, SimBlock[]>();
    for (const b of base) {
      const g = byCell.get(b.cell) ?? [];
      g.push(b);
      byCell.set(b.cell, g);
    }
    const out = [...base];
    for (const cellBlocks of byCell.values()) {
      const slowest = [...cellBlocks]
        .sort((a, b) =>
          Math.max(...b.samples.map((s) => s.wall_ms)) -
          Math.max(...a.samples.map((s) => s.wall_ms)),
        )
        .slice(0, Math.ceil(cellBlocks.length * 0.2));
      for (const b of slowest) {
        out.push({ ...b, block_id: `${b.block_id}/synthetic-reserve` });
      }
    }
    return out;
  };
  const stressResults = configs.map((cfg) => {
    const r = simulate(stressed(cfg.pool_identity), cfg);
    return r.makespan_ms;
  });

  writeFileSync(
    join(opts.out, 'sweep-results.jsonl'),
    results.map((r, i) => JSON.stringify({ ...r, stress_makespan_ms: stressResults[i] })).join('\n') + '\n',
  );
  const table = [
    '| pool_identity | subject_cap | global_cap | grader_cap | nominal | +reserve stress | +allowance | 8h verdict | busiest pool (attributed wait ms) |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r, i) => {
      const busiest = Object.entries(r.per_pool)
        .filter(([p]) => p !== '__global__')
        .sort((a, b) => b[1].attributed_wait_ms - a[1].attributed_wait_ms)[0];
      const hrs = (ms: number) => (ms / 3_600_000).toFixed(2);
      return `| ${r.config.pool_identity} | ${Object.values(r.config.subject_caps)[0]} | ${r.config.global_cap} | ${r.config.grader_cap} | ${hrs(r.makespan_ms)}h | ${hrs(stressResults[i]!)}h | ${hrs(r.allowance_inclusive_makespan_ms)}h | ${r.config.pool_identity === 'target' && r.config.ordering === 'estimates' && r.allowance_inclusive_makespan_ms <= eightHoursMs ? 'PASS' : '—'} | ${busiest?.[0]} (${Math.round(busiest?.[1].attributed_wait_ms ?? 0)}) |`;
    }),
  ].join('\n');
  writeFileSync(join(opts.out, 'sweep-table.md'), `# 8h verdict rule: target identity + estimates ordering + allowance-inclusive only. The stress column adds the +20% registered-reserve draw.\n\n${table}\n`);
  process.stdout.write(`sweep: ${results.length} runs → ${opts.out}/sweep-results.jsonl, sweep-table.md\n`);
}
```

Registration in `src/cli/index.ts` — insert after the `export-runs` block (before `show`), following the existing flat pattern:

```ts
const campaign = program.command('campaign').description('campaign platform (Phase 0: corpus, estimates, simulation)');
campaign
  .command('acquire')
  .description('pull a run-ID-selected corpus (runs on the appliance)')
  .requiredOption('--runs-file <path>', 'newline-delimited run IDs')
  .requiredOption('--results-root <dir>', 'results root to read')
  .requiredOption('--out <dir>', 'corpus output dir')
  .action((opts: CampaignAcquireOptions) => campaignAcquire(opts));
campaign
  .command('estimates')
  .description('build quorum.estimates/v1 from a corpus (+ optional local inclusion)')
  .requiredOption('--corpus <dir>', 'corpus dir')
  .requiredOption('--manifest <path>', 'replay manifest')
  .option('--scan-results <dir>', 'print a local-results inclusion manifest')
  .option('--inclusion <path>', 'consume a committed inclusion manifest')
  .requiredOption('--out <path>', 'artifact output path')
  .action((opts: CampaignEstimatesOptions) => campaignEstimates(opts));
campaign
  .command('simulate')
  .description('replay the corpus through the campaign dispatch policy')
  .requiredOption('--corpus <dir>', 'corpus dir')
  .requiredOption('--manifest <path>', 'replay manifest')
  .requiredOption('--estimates <path>', 'estimates artifact')
  .option('--sweep <name>', 'sweep preset', 'default')
  .option('--config <json>', 'single explicit configuration')
  .option('--pool-identity <target|legacy>', 'pool identity for --config', 'target')
  .option('--ordering <mode>', 'ordering override')
  .option('--grader-occupancy <mode>', 'grader occupancy override')
  .option('--seal-allowance-min <n>', 'seal/report allowance minutes', '15')
  .requiredOption('--out <dir>', 'output dir')
  .action((opts: CampaignSimulateOptions) => campaignSimulate(opts));
```

Add the import at the top of `src/cli/index.ts`:

```ts
import {
  campaignAcquire,
  type CampaignAcquireOptions,
  campaignEstimates,
  type CampaignEstimatesOptions,
  campaignSimulate,
  type CampaignSimulateOptions,
} from './campaign.ts';
```

`AGENTS.md` Architecture — add after the `src/checks/prelude.sh` bullet:

```
- `src/campaign/` — the campaign platform's first module (Phase 0):
  `acquire.ts` (appliance-side corpus pull, run-ID allowlist + selection
  manifest), `replay.ts` (run-ID-exact manifest + loader, loud on
  raggedness), `simulate.ts` (synchronous discrete-event engine: atomic
  per-block demand vectors across subject/grader/global pools, per-sample
  release, greedy backfill, wait attribution), `estimates.ts`
  (`quorum.estimates/v1` builder + fallback lookup). CLI: `quorum campaign
  acquire|estimates|simulate`. Corpora land in gitignored `corpus/`.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/cli-campaign.test.ts`
Expected: PASS (2 tests). Then `bun run check` — fix any biome/tsc issues in place.

- [ ] **Step 5: Commit**

```bash
git add src/cli/campaign.ts src/cli/index.ts test/cli-campaign.test.ts AGENTS.md
git commit -m "feat(cli): quorum campaign acquire|estimates|simulate verbs"
```

---

### Task 7: Committed distilled fixture + historical-mode validation

**Files:**
- Create: `test/fixtures/campaign/batch-20260804T031849Z-2aef.ts`
- Test: `test/campaign-validation.test.ts`

**Interfaces:**
- Consumes: `simulate`/`SimBlock` (Task 5).
- Produces: the portable acceptance proof that the engine reproduces a real observed schedule (historical mode), runnable anywhere (`results/` is gitignored — the live-batch and live-gate replays in Tasks 8/9 are maintainer steps, not repo tests).

- [ ] **Step 1: Distill the real batch into a committed fixture**

Read `results/batches/batch-20260804T031849Z-2aef/results.jsonl` and each named run dir's `verdict.json`. For each of the 7 runs record: `run_id`, `wall_ms` (from `started_at`/`finished_at`), `gauntlet_ms`, `coding_ms`. Observed batch elapsed: `batch.json .finished_at − .started_at` (should be 6,370,019ms — verify and use the actual). Write them as a literal table:

```ts
// test/fixtures/campaign/batch-20260804T031849Z-2aef.ts
import type { SimBlock } from '../../../src/campaign/simulate.ts';

/** Distilled from results/batches/batch-20260804T031849Z-2aef (codex-only,
 *  jobs=2, observed elapsed OBSERVED_ELAPSED_MS ms). Real recorded
 *  durations; identity fields simplified to the simulation's needs. */
export const OBSERVED_ELAPSED_MS = 6_370_019; // verify against batch.json
export const BATCH_JOBS = 2;

export const DISTILLED_BLOCKS: SimBlock[] = [
  // One single-sample block per run, manifest order = results.jsonl order:
  {
    block_id: 'codex-subagent-wait-mapping/1',
    comparison_id: 'codex_sub',
    cell: 'codex-subagent-wait-mapping',
    replicate: 1,
    order_key: 'codex_sub|codex-subagent-wait-mapping|0001|1',
    samples: [{
      run_id: 'codex-subagent-wait-mapping-codex-codex_sub-linux-20260804T031849Z-6bee',
      subject_pool: 'codex_sub|openai-responses',
      wall_ms: 0,        // FILL from the run's verdict.json
      gauntlet_ms: null, // FILL or null
      coding_ms: null,   // FILL or null
      pre_exposure_ms: null,
      estimate_ms: 0,    // unused in historical-fifo
    }],
  },
  // ... one entry per results.jsonl record, in file order
];
```

(FILL values from the real run dirs; keep the comment honest. If any run lacks `finished_at`, drop it and adjust `OBSERVED_ELAPSED_MS` expectations per the remaining records — record the decision in the commit message.)

- [ ] **Step 2: Write the failing validation test**

```ts
// test/campaign-validation.test.ts
import { expect, test } from 'bun:test';
import { simulate } from '../src/campaign/simulate.ts';
import {
  BATCH_JOBS,
  DISTILLED_BLOCKS,
  OBSERVED_ELAPSED_MS,
} from './fixtures/campaign/batch-20260804T031849Z-2aef.ts';

test('historical-mode replay reproduces the observed batch within 10%', () => {
  // Historical semantics: FIFO admission (run-all had no campaign policy),
  // grader uncapped (no grader pool existed), one subject pool per
  // credential at effectively uncapped concurrency, global cap = jobs.
  const result = simulate(DISTILLED_BLOCKS, {
    subject_caps: { 'codex_sub|openai-responses': Number.POSITIVE_INFINITY },
    grader_cap: Number.POSITIVE_INFINITY,
    global_cap: BATCH_JOBS,
    ordering: 'historical-fifo',
    grader_occupancy: 'wall',
  });
  const ratio = result.makespan_ms / OBSERVED_ELAPSED_MS;
  expect(ratio).toBeGreaterThan(0.9);
  expect(ratio).toBeLessThan(1.1);
});

test('historical replay reports global-pool busy time consistent with sum of walls', () => {
  const result = simulate(DISTILLED_BLOCKS, {
    subject_caps: { 'codex_sub|openai-responses': Number.POSITIVE_INFINITY },
    grader_cap: Number.POSITIVE_INFINITY,
    global_cap: BATCH_JOBS,
    ordering: 'historical-fifo',
    grader_occupancy: 'wall',
  });
  const sumWalls = DISTILLED_BLOCKS.reduce((n, b) => n + b.samples[0]!.wall_ms, 0);
  expect(result.per_pool.__global__!.busy_slot_ms).toBe(sumWalls);
});
```

- [ ] **Step 3: Run to verify pass/fail state**

Run: `bun test test/campaign-validation.test.ts`
Expected: PASS once the fixture holds real values (if the ratio lands outside [0.9, 1.1], INVESTIGATE the engine before touching the tolerance — this is the acceptance check, per spec; a mismatch here invalidates every gate prediction).

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/campaign/batch-20260804T031849Z-2aef.ts test/campaign-validation.test.ts
git commit -m "test(campaign): distilled real-batch fixture — historical replay reproduces observed schedule"
```

---

### Task 8: Corpus pull + canonical replay manifest curation (trusted maintainer steps)

**Files:**
- Create: `corpus/runs-gate-20260808.txt` (run-ID allowlist, gitignored with the corpus)
- Create: `src/campaign/replay-manifest.gate-20260808.json` (committed)
- Create: `src/campaign/replay-manifest.gate-20260808-copilot.json` (committed)
- Modify: `docs/appliance-runbook.md` (document the acquire verb)

These are trusted-maintainer steps on the appliance (`docs/appliance-runbook.md`). Nothing here runs in CI.

- [ ] **Step 1: Enumerate the gate run IDs on the appliance**

Through the installed appliance helper (never raw ad-hoc ssh; see the runbook), on the appliance list run dirs from 2026-08-08/09 matching the gate credentials, and write the allowlist locally:

```bash
scripts/evals-container exec -- bash -lc 'ls /srv/quorum/results | grep -E "2026080(8|9)T" | grep -E "(opus_bedrock|opus5_bedrock|openai_responses_56sol|openai_responses_56luna|copilot_opus5|copilot_gpt56_sol)"' > corpus/enumeration-20260808.txt
```

Eyeball the count: 388 scored + retries + copilot 196 expected territory. Investigate anything wildly off BEFORE pulling (a wrong enumeration poisons the manifest).

- [ ] **Step 2: Split the allowlist and acquire the corpus**

Split `corpus/enumeration-20260808.txt` into `corpus/runs-gate-20260808.txt` (the 388-workload credentials) and `corpus/runs-gate-20260808-copilot.txt` (copilot pair), then run acquisition on the appliance:

```bash
scripts/evals-container exec -- bun run quorum campaign acquire \
  --runs-file /srv/quorum/runs-gate-20260808.txt \
  --results-root /srv/quorum/results \
  --out /srv/quorum/corpus-export/gate-20260808
# (repeat for the copilot list), then transfer both corpus dirs +
# selection-manifest.json to this checkout's corpus/gate-20260808/ and
# corpus/gate-20260808-copilot/ (scp/rsync; the payload is scrubbed —
# no homes, no transcripts).
```

Record the exact commands + `selection-manifest.json` summary (run count, missing IDs) for the experiment entry.

- [ ] **Step 3: Curate the canonical replay manifest**

Author `src/campaign/replay-manifest.gate-20260808.json` from the two experiment docs (per-cell citations in `source_docs`) + the enumeration:

- Four comparisons (`opus_bedrock`, `opus5_bedrock`, `openai_responses_56sol`, `openai_responses_56luna`) + the sentinel rider as a fifth comparison on `opus_bedrock` (two-arm, T-class, n=2/arm).
- Per cell: `class` from the gate doc's C/P/T/D table; samples from the readout's observed runs; retries labeled `retry-load`.
- `pool_id` (target policy): resolve from the GATE-ERA credential definitions — `git log --oneline --before=2026-08-09 credentials.yaml` to find the gate-era revision, `git show <rev>:credentials.yaml`, then `quota_pool` key if set else `(base_url ?? name)|api|model`. `legacy_pool_id` = `(base_url ?? name)|api`.
- `excluded_run_ids`: bootstrap probes, no-verdict dirs (in the enumeration but unacquirable), reboot orphans — each with a reason.
- Same for `replay-manifest.gate-20260808-copilot.json`.

- [ ] **Step 4: Validate the manifest against the corpus (loader is the checker)**

```bash
bun run quorum campaign simulate --corpus corpus/gate-20260808 \
  --manifest src/campaign/replay-manifest.gate-20260808.json \
  --estimates /dev/null --config '{}' --out /tmp/validate || true
```

(Or a one-liner calling `loadCorpus` directly — the point is: iterate curation until `loadCorpus` reports zero loud errors and coverage counts are sane. `null_pre_exposure_ms` and `gauntlet_lt_coding_anomalies` counts go into the experiment entry.)

- [ ] **Step 5: Document the acquire verb in the runbook and commit**

Add a `docs/appliance-runbook.md` section "Exporting a simulation corpus" describing the two commands above and the scrubbed-payload guarantee. Commit only the manifests + runbook (the corpus itself is gitignored):

```bash
git add src/campaign/replay-manifest.gate-20260808.json src/campaign/replay-manifest.gate-20260808-copilot.json docs/appliance-runbook.md
git commit -m "feat(campaign): canonical gate-20260808 replay manifests + acquire runbook"
```

---

### Task 9: Sweep execution, calibration, experiment entry, Linear

**Files:**
- Create: `estimates/v1.json` (committed artifact)
- Create: `docs/experiments/2026-08-2X-phase0-capacity-simulation.md`
- Modify: Linear PRI-2935 (outcome comment), PRI-2874 (errata E1/E2 note)

- [ ] **Step 1: Build the real estimate artifact**

```bash
bun run quorum campaign estimates \
  --corpus corpus/gate-20260808 \
  --manifest src/campaign/replay-manifest.gate-20260808.json \
  --inclusion estimates/inclusion-manifest.json \
  --scan-results results \
  --out estimates/v1.json
```

(First generate the inclusion manifest with `--scan-results results` alone, review it, commit it as `estimates/inclusion-manifest.json`.) Sanity-read the artifact: the claude/opus_bedrock vs opus5_bedrock duration split should reproduce the 17–24m vs 53–116m separation from the readout. Commit: `git add estimates/ && git commit -m "feat(campaign): quorum.estimates/v1 artifact from gate corpus + local inclusion"`.

- [ ] **Step 2: Held-out calibration (the ±15% check, in its proper role)**

Run a calibration pass: for each scenario×agent×credential×os entry with n ≥ 4, rebuild estimates on the even-replicate runs and look up the odd runs' durations; report the share of held-out medians within ±15% of observed medians, per tier. This is a REPORT for the entry (a small `bun` one-liner or `test/`-excluded script over `estimates/v1.json` + the corpus), not a repo test — the numbers are data-dependent.

- [ ] **Step 3: Run the full sweep + sensitivities**

```bash
bun run quorum campaign simulate --corpus corpus/gate-20260808 \
  --manifest src/campaign/replay-manifest.gate-20260808.json \
  --estimates estimates/v1.json --sweep default --out corpus/sweep-target
# labeled sensitivities (target identity only):
#   --ordering oracle          → corpus/sweep-oracle   ("policy ceiling")
#   --grader-occupancy gauntlet-active → corpus/sweep-grader-active
# historical self-replay of the gate corpus (acceptance anchor):
#   per historical job via the batches metadata, historical-fifo ordering,
#   legacy pool identity, grader uncapped; compare vs recorded gate elapsed.
```

- [ ] **Step 3b: Skew evidence distribution (corpus statistic, concrete tooling)**

The skew evidence is a corpus statistic over loaded replay records — measured pairs only, nulls dropped and counted. Compute it with this script (run via `bun -e '…'` or saved scratch — it is analysis tooling for the entry, not a repo module):

```bash
bun -e '
import { loadCorpus, loadManifest } from "./src/campaign/replay.ts";
const loaded = loadCorpus("corpus/gate-20260808", loadManifest("src/campaign/replay-manifest.gate-20260808.json"));
const deltas: number[] = [];
let dropped = 0, total = 0;
for (const b of loaded.blocks) {
  if (b.samples.length !== 2) continue;
  total++;
  const [a, t] = b.samples.map((s) => loaded.records.get(s.run_id)!.pre_exposure_ms);
  if (a === null || t === null) { dropped++; continue; }
  deltas.push(Math.abs(a - t));
}
deltas.sort((x, y) => x - y);
const q = (p: number) => deltas.length ? deltas[Math.floor(p * (deltas.length - 1))] : null;
console.log(JSON.stringify({
  measured_pairs: deltas.length, dropped_pairs: dropped, total_two_arm_blocks: total,
  p50_ms: q(0.5), p90_ms: q(0.9), max_ms: deltas.at(-1) ?? null,
}, null, 2));
'
```

The output goes into the entry verbatim with the advisory scoping language from the spec (bias direction unknown; NOT an upper bound; does not set `max_exposure_skew`; qualification owns the live floor).

- [ ] **Step 4: Write the experiment entry**

`docs/experiments/2026-08-2X-phase0-capacity-simulation.md`, following the experiment-log conventions (hypothesis, config, run pointers, verdicts, negative results at equal billing). Required content (from the spec's exit criteria):

1. Corpus composition FIRST: run count, summed wall, mean/median, per-pool subtotals, exclusions, corpus digest — before any reuse of the ~70 serial-hour baseline.
2. Acquisition record: exact commands, selection-manifest summary, missing/excluded run IDs and reasons.
3. Coverage: null counts (coding/gauntlet/pre-exposure), gauntlet<coding anomalies.
4. The 72-config grid table + sensitivity tables; 8h verdicts only per the rule.
5. Per-pool wait attribution + busy-slot lower bounds at the winning configs; the credentials.yaml cap recommendation INTERSECTED with per-provider quota evidence (Bedrock probed concurrency); the grader-pool finding + PRI-2524 promotion call.
6. Skew evidence: `|Δ pre_exposure_ms|` distribution with coverage; advisory language; qualification owns the floor.
7. 429-corpus-verification result.
8. Calibration report (step 2) and the historical self-replay acceptance result.
9. Verdict: which configurations clear 8h; if none — re-plan per the spec's exit criterion 7, no supervisor/fleet reopen unless control-plane-attributed.

```bash
git add docs/experiments/2026-08-2X-phase0-capacity-simulation.md
git commit -m "docs: Phase 0 capacity simulation experiment entry"
```

- [ ] **Step 5: Update Linear**

Post the outcome on PRI-2935 (verdict, entry link, cap recommendations, PRI-2524 call) and move it to In Review; comment on PRI-2874 recording parent errata E1/E2 (estimate keying, fallback content) for ratification at kernel deliverable 3.

---

## Self-Review Notes (author)

- **Spec coverage:** acquisition (T3/T8), manifest+loader (T4/T8), engine incl. demand/occupancy/ordering/backfill/wait attribution (T5), sensitivities + historical mode (T5 modes + T9), validation (T7 committed fixture + T9 gate self-replay + calibration), estimates (T2 + T6 scan/inclusion + T9 artifact), skew evidence (T4 `pre_exposure_ms` + T9 entry), CLI (T6), sweep incl. reserve stress + allowance (T6 + T9), experiment entry + Linear (T9), `.gitignore` (T1), AGENTS.md (T6), runbook (T8). Parent errata E1/E2: T9 step 5.
- **Type consistency:** `SimBlock` in T5 == shape produced by `toSimBlocks` == consumed by T7 fixture (imports from `src/campaign/simulate.ts`). `SimBlockInput` (T4) → `toSimBlocks` adapter (T5). `EstimateInput`/`lookupEstimate` consistent between T2 and T6.
- **Known soft spots (flag for implementer):** the reserve-stress duplication lives in the sweep renderer of T6 — keep it a pure function of the loaded blocks; T8's enumeration command may need adjustment to the appliance helper's actual exec syntax (verify against `docs/appliance-runbook.md` before running); T9 calibration is tooling over committed artifacts, not a repo test, by design.
