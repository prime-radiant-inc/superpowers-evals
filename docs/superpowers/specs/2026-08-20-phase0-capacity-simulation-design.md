# Phase 0: capacity simulation + estimate artifact

**Status:** DRAFT v2 — revised after three-seat multiharness adversarial review
(record: `docs/experiments/2026-08-20-phase0-spec-multiharness-review.md`)
**Date:** 2026-08-20
**Linear:** PRI-2935 (child of PRI-2874)
**Parent spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`
("Phase 0: the free capacity simulation" and "Order of operations" §2).
This document is the child spec for Phase 0 only. Where it and the parent
disagree, the parent wins and the conflict is recorded as a disposition —
two such parent errata are surfaced in this revision (see "Parent-spec
errata surfaced").

## Goal

Prove on recorded data — zero live spend; the ~$850 live probe remains
rejected (Drew, 2026-08-17) — which dispatch configurations can complete the
release-gate workload inside the 8-hour criterion (registration-accept →
**sealed report**), and produce the estimate artifact that campaign
registration will consume.

Three deliverables:

1. **The simulation + experiment entry.** Replay the 2026-08-08/09 gate's
   recorded durations through the campaign dispatch policy (below), across
   the sweep grid. Publish predicted makespans, wait attribution per pool,
   and the 8h verdict (issued only on the allowance-inclusive, estimate-
   ordered, target-policy runs) as a checked-in experiment entry, negative
   results at equal billing.
2. **The estimate artifact** (`quorum.estimates/v1`, checked in). Per
   scenario×agent×credential×os duration and cost medians with coverage
   metadata and confidence, a pinned fallback chain, and a refresh rule.
   Registration (kernel deliverable 3) consumes it; estimates are advisory
   and stay OUT of the campaign digest.
3. **The skew evidence.** Per-run pre-exposure wall derived from trajectory
   timestamps, reported as a per-block differential distribution with
   coverage — advisory to the registered `max_exposure_skew` bound; the
   live floor is owned by the qualification campaign.

## Parent-spec errata surfaced (recorded, not absorbed)

The parent wins on conflict; these two conflicts are surfaced here and on
PRI-2874 rather than silently exceeded:

- **E1 — estimate keying.** The parent says estimates attach "keyed
  scenario × agent" (Registration section). Measured evidence: same agent,
  same scenario, different credential/model — claude/fractals 17–24m on
  `opus_bedrock` (opus-4.8) vs 53–116m on `opus5_bedrock` (opus-5) — a 3–5×
  effect that a blended scenario×agent median cannot represent. This spec
  keys estimates by **scenario×agent×credential×os** (model rides in the
  credential per the parent's documented coupling punt) and treats the
  parent's scenario×agent chain as the second fallback tier. The parent
  text should be amended at kernel deliverable 3.
- **E2 — estimate fallback content.** The parent's fallback chain attaches
  durations; registration also prices the all-in `budget_usd` (subject +
  grader) from them. Every fallback tier here carries duration AND cost
  medians (subject, grader, total) plus coverage; a tier with no priced
  observations yields `null` cost → the "unpriced" registration path, never
  a silent surrogate.

## Background: the data landscape (recon 2026-08-20, review-verified)

Per run dir under `results/<run-dir>/`:

- `verdict.json` `.started_at` / `.finished_at` — total run wall clock.
  Optional in the schema; **absence or invalidity is a corpus-validation
  failure**, never a silent skip (review: "always present" was stronger
  than the contracts).
- `verdict.json` `.economics` — no run-level economics schema in
  `FinalVerdictSchema` (`z.record`, `src/contracts/verdict.ts:60`); readers
  use the tolerant-view pattern from `src/cli/costs.ts`. Sub-artifacts
  (`coding-agent-token-usage.json`) DO have schemas
  (`src/contracts/economics.ts`).
  - `.economics.coding_agent.duration_ms` — session-log timestamp span;
    nullable (hermes/antigravity, `src/capture/index.ts:716`).
  - `.economics.gauntlet.duration_ms` — the full Gauntlet-Agent drive wall;
    encloses the coding session. Across 683 local runs with both fields,
    gauntlet ≥ coding always, median delta 76.5s. A `gauntlet < coding`
    anomaly is preserved as a data-quality error, not hidden by `max(0,…)`.
  - `.economics.total_est_cost_usd`, `.coding_agent.est_cost_usd`,
    `.gauntlet.est_cost_usd` — subject/grader/all-in pricing, each
    nullable.
- `verdict.json` `.credential`, `.scenario`, `.coding_agent`, `.os`,
  `.provenance.superpowers_rev` — identity and arm discriminator; rev is a
  full 40-char SHA on gate-era runs, nullable in schema (null/unknown/dirty
  → loud loader error naming the run_id).
- `trajectory.json` (ATIF) — per-step `.timestamp`; the first coding-step
  timestamp minus `started_at` is the per-run **pre-exposure wall**. It IS
  in the `quorum export-runs` payload allowlist
  (`src/export-runs/index.ts:21-26`).

The gate corpus is appliance-side (zero local 08-08/09 run dirs; batch IDs
never committed). Gate structure per the experiment docs, **corrected by
review**: 388 scored runs / 66 jobs; arms main `44c9b2d6` vs dev
`2d4b675b`; four credential-stratified two-arm comparisons
(`opus_bedrock`, `opus5_bedrock`, `openai_responses_56sol`,
`openai_responses_56luna`); **16 scenarios** (11 named + 5 sentinel-rider
scenarios, the rider TWO-arm, n=2 per arm, T-class, on `opus_bedrock`);
per-cell n ∈ {2,4,5,6,8,10}. Planned n ≠ observed runs in places (retries
authorized at +20% of cell n; a mid-battery reboot orphaned driver state).
The copilot extension (196 runs / 30 jobs, `copilot_opus5`,
`copilot_gpt56_sol`) is a SEPARATE planned workload with its own manifest
and result table — never an optional blend into the 388.

## Design

### Corpus acquisition (new acquisition profile — the named gap)

The runbook's export/import runs workstation→appliance only;
`discoverRunDirs` (`src/export-runs/index.ts:80-101`) expects a two-level
`results/<label>/<run-id>/` layout, has no run selector, and exports no
batch metadata. Phase 0 therefore builds a small **acquisition profile**
reusing export-runs' scrub primitives (denylist, 0o600 writes, bundle
manifest with checksums, `src/export-runs/manifest.ts`):

- Runs ON the appliance (`evals-appliance exec` or trusted ssh), against
  the gate's results root(s), selecting by an **exact run-ID allowlist**
  (curated from the appliance enumeration + the readout).
- Handles the flat `results/<run-dir>/` layout the runner actually
  allocates (`src/runner/index.ts:128-141`).
- Payload per run: `verdict.json`, `trajectory.json`,
  `coding-agent-token-usage.json`, `gauntlet-agent/results/*/result.json`.
  No homes, no transcripts, no workdirs. Runs without `verdict.json` are
  not discoverable by definition; such launched-but-unverdicted runs are
  recorded in the manifest's `excluded_run_ids` (reason `no-verdict`) and
  their capacity contribution is acknowledged as a limitation.
- Includes the gate's batch metadata (`results/batches/*/batch.json` +
  `results.jsonl`) for historical job reconstruction.
- Emits a **selection manifest** (run IDs, per-file SHA-256, source host,
  pull date, command) — the corpus is exactly reproducible and
  digestible; the experiment entry publishes the corpus digest.
- Lands locally at gitignored `corpus/gate-20260808/` (add `corpus/` to
  `.gitignore`). Deliberately NOT `results/` (dashboard grid and
  `quorum show` must not see it).
- `credential → pool_id` resolution happens at curation time from the
  gate-era credential definitions and is frozen INTO the replay manifest —
  no dependence on today's `credentials.yaml` (entries drift).

### Replay manifest (canonical, frozen, run-ID-exact)

`src/campaign/replay-manifest.gate-20260808.json`, checked in, curated from
the two experiment docs + the appliance enumeration, with per-cell
citations. It is the single structural source (batch metadata is
corroboration, not authority):

- **Comparisons:** the four credential-stratified two-arm comparisons +
  the two-arm sentinel rider. Every sample carries: `run_id`, `arm`
  (`baseline` = `44c9b2d6…` / `treatment` = `2d4b675b…`, full SHAs, exact
  match), `replicate` ordinal, `block_id`, `cell` (scenario × comparison),
  historical batch/job, `pool_id`, `class`
  (`confirmatory|probe|tripwire|descriptive`), and **inclusion role**
  (`scored` | `retry-load`). 194 two-arm blocks / 388 scored samples for
  the primary workload; retry runs are replayed as capacity load in their
  cells (they held real pool slots) and labeled `retry-load`.
- **`excluded_run_ids`:** bootstrap probes, `no-verdict`, reboot orphans —
  each with a reason. Loader contract: every corpus record matches exactly
  one manifest entry (listed or excluded); anything else is the loud
  error. Missing listed runs are loud errors.
- **Pool identity (the review's central correction).** Each credential's
  TARGET-policy `pool_id` is frozen in the manifest using the parent's v1
  derivation — `quota_pool` key if set, else
  `(base_url ?? credential-name)|api|model`. Under this rule sol and luna
  are SEPARATE pools (the probe's per-model buckets). The legacy merged
  `limiterKey` (`(base_url ?? name)|api`) is carried as a labeled
  counterfactual identity for the validation anchor and a counterfactual
  result column only.
- The copilot extension gets its own manifest
  (`replay-manifest.gate-20260808-copilot.json`) and its own result table.

### Replay records

`src/campaign/replay.ts` reduces each imported run to:

```ts
{
  run_id: string;
  scenario: string; agent: string; credential: string; os: string;
  pool_id: string;                 // from the manifest, never recomputed
  arm: "baseline" | "treatment" | "single";   // "single": validation batches only
  wall_ms: number;                 // finished_at − started_at; invalid → corpus error
  coding_ms: number | null;
  gauntlet_ms: number | null;      // economics.gauntlet.duration_ms
  pre_exposure_ms: number | null;  // first trajectory coding-step ts − started_at
  cost_subject_usd: number | null; // economics.coding_agent.est_cost_usd
  cost_grader_usd: number | null;  // economics.gauntlet.est_cost_usd
  cost_total_usd: number | null;   // economics.total_est_cost_usd
}
```

`confidence: "estimated"` fallback substitution was REMOVED from the
record: estimates are computed downstream from measured records only;
missing values stay null and are counted in coverage. (The one exception:
a run with null `coding_ms` still contributes `wall_ms` — wall is the
service time; `coding_ms` feeds only skew and occupancy sensitivities.)

### Simulation engine (`src/campaign/simulate.ts`)

A synchronous discrete-event core (time as data; the engine is a pure
function of records + config — the injectable `Clock` ceremony is dropped
per review; determinism is structural).

- **Demand vector (exact algebra).** A block's demand = for EACH sample:
  1 slot in the sample-arm's subject pool, 1 slot in the grader pool, 1
  global slot — aggregated by pool key (a two-arm block on one credential
  demands 2 slots from ONE subject pool), all granted atomically at one
  event instant, or the block waits. Cap-1 pools with two-arm same-pool
  demand are structurally infeasible → loud configuration error (the
  parent's registration rejection, mirrored).
- **Occupancy (per-sample release).** Each sample holds its subject,
  grader, and global slots until THAT sample's own service end (its
  `wall_ms`), then releases all three. Grader-pool occupancy per sample =
  its `gauntlet_ms` when present (fallback `wall_ms`, tagged
  `grader_wall_fallback` and counted in coverage). This is the primary
  model; a labeled sensitivity holds the grader slot for
  `gauntlet_ms − coding_ms` only ("grader-active" reading of the parent's
  75s overhead figure).
- **Ordering (estimate-driven, not clairvoyant).** Waiting blocks are
  ordered longest-expected-first where expected = the estimate artifact's
  duration median for the block's (scenario, agent, credential, os)
  through the pinned fallback chain — the same information registration
  will freeze. Service times remain the measured `wall_ms`. A labeled
  sensitivity publishes perfect-knowledge LPT as the "policy ceiling"
  (optimistic bound). Ties break deterministically by (comparison,
  cell, replicate ordinal) from the manifest.
- **Admission rule (greedy scan + backfill).** At each event instant,
  scan the waiting queue in order and admit every block whose full demand
  vector fits; blocks that don't fit are skipped over at this instant
  (backfill allowed). No starvation: every admission instant is bounded
  by the longest in-flight occupancy, and the queue is finite.
- **Sweep.** Subject-pool caps {5, 15, 20} × global jobs {8, 12, 20, 24}
  × grader-pool caps {5, 15, 20} = 36 configurations, run under BOTH pool
  identities (target derivation = primary; legacy merged = counterfactual
  validation anchor) = 72 simulation runs, each seconds of compute. The
  8h verdict is issued ONLY on target-identity, estimate-ordered,
  allowance-inclusive runs. The grid strictly contains the parent's
  {5,15,20}×{8,12,20,24} readings (grader-tied-to-subject is the
  diagonal); the experiment entry states the containment.
- **Results reported per configuration:** nominal makespan (last sample
  terminal); makespan + registered-reserve stress (reserve blocks per the
  suite's `reserve:` priced in, drawn at the observed instrument-failure
  rate); **+ a declared seal/report allowance** (registration, per-SHA
  worktree materialization, sealing — bounded explicitly in the experiment
  entry). Only the allowance-inclusive number is eligible for the "inside
  8h" verdict; others are labeled conditional predictions.
- **Wait attribution (not "critical path").** Per pool: busy-slot-ms,
  `busy-slot-ms / cap` auditable lower bound, saturation intervals, and
  block-wait attribution (a waiting block's wait charged to the pool whose
  residual demand was binding at admission; multi-pool ties split
  evenly). The report names this "wait attribution"; no event-DAG
  critical path is claimed.
- **429s.** Not injected. Required language: the gate readout reported no
  throttle incident; the 08-12 probe was synthetic, not real agent
  traffic; corpus verification for 429 evidence runs at load time and is
  reported.
- **Spacing.** Modeled as 0 for these pools (no gate credential defines
  `launch_spacing_seconds`) — a stated modeled fact, not an omission.
- **Global cap counts runs** (one slot per sample), matching historical
  `--jobs` semantics (`src/scheduler/index.ts`); flagged as a proposed
  contract term for kernel deliverable 3, not silently settled.

### Validation (redesigned after review)

1. **Synthetic oracles (exact).** Hand-computable multi-pool cases —
   aliased same-pool block demand, cap-1 infeasibility, backfill vs
   head-of-line, per-sample release, grader-cap binding — assert exact
   simulated makespans and admission sequences. This is where engine
   correctness is proven.
2. **Historical-policy self-replay.** A `historical` engine mode (FIFO
   admission, legacy merged pool identity, grader uncapped — i.e.
   `run-all` semantics) replays (a) the imported gate corpus under its
   historical configuration, accepted against the recorded gate elapsed;
   (b) local batch `batch-20260804T031849Z-2aef` (jobs=2, observed
   6,370,019ms from `batch.json`), plus any local batch with jobs ≥ 8 and
   ≥ 2 credentials if one exists. Historical mode exists so the policy
   under test is not confounded with the engine under test (oracle LPT
   reproduces that batch 26.6% faster than observed — a campaign-policy
   replay would fail ±15% while being correct).
3. **Held-out calibration.** The estimate-ordered policy's duration
   predictions are checked ±15% ONLY as held-out calibration (train
   estimates on one half of cells, predict the other), not as an engine
   acceptance.
4. **Portability.** The acceptance tests run against a committed distilled
   fixture (real durations/costs copied into `test/fixtures/`; precedent:
   `packages/dashboard/test/fixtures/`). The live-batch and live-gate
   replays are recorded maintainer steps in the experiment entry
   (`results/` and `corpus/` are gitignored).

### Estimate artifact (`quorum.estimates/v1`)

`src/campaign/estimates.ts` builds the artifact from the imported gate
corpus PLUS a frozen inclusion manifest of local `results/` runs (local
trees vary by machine; the inclusion manifest pins run IDs + hashes):

```ts
{
  schema_version: "quorum.estimates/v1",
  generated_at: string;  // derived: max finished_at across included inputs
  corpus: { sources: string[]; run_count: number; digest: string };
  entries: [{
    scenario: string; agent: string; credential: string; os: string;
    duration_s_median: number; duration_n: number;
    cost_subject_usd_median: number | null;
    cost_grader_usd_median: number | null;
    cost_total_usd_median: number | null;
    priced_n: number;                 // observations with non-null total cost
    spread_s: { p25: number; p75: number };
    confidence: "high" | "medium" | "low";  // per-metric rules below
  }];
  fallbacks: {
    scenario_agent: [...];   // same fields, aggregated dropping credential/os
    scenario: [...];         // dropping agent
    corpus_median: { duration_s: number; cost_total_usd: number | null };
  };
}
```

- **Confidence is per-metric with coverage floors:** high requires
  duration_n ≥ 8 AND priced_n ≥ 8 for a priced entry (a duration-only
  entry can be duration-high/cost-low — recorded as two fields if review
  of the schema demands it; simplest: confidence applies to duration,
  `priced_n` speaks for cost); medium 3–7; low 1–2; 0 → fall through.
- **Fallback order:** scenario×agent×credential×os → scenario×agent →
  scenario → corpus median. A tier with no priced observations yields
  null cost → "unpriced" (registration surcharge path), never a silent
  scenario-level cost surrogate.
- **Determinism contract (pinned):** entries sorted by (scenario, agent,
  credential, os); even-n median = average of the two middle values;
  merge rule = union by run_id, gate corpus wins on conflict, counts
  recorded; serialization = 2-space JSON, LF, shortest-round-trip
  doubles. Regeneration from the same inputs is byte-identical (tested);
  `generated_at` is data-derived, so it does not break identity.
- zod schema in `src/contracts/estimates.ts`; round-trip tested.
- **Refresh rule:** rebuild after every sealed gating campaign or when
  the newest included run is > 30 days older than the build. Staleness is
  checked at registration (kernel deliverable 3); Phase 0 documents the
  rule only.
- Checked in at `estimates/v1.json` (a tracked directory, not repo root;
  biome-formatted).

### Skew evidence (honest scoping)

- Primary metric: per-block `|Δ pre_exposure_ms|` between arms
  (trajectory-derived), measured pairs only — a null on either arm drops
  the pair and is counted in coverage. Reported as p50/p90/max over the
  corpus, plus per-configuration simulated exposure-start deltas (which
  under atomic co-launch reflect only pool-contention ordering).
- `|Δ(wall − coding)|` is retained ONLY as a descriptive
  `noncoding_span_imbalance_ms` column with unknown bias direction;
  neither metric may be presented as an upper bound, and neither sets
  `max_exposure_skew` — the registered bound remains drift-timescale-
  derived per the parent, with Phase 0 advisory and the qualification
  campaign owning the live floor.

### CLI surface

Thin verbs behind the quorum CLI (`src/cli/`), no collision with the
planned kernel verbs (`register/run/report/list/status/cancel`):

- `quorum campaign simulate --corpus <dir> [--sweep <name=default> |
  --config <json>]` — runs the sweep or one explicit configuration;
  writes the results table as JSON + markdown fragment.
- `quorum campaign estimates --corpus <dir> --inclusion <manifest>
  --out estimates/v1.json` — builds the artifact.
- `quorum campaign acquire --runs <allowlist> --out <dir>` — the
  appliance-side acquisition profile (trusted path, documented in the
  runbook).

## Testing

Repo culture — real fixtures, no mocked-behavior tests:

- Synthetic-oracle engine tests (exact expected makespans/admissions):
  aliased same-pool demand, cap-1 infeasibility, backfill, per-sample
  release, grader-cap binding, deterministic tie-break.
- Loader: fixture run dirs incl. null `coding_ms`, missing verdict,
  surplus/excluded run IDs (loud errors), null/unknown/dirty rev (loud
  errors), `gauntlet < coding` anomaly preserved.
- Historical self-replay against the committed distilled fixture (batch
  replay in historical mode, tolerance-derived acceptance).
- Estimates: schema round-trips; byte-identical regeneration; median/sort/
  merge rules on sparse fixtures; fallback chain and unpriced-cost path.
- Acquisition: dry-run against a local fixture results root (flat layout,
  allowlist selection, checksum manifest).
- `bun run check` and `bun run quorum check` stay green.

## Non-goals

- No live spend; no appliance behavior changes beyond running the
  read-only acquisition profile; no new eval runs.
- No 429 injection or cooldown modeling (limitation, stated).
- No kernel dispatcher code — the engine spawns nothing; growing it into
  the real dispatcher is kernel deliverable 3's decision.
- No changes to `src/scheduler/`, `src/run-all/`, the dashboard, or
  `credentials.yaml` (cap recommendations are experiment-entry output,
  not edits).
- No grader de-SPOF implementation — Phase 0 produces the wait-
  attribution evidence for the PRI-2524 promotion call only.
- No `quota_pool` schema PR (PRI-2876 scope); the manifest freezes
  pool_ids by the v1 formula without touching `CredentialSchema`.

## Decisions recorded

- Corpus: pulled from the appliance via a purpose-built acquisition
  profile (Drew, 2026-08-20); the generic export/import path runs the
  wrong direction (review-verified).
- Placement: `src/campaign/` (Drew, 2026-08-20).
- Engine: new campaign-policy simulator; `runSchedule` not generalized
  (parent-settled); synchronous event core, no `Clock` ceremony (review).
- Pool identity: target-policy v1 derivation frozen into the manifest;
  legacy merged `limiterKey` as labeled counterfactual only (review
  consensus, all three seats).
- Ordering: estimate-driven primary; perfect-knowledge LPT as labeled
  optimistic bound (review; oracle-vs-historical delta measured at 26.6%
  on the validation batch).
- Occupancy: per-sample holds and releases; grader slot = `gauntlet_ms`
  (fallback `wall_ms`, tagged); grader-active sensitivity labeled.
- Global cap counts runs (per sample) — proposed contract term for
  kernel deliverable 3.
- Skew: trajectory-derived pre-exposure differential, advisory only;
  qualification owns the live floor (review).
- Parent errata E1/E2 (estimate keying and fallback content) surfaced,
  to be ratified at kernel deliverable 3 / on PRI-2874.

## Exit criteria (PRI-2935 done when)

1. `corpus/gate-20260808/` populated via the acquisition profile with the
   selection manifest (run IDs, checksums, command) recorded; `corpus/`
   gitignored.
2. The canonical replay manifest (194 blocks / 388 scored samples + retry
   load + exclusions) is checked in and loads with zero loud errors.
3. `quorum campaign simulate` publishes all 72 runs (36 configs × 2 pool
   identities): nominal, reserve-stress, and allowance-inclusive
   makespans; per-pool wait attribution and busy-slot lower bounds; skew
   distributions with coverage. The 8h verdict appears only on
   target-identity, estimate-ordered, allowance-inclusive runs.
4. Validation: synthetic oracles exact; historical self-replay of the
   gate corpus against recorded elapsed within a justified tolerance
   (tolerance derived from replicate variance or justified in the entry);
   held-out duration calibration reported.
5. `estimates/v1.json` checked in; schema round-trip, determinism, and
   fallback tests green.
6. Experiment entry `docs/experiments/2026-08-2X-phase0-capacity-
   simulation.md` publishes: corpus digest + composition (count, summed
   wall, mean, median, pool subtotals, exclusions) BEFORE any reuse of
   the ~70 serial-hour baseline; the grid tables; which configurations
   clear 8h; the credentials.yaml cap recommendation INTERSECTED with
   per-provider quota evidence (swept caps {15,20} exceed probed Bedrock
   concurrency — recommendation must not outrun evidence); the grader-
   pool wait-attribution finding and the PRI-2524 promotion call; the
   skew evidence with its advisory scoping; 429-corpus-verification
   result; every negative result at equal billing.
7. PRI-2935 and PRI-2874 updated. An all-miss outcome re-plans against
   the data (caps beyond the swept range, quota negotiation, suite
   restructure, pool splitting) and does NOT reopen the supervisor/fleet
   non-goal unless the miss is attributed to control-plane limits
   (parent non-goals + Appendix A disposition).
