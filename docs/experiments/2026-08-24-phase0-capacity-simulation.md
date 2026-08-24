# Phase 0: capacity simulation — the 8h gate is reachable, and the grader pool is the gate

**Date:** 2026-08-24 (corpus pulled from quorum-appliance via tailnet)
**Linear:** PRI-2935 (child of PRI-2874)
**Spec:** `docs/superpowers/specs/2026-08-20-phase0-capacity-simulation-design.md`
**Plan:** `docs/superpowers/plans/2026-08-20-phase0-capacity-simulation.md`
**Code:** branch `worktree-phase0-capacity-simulation` (T1–T7 review-clean)

**Hypothesis (from the parent spec):** replaying the 2026-08-08/09 gate's
recorded durations through the campaign dispatch policy shows which pool-cap
configurations complete the release-gate workload inside 8 elapsed hours —
free, before building the kernel.

**Verdict: CONFIRMED, with a named condition.** 18 of 36 target-policy
configurations clear 8h (allowance-inclusive, estimate-ordered) — but only
when the **grader pool reaches cap 15**. At the grader's effective current
cap (a single key, cap 5 modeled), NO configuration clears 8h: all four
global-caps columns pin at a 16.05h wall with 7.6 **hours** of attributed
grader-pool wait. Grader de-SPOF (PRI-2524) is therefore PROMOTED from named
dependency to gate-blocker: the 8h criterion is unreachable without it.

## Corpus composition (published before any reuse of the ~70h baseline)

Acquired via the new `quorum campaign acquire` profile (run-ID allowlist,
symlink/non-regular refusal, checksummed selection manifest), staged over the
tailnet by rsync of the allowlisted payload paths, acquired locally.

| quantity | value |
|---|---|
| runs acquired (gate workload) | 396 of 397 enumerated |
| scored samples in the canonical manifest | **388** (exact grid reconciliation) |
| two-arm blocks | 194 |
| summed wall | **69.37h** (the planning figure "~70 serial hours" verified) |
| mean / median run wall | 630.7s / 476.9s (planning used ~645s) |
| total priced cost | **$850.40** — matches the readout's all-in figure to the cent |
| per-credential wall | sol 19.37h, opus_bedrock 18.29h, opus5_bedrock 16.87h, luna 14.84h (n=120/128/28/120) |
| corpus digest | `196082df06468a13` |
| excluded run IDs | 9 (6 off-grid smokes, 2 bootstrap rider over-plan pair, 1 malformed-name duplicate alloc) |
| 429/rate-limit evidence in verdict reasons | **0** |

Copilot extension corpus (separate manifest + result table): 216 of 217
acquired; 184 scored + 18 retry-load singles; 15 excluded (6 pre-extension
smokes on rev `c367f804`, 8 dev-rev probes, 1 no-verdict). Fractals cells
observed short (3 main / 2 dev per credential vs planned 5). Copilot
trajectories carry NO per-step timestamps (coverage: 202/202 null
`pre_exposure_ms`) — skew evidence below is gate-only.

## Engine validation (before any prediction was trusted)

- **Distilled-fixture replay** (committed `test/fixtures/campaign/`): the
  engine reproduces local batch `batch-20260804T031849Z-2aef` at 6,369,606ms
  simulated vs 6,370,019ms observed — ratio 0.999935 (reviewer independently
  reproduced the figure).
- **Historical self-replay at scale**: per-batch historical-mode replay
  (FIFO, legacy per-credential caps, grader uncapped, global = batch jobs) of
  all 66 staged gate batches: total simulated **30.15h** vs recorded
  busy-elapsed **29.70h** — ratio **1.015**.
- **Held-out calibration** (run_id-parity split, the ±15% figure in its
  proper role): 34 of 47 keys with n≥4 (72.3%) within ±15% median-on-median.
  Misses are genuine per-key variance (worst: structural-blocks 4.8 at 1.58×,
  codex_sub keys with fat tails). Estimate medians are usable for ordering
  (see the policy ceiling below) but per-cell durations carry ±20–40% noise —
  registration's low-confidence surcharge rule is doing real work.

## The sweep (72 runs: 36 configs × 2 pool identities)

Configs: subject caps {5,15,20} × global {8,12,20,24} × grader {5,15,20};
target identity = per-model pool split (`(base_url ?? name)|api|model`,
frozen from gate-era credentials.yaml @ `64b99fc`); legacy = merged
`limiterKey`. Ordering: estimate-artifact medians. Grader occupancy:
`gauntlet_ms` (full drive). Allowance: +15min seal/report. Full tables:
`corpus/sweep-target/sweep-table.md` (gitignored corpus; regenerate with
`quorum campaign simulate --sweep default`).

Headline rows (allowance-inclusive):

| subject | global | grader | target | legacy |
|---|---|---|---|---|
| 5 | 8 | 5 | 16.05h | 16.05h |
| 5 | 12 | 15 | **6.71h PASS** | 8.37h |
| 5 | 20 | 15 | **5.37h PASS** | 8.07h |
| 5 | 20 | 20 | **4.64h PASS** | 8.07h |
| 20 | 24 | 20 | **3.79h PASS** | 3.79h |

Reading:

- **Grader cap 5 is a 16.05h wall for every configuration** — the grader
  pool's attributed wait (7.6h) swamps all subject-pool effects. This is the
  campaign-platform analogue of the unmodeled-grader warning in the parent
  spec, now measured: 388 grader drives at full-wall occupancy cannot fit a
  workday through one key.
- **The per-model OpenAI split is worth 1.7–3.4h at cap 5** (6.71h target vs
  8.37h legacy at global 12/grader 15) — the probe's conclusion
  (`docs/experiments/2026-08-12-openai-rate-limit-probe.md`) confirmed
  end-to-end. At cap 20 the identities converge (pools no longer bind).
- After the grader, the binding pools are opus5_bedrock (its 28 runs are the
  longest) then opus_bedrock; the OpenAI pools bind only at cap 5.

## Sensitivities (labeled; never 8h-verdict-eligible)

- **Policy ceiling (oracle ordering):** estimates-ordered 6.71h vs oracle
  6.47h at (5,12,15) — a 3.7% ceiling gap, converging to 0 at high caps.
  Estimate-driven ordering loses almost nothing to perfect knowledge: the
  calibration noise does NOT break longest-first dispatch.
- **Grader-active occupancy** (grader slot held only for
  `gauntlet − coding`): at (5,12,5) 16.05h → 6.85h — the occupancy MODEL is
  decisive exactly where the grader binds. The primary model (full-drive
  occupancy) is the honest one — the Gauntlet-Agent process is live for the
  whole drive — but this sensitivity bounds the upside of any future
  grading-only reservation scheme.
- **Reserve stress (+20% slowest blocks per cell):** best stress column
  6.83h at (5,20,20) — the recommended operating point absorbs the
  registered reserve draw inside 8h.

## Skew evidence (advisory; does NOT set max_exposure_skew)

Per-block `|Δ pre_exposure_ms|` (trajectory first-step ts − run start),
194/194 pairs measured, 0 dropped: **p50 7.2s, p90 49.7s, max 91.6s**.
Co-launch under atomic admission keeps pre-exposure skew under ~1.5 minutes
at p90 in this corpus — consistent with the parent's tens-of-minutes
registered bound being conservative. Bias direction of the proxy is unknown
(it measures pre-exposure only, not first-generation-request); the
qualification campaign owns the live floor.

## Recommendations (intersected with per-provider quota evidence)

1. **Grader de-SPOF (PRI-2524): PROMOTED to gate-blocker.** A grader pool of
   ≥15 concurrent drives is required; one Anthropic key cannot express that.
   Key pool or calibrated Bedrock grader — scheduled before the first gate.
2. **OpenAI pools: raise cap 5 → 15** (probe-proven headroom; usage-Tier-5
   per-model buckets carry it) — the single cheapest capacity win measured
   here. Sweep winners at 15/20 exceed only BEDROCK's probed concurrency
   (opus_bedrock ~6, opus5 ~4 observed), so Bedrock caps stay at probed
   levels until PRI-2876's TPM raises land.
3. **Operating point for the first gate (given today's evidence):** subject
   caps at current probe-backed values, global jobs 12–20, grader pool 15 →
   predicted 6.7h nominal / 8.0h reserve-stressed at (5,12,15); 5.4h/7.0h at
   (5,20,15). Both clear 8h with the seal allowance.
4. **Registration surcharge on low-confidence estimates is justified** by
   the calibration spread (72.3% within ±15%); no change proposed to the
   pinned thresholds.

## Negative results and limitations (equal billing)

- The copilot extension's fractals cells were observed short (3/2 vs planned
  5/5 per credential); its replay is structurally sound but the extension's
  own gate story is incomplete — recorded, not papered over.
- No 429 modeling (corpus shows zero throttle evidence; the 08-12 probe was
  synthetic, not real traffic). Cooldown behavior remains unvalidated by
  construction.
- The simulation cannot see contention-induced duration inflation: replayed
  walls are the 66-sequential-jobs regime's durations, and contention
  (CPU/mem on the shared host at global 20–24) may inflate real walls. The
  parent's contention guard exists for exactly this; qualification measures
  it.
- Copilot trajectories lack per-step timestamps (202/202) — skew evidence is
  gate-only.
- The seal/report allowance (+15min) is an estimate, not a measurement;
  kernel deliverable 4 should replace it with an observed figure.
- `estimates/v1.json` mixes appliance-Linux and local-macOS durations in
  local-inclusion entries; entries carry `os` but not host class. Cross-host
  pooling may inflate confidence for keys with mixed sources.

## Exit-criteria accounting (PRI-2935)

1. Corpus populated + selection manifests recorded — ✅ (`corpus/gate-20260808{,-copilot}/`, digest above; `corpus/` gitignored).
2. Canonical manifests load with zero loud errors — ✅ (388/194 gate; 202/110 copilot).
3. Sweep published: 72 configs nominal + reserve-stress + allowance-inclusive, wait attribution, skew — ✅.
4. Validation: synthetic oracles exact (13 engine tests); historical self-replay 1.015; held-out calibration reported — ✅.
5. `estimates/v1.json` checked in, determinism + fallback tested — ✅ (T2, T6).
6. This entry — ✅.
7. Linear updates — posted with this entry.

## Provenance

- Appliance enumeration/acquisition commands + allowlists:
  `corpus/runs-gate-20260808{,-copilot}.txt`, selection manifests in the
  corpus dirs (gitignored, regenerable).
- Curation tooling: `corpus/curate.py` (scratch); reconciliation output
  verified 388 scored + 9 excluded.
- Analysis tooling: `corpus/calibration.ts` (held-out + historical replay).
- Sensitive-material note: the corpora contain verdicts and trajectories
  (prompt/tool content); homes and transcripts were never pulled.
