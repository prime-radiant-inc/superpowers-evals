# Phase 0 spec: three-seat multiharness adversarial review

**Date:** 2026-08-20
**Subject:** `docs/superpowers/specs/2026-08-20-phase0-capacity-simulation-design.md` (v1 → v2)
**Method:** three parallel read-only review seats, one per model family,
each with a distinct lens and the same artifacts (child spec v1, parent
spec, the repo at `339779f`):

- **Seat 1 — codex/gpt-5.6-sol** (fast mode, max thinking): data fidelity.
- **Seat 2 — claude-fable-5** via GitHub Copilot routing (xhigh): parent-spec
  compliance. (Direct `claude` provider was out of usage credits at dispatch;
  same model family rerouted through the copilot harness.)
- **Seat 3 — pi/zai/glm-5.3** (high): engineering soundness/testability.

All three verdicts: **not ready as written**; all three: one revision pass,
not architectural rework. Orchestrator (kimi-code/k3) synthesized and
revised; dispositions below. Cross-seat convergence was high — the pool
identity, slot-demand, and clairvoyant-ordering defects were found
independently by all or most seats.

## Consensus P1s and dispositions

**1. Pool identity self-contradiction (all three seats).** v1's Background
pinned pools to the legacy 2-part `limiterKey` (merged sol/luna pool) while
its non-goals quoted the parent's 3-part `|api|model` derivation (split
pools). Under the parent rule the 08-08 headline bottleneck dissolves;
Sol quantified the stakes (merged 236-sample cap-5 pool ≈ 8.46h floor vs
two 118-sample model pools ≈ 4.23h floors in parallel).
**Disposition: accepted.** v2 freezes target-policy `pool_id`s in the
replay manifest by the parent's v1 formula (`quota_pool` key else
`(base_url ?? credential-name)|api|model`); legacy merged identity carried
as labeled counterfactual + validation anchor only. The 8h verdict is
issued only on target-identity runs.

**2. Slot-demand algebra unspecified (all three seats).** v1 said pools
"each grant a slot" — ambiguous exactly on the measured dimensions:
credential-stratified blocks draw 2 slots from ONE subject pool, and every
sample has its own Gauntlet-Agent (2 grader slots per two-arm block).
**Disposition: accepted.** v2 defines the exact demand vector (per sample:
1 subject + 1 grader + 1 global, aggregated by pool key, atomic at one
instant), per-sample release at the sample's own service end, grader
occupancy = `gauntlet_ms` (fallback `wall_ms`, tagged), cap-1 same-pool
blocks as loud infeasibility, and a named aliased-pool engine test.

**3. Clairvoyant ordering + invalid validation (Fable, Sol).** v1 ordered
dispatch by measured walls (oracle knowledge the dispatcher won't have) AND
required the engine to reproduce a historical batch within ±15%. Sol
showed the contradiction numerically: oracle LPT reproduces the validation
batch 26.6% faster than observed — the check would reject a correct
implementation.
**Disposition: accepted.** v2: primary ordering from the estimate
artifact's medians (what registration will freeze); perfect-knowledge LPT
demoted to a labeled "policy ceiling" sensitivity. Validation redesigned:
exact synthetic multi-pool oracles for engine correctness; a separate
`historical` engine mode (FIFO, merged pools, uncapped grader) for the
self-replay anchors; ±15% reserved for held-out duration-prediction
calibration only; committed distilled fixture so tests are portable.

**4. Replay manifest did not represent the real gate (GLM, Sol).** v1 said
12 scenarios + a single-arm sentinel rider + optional copilot. Reality: 16
scenarios (11 named + 5 rider), the rider two-arm n=2/arm on
`opus_bedrock`; planned n ≠ observed (authorized retries, a mid-battery
reboot); copilot is a separate planned workload.
**Disposition: accepted.** v2 freezes a canonical run-ID-exact manifest
(194 two-arm blocks / 388 scored samples; retries replayed as labeled
capacity load; `excluded_run_ids` with reasons; every sample carries
run_id, arm, replicate, block, historical batch/job, pool_id, class,
inclusion role). Copilot extension gets its own manifest and result table.

**5. Corpus acquisition path does not exist in the needed direction (GLM,
Sol).** The runbook's export/import is workstation→appliance; the exporter
expects a two-level layout, has no run selector, and carries no batch
metadata. v1's first exit criterion had no executable route.
**Disposition: accepted.** v2 specifies a purpose-built acquisition profile
(`quorum campaign acquire`) reusing export-runs' scrub primitives: runs on
the appliance, exact run-ID allowlist, flat-layout discovery, minimal
payload (verdict + trajectory + token-usage + gauntlet result), gate batch
metadata, checksums, and a selection manifest making the corpus
reproducible and digestible. Orchestrator verification during synthesis:
`trajectory.json` IS in the exporter's payload allowlist
(`src/export-runs/index.ts:21-26`) — GLM's sub-claim that it was excluded
was wrong; the skew scalar needs no export change.

**6. Skew proxy not an upper bound (all three seats).** `|Δ(wall − coding)|`
mixes pre- and post-session overhead, can cancel, and is
configuration-invariant under co-launch.
**Disposition: accepted.** v2 replaces it with per-block
`|Δ pre_exposure_ms|` from trajectory first-step timestamps (measured
pairs only, nulls dropped and counted); retains the old quantity only as a
descriptively-named `noncoding_span_imbalance_ms` with unknown bias;
neither sets `max_exposure_skew` — bound stays drift-derived, Phase 0 is
advisory, qualification owns the live floor.

**7. Estimate artifact underfits registration (Fable, Sol).** Keyed
scenario×agent (collapses a measured 3–5× credential/model effect);
duration-only fallbacks leave gating budget pricing without costs;
`generated_at` wall-clock vs "byte-identical regeneration" contradiction;
no coverage metadata.
**Disposition: accepted, with parent errata surfaced.** v2 keys
scenario×agent×credential×os with a pinned dimension-drop fallback chain;
every tier carries duration AND subject/grader/total cost medians plus
`duration_n`/`priced_n`/spread; confidence is per-metric with coverage
floors; null cost → "unpriced" path, never a surrogate; `generated_at`
derived from data (max `finished_at`); median/sort/merge/serialization
rules pinned. Because the parent literally says "keyed scenario × agent",
this is recorded as parent errata E1/E2 in the spec and raised on
PRI-2874 rather than silently absorbed.

**8. 8h verdict measured the wrong interval (Sol).** v1 measured to last
block terminal; the criterion ends at a sealed report; cooldowns,
replacements, and reserve draw were unmodeled.
**Disposition: accepted in scope.** v2 reports nominal, reserve-stress,
and allowance-inclusive makespans; only the allowance-inclusive number is
eligible for the "inside 8h" verdict; seal/report overhead bounded
explicitly in the entry. Cooldown/429 modeling stays a stated v1
limitation (no 429 evidence in corpus; probe was synthetic — language
corrected per Sol's P3).

**9. Backfill/ordering rule unspecified (GLM, Sol).**
**Disposition: accepted.** v2 pins greedy scan in longest-expected-first
order with backfill, deterministic (comparison, cell, replicate) tie-break,
admission at event instants, and the no-starvation argument.

**10. Exit criterion fired the wrong parent gate (Fable).** All-miss →
auto-reopen supervisor/fleet contradicts the parent's control-plane-only
trigger.
**Disposition: accepted.** v2 exit 7: all-miss re-plans against the data
(caps, quota, suite restructure, pool splitting); supervisor/fleet
reopened only on control-plane attribution.

## P2 dispositions (all accepted unless noted)

- Occupancy asymmetry biasing grader critical-path attribution → fixed by
  per-sample release + `gauntlet_ms` grader occupancy + labeled
  grader-active sensitivity.
- Validation batch near-degenerate (jobs=2, one credential) → demoted from
  acceptance pillar; gate self-replay + a jobs≥8 multi-credential batch
  added; committed fixture for portability.
- "Critical-path pool" metric → renamed wait attribution; busy-slot-ms/cap
  lower bounds and saturation intervals added; no DAG claim.
- `credential → pool_id` resolution drift risk → resolved at curation time,
  frozen into the manifest.
- Arm-derivation edge cases (null/unknown/dirty rev, full-SHA exact match)
  → loud loader errors; loader cell-keying rule stated.
- 70-serial-hour baseline not repo-verifiable → entry must publish corpus
  composition (count, summed wall, mean, median, pool subtotals,
  exclusions, digest) before reusing the figure.
- Swept caps exceed probed Bedrock concurrency → cap recommendation must
  intersect swept winners with per-provider quota evidence.
- Estimates corpus mixing appliance-Linux and local-macOS durations →
  entries carry os (keyed dimension) and source is pinned by the inclusion
  manifest.
- Local `results/` variance across machines → frozen inclusion manifest
  with run IDs + hashes.

## P3 dispositions

Accepted: global-cap-counts-runs flagged as proposed kernel contract term;
grader-cap third sweep axis called legitimate (containment stated);
makespan endpoint overheads bounded; spacing=0 stated as modeled fact;
"no zod schema" narrowed to run-level economics; `--sweep <name>` syntax;
`estimates/v1.json` in a tracked directory; `grader_overhead_ms` given a
consumer (grader-active sensitivity); "12 scenarios" corrected to 16;
refresh-rule enforcer assigned to registration; synchronous event core
over `Clock` ceremony (engine is a pure function of records + config);
cost fallback goes straight to unpriced; skipped-flagged batch records
excluded-with-logging in historical replays.

## Verification note

One GLM sub-claim was factually refuted during synthesis (`trajectory.json`
absent from the export payload) — see finding 5. Everything else
spot-checked against the repo held.

## Outcome

v2 written (`2026-08-20-phase0-capacity-simulation-design.md`, this repo).
Next: Drew reviews v2 → implementation plan (writing-plans) →
implementation under PRI-2935.
