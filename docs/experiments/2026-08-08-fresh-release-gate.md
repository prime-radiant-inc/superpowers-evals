# 2026-08-08 Fresh Release Gate — dev vs main, fresh-only

**Status:** design locked by Drew 2026-08-07/08; prerequisites in flight; NOT yet submitted.
**Arms:** CONTROL = superpowers origin/main `44c9b2d6e889982ac18c27d05a19fefe335194e1` (v6.2.0, released) vs TREATMENT = origin/dev tip `2d4b675b498b466df249304e2ba8a4640ccaa01f`.
**Question:** is dev ready to merge to main?
**Venue:** quorum appliance, per-job `--superpowers-ref` pinning, arms interleaved at job boundary.

## Why this battery exists

The 2026-08-06/07 overnight gate (352 runs, $650, verdict GREEN) is discredited as a release
gate: its codex column silently ran gpt-5.5 (model chosen implicitly via the `openai_responses`
credential; the design doc never named a codex model), the agent under test could read its own
scenario's `story.md` answer key, and `find /workspace` exposed other concurrent runs' trees.
Full defect list: `2026-08-06-dev-vs-main-overnight-gate.md` (13 defects, 3 result-invalidating).

**Drew's ruling: nothing from the old run is used as gate evidence. There is no lean option.**
Every number in this gate's verdict comes from fresh runs. The old corpus is used for exactly
two non-evidence purposes: instrument calibration (validating revised checks against stored
transcripts of BOTH arms) and cost/wall-clock sizing.

The treatment tip was verified behaviorally identical to the old gate's treatment SHA
(`c367f804`) for claude/codex columns: the 7-commit delta is a Devin manifest, docs, and a
Copilot-only visual-companion paragraph.

## Locked decisions (Drew, 2026-08-07/08)

1. Fresh-only; no carry-over of any old-gate cell.
2. Four columns: opus-4.8, opus-5, codex gpt-5.6-**sol**, codex gpt-5.6-**luna**.
   Luna runs the FULL codex grid ("luna everywhere") and gets a new codex credential.
3. Fractals raised to n=5/arm on all four columns — tokens/wall is a primary signal for us.
4. cost-spec-plan-duplication at n=10/arm per column (pre-registered probe; see power table).
5. Isolation handled by policing, not blocking: post-run transcript path-grep auto-discards
   any run that read outside its own root; runs re-bought from the backfill budget.
   The mount-namespace fix is deferred, not cancelled.
6. (amended 08-08) **No hard spend tripwire** — bounded sequential jobs with per-job cost
   logging; expected ~$1,800 all-in. Read-out costs tallied post-hoc from `costs --json`.
7. B1 three-path-router scenario authoring is decoupled (next week). The brainstorming router
   — dev's largest single change — ships unmeasured by this gate, and the verdict must say so.
8. Five-column campaign's remaining jobs stay parked; exactly one driver owns the appliance.

## Columns and credentials

| column | credential | model | notes |
|---|---|---|---|
| opus-4.8 | `opus_bedrock` | anthropic.claude-opus-4-8 | existing, passthrough-verified |
| opus-5 | `opus5_bedrock` | anthropic.claude-opus-5 | existing; Bedrock quota 20M in / 2M out TPM |
| codex-sol | `openai_responses_56sol` | gpt-5.6-sol | existing, validated 07-14; **primary codex verdict column** (bare "gpt-5.6" floats to sol, so sol is what users get) |
| codex-luna | `openai_responses_56luna` | gpt-5.6-luna | **NEW credential — prerequisite P2**; replication/robustness column |

Codex model-selection rules: never bare `gpt-5.6` (floating alias). Sol and luna share one
OpenAI limiter pool (limiterKey = base_url|api): the two codex columns partly serialize, which
costs wall clock, not validity. On a limiterKey collision the alphabetically-first credential's
max_concurrency wins — keep both entries at the same value.

Excluded columns, with reasons the verdict must carry: opus-5 does NOT run sdd-escalates
(0/10 BOTH arms on 08-06, 20/20 identical product-intent reclassification — a settled model
propensity that cannot discriminate arms; re-measuring buys nothing for a dev-vs-main gate).

## Cell grid

Cell classes: **C** = confirmatory (can move the verdict), **P** = probe (pre-registered
underpowered; null reads "unresolved", never "no effect"), **T** = tripwire (rendered
colorless; two states — clean, or fired → transcript investigation), **D** = descriptive
(numbers only, no verdict language).

| scenario | class | opus-4.8 | opus-5 | codex-sol | codex-luna | runs | est (coding) |
|---|---|---|---|---|---|---|---|
| sdd-escalates-broken-plan | C | n=10 | — | n=10 | n=10 | 60 | $210 |
| sdd-breaker-rules-and-continues | C | n=10 | n=8 | n=8 | n=8 | 68 | $242 |
| sdd-breaker-structural-blocks (arm-neutral invariant) | T | n=4 | — | n=4 | n=4 | 24 | $60 |
| cost-spec-plan-duplication | P | n=10 | — | n=10 | n=10 | 60 | $240 |
| finishing-branch-untracked-plan-at-cleanup | C | n=6 | — | n=6 | n=6 | 36 | $72 |
| codex-subagent-wait-mapping | C | — | — | n=8 | n=8 | 32 | $32 |
| writing-plans-no-spec-conversational | T | n=4 | — | — | — | 8 | $8 |
| brainstorming-resists-jump-to-implementation | T | — | — | n=6 | n=6 | 24 | $30 |
| cost-trivial-task-review-fanout (SDD batching) | T | n=4 | — | — | — | 8 | $10 |
| sdd-survives-compaction (pilot: transcripts read before any scale-up) | T | — | — | n=2 | n=2 | 8 | $40 |
| sdd-go-fractals-opus48 | D | n=5 | n=5 | n=5 | n=5 | 40 | $680 |
| sentinel rider ×5 (superpowers-bootstrap, triggering-tdd, verification-phantom-completion, triggering-finishing-a-development-branch, worktree-no-drift-to-main) | T | n=2 | — | — | — | 20 | $24 |
| **Total** | | | | | | **388** | **~$1,648** |

Explicitly excluded scenarios: `codex-tool-mapping-comprehension` (VOID since superpowers
e7ddc25e — tests deleted content), `cost-checkbox-over-trigger` (floored both arms 08-06,
uninformative), `sdd-breaker-adjudicates-at-cap` (pass-flip commit not on any branch —
excluded unless revalidated against `2d4b675b` before freeze), brainstorming-resists on claude
columns (10/10 ceiling both arms — it cannot see the router change; it appears here only as a
codex collapse tripwire because codex has never been observed on it at 5.6).

## Pre-registration

Committed at freeze time, before run 1. Sidedness: all Fisher tests **two-sided**. Every
p-value and power figure below is generated by `2026-08-08-fresh-release-gate-power.py`
(committed alongside; stdlib-only). No hand-computed statistic may appear in the read-out.

### Decision rule

- **RED** = any dev-unfavorable p<.05 on a confirmatory (C) cell, OR any tripwire (T) firing
  that survives transcript investigation (i.e., the failure is real dev behavior, not
  instrument/infra), OR fractals completion collapse (dev completing where main fails or vice
  versa in ≥3/5 runs on any column).
- **GREEN** = no RED trigger, with the cannot-answer list attached verbatim.
- A single surprising significant cell in either direction triggers replication before it
  colors any verdict; it never changes the same battery's verdict.
- Codex verdict column is **sol**. If sol and luna disagree in direction on the same C cell,
  the pre-registered read-out is "codex: variant-dependent, investigate" — never auto-RED,
  never cherry-pick the favorable variant.
- cost-spec (P): analyzed **stratified by column** (CMH exact / pre-registered fixed weights);
  per-column splits reported descriptively; the raw pooled number is never pilled. Columns
  disagreeing in direction reads "column-dependent, unresolved."
- No manual rescoring of fresh runs by instrument authors. Any rescore ships as a separately
  labeled secondary number, never in the headline.

### Determinate-n floors and backfill

Guard-flagged (leak-police) and infra-failed runs are auto-discarded and re-bought in matched
cross-arm pairs (keeps time-of-day symmetric), up to a per-cell retry budget of +20% of cell n,
counted in the cumulative spend log and tagged first-attempt vs backfill in the read-out.
Floors: n=10 cells report a verdict only at determinate n≥8/arm; n=8 → ≥6/arm; n=6 → ≥5/arm.
Below floor, the cell reads **UNDERPOWERED** regardless of split.

### Power tables (generated output, 2026-08-08)

Fisher exact, two-sided:

| split | p |
|---|---|
| 0/10 vs 9/10 | 0.0001 |
| 2/10 vs 9/10 | 0.0055 |
| 3/10 vs 9/10 | 0.0198 |
| 0/10 vs 5/10 | 0.0325 |
| 0/8 vs 8/8 | 0.0002 |
| 1/8 vs 8/8 | 0.0014 |
| 0/6 vs 6/6 | 0.0022 |
| 1/6 vs 6/6 | 0.0152 |
| 2/6 vs 6/6 | 0.0606 (ns) |
| 0/4 vs 4/4 | 0.0286 |
| 1/4 vs 4/4 | 0.1429 (ns) |
| 0/2 vs 2/2 | 0.3333 (ns) |

Exact power at α=.05:

| cell, assumed true rates | power |
|---|---|
| sdd-escalates n=10/arm, 2% vs 90% | 0.996 |
| breaker r-a-c n=10/arm, 2% vs 67% | 0.857 |
| breaker r-a-c n=8/arm, 2% vs 67% | 0.705 |
| cost-spec pooled n=30/arm (3 cols × 10), 17% vs 50% | 0.708 |
| finishing-branch n=6/arm, 10% vs 90% | 0.659 |
| wait-mapping n=8/arm, 5% vs 90% | 0.973 |

Honest limits, stated before any results: n=10 cells cannot resolve 20–30-point drifts
(that needs n≥25/arm); 2/6 vs 6/6 is not significant; n≤4 cells reach significance only on a
perfect split and are therefore tripwire-class by construction; the n=2 rider is statistically
blind and exists only to catch collapse. cost-spec at ~71% pooled power is a probe by Drew's
explicit choice: a null result reads "still unresolved."

### Fractals telemetry (D)

Primary metric: per-run total coding tokens, dev vs main per column, **Mann-Whitney exact,
two-sided** (n=5/arm: complete separation p=0.0079 — the only pre-registered significance
claim available; anything short of separation reports medians + IQR, no verdict language).
Wall time: descriptive only (confounded by time-of-night API load). Completion is a tripwire
(see decision rule). Seat-level telemetry feeds the offline token-objective analyzers; nothing
from it enters the verdict.

## Prerequisites (single freeze commit on evals main, then no merges until drained)

The appliance fast-forwards its evals checkout to origin/main on every job — a mid-campaign
evals merge silently swaps the instrument. Everything below lands in ONE commit; the battery
launches only after it is on origin/main.

| # | blocking | item |
|---|---|---|
| P1 | yes | Codex sol pin: all codex-sol cells run `--credentials openai_responses_56sol`; design doc (this file) names the models explicitly |
| P2 | yes | NEW `openai_responses_56luna` credential (model `gpt-5.6-luna`, api openai-responses, harnesses [codex], max_concurrency matching sol); verify obol prices gpt-5.6-luna (an unpriced model zeroes that column's report cost data) |
| P3 | yes | Leak police: post-run transcript grep flags any read of `story.md`/`checks.sh` or any path outside the run's own root → auto-indeterminate + backfill; wired into the driver |
| P4 | dropped | (Drew 08-08) No spend tripwire, no driver cost parser. Read-out costs tallied post-hoc from `costs --json` per job ({rows, aggregate} shape). Survives inside P10: smoke asserts est_cost_usd non-null and >0 on BOTH codex sol AND luna rows — luna is a new credential; an unpriced model zeroes that column's report cost data |
| P5 | DONE | Ruling regex → `(^|: |— )Ruling: .+ — .+` (case-sensitive, ledger-entry contexts only). CALIBRATED against the full 24-run 08-06 breaker corpus, both arms: main 0/12 (an unanchored two-part form hit 1/12 — a sentence-embedded Ruling in main-opus5 Final-review prose — the entry-context anchor excludes it), dev-codex 1/3 → 3/3 on-disk (4/4 incl. transcript-recovered rep-1), zero dev hit-runs lost. Caveat pre-registered: anchor is corpus-empirical, not structural; any main-arm hit in the read-out gets its matched line inspected |
| P6 | DONE | sdd-escalates `repeat(40)` literal grep → behavioral check (renders banners via the plan's two mandated exports, asserts width 40 — cannot match source constants). CALIBRATED: executed against all 50 retained 08-06 workspaces — zero determinate verdict flips; the 3 BANNER_WIDTH false-flagged dev-opus5 runs read clean |
| P7 | yes | Explicit `quorum_max_time` for every scenario in the grid, sized from p90 wall on the slowest column present ×1.25 codex wall factor; the six confirmed-uncapped scenarios get caps (codex-subagent-wait-mapping, superpowers-bootstrap, verification-phantom-completion, triggering-finishing-a-development-branch, writing-plans-no-spec-conversational, worktree-no-drift-to-main); re-check finishing-branch 20m cap vs codex-5.6 |
| P8 | yes | Premise guard on codex-subagent-wait-mapping: file-contains preflight asserting the wait-guidance text exists at `2d4b675b` and its absence on `44c9b2d6` is the discriminator |
| P9 | yes | Driver, slimmed (Drew 08-08): per-column job composition (REQUIRED, not hardening — run-all's credential cross-product would buy cells the grid excludes, e.g. opus5×escalates; the 08-06 free 4.8 sentinel column was this bug); abort on codex model-id mismatch (per-job jq sweep of trajectory.json); abort on ≥3 investigate verdicts in one job (credit-exhaustion signature — hit 2 of the last 3 batteries); lock poll with backoff before each submit. Halt/pause/page automation dropped |
| P10 | yes | Smoke before spend: disk preflight `df -h /srv/quorum` (≥50GB or reclaim via `docker builder prune -f`); one bootstrap cell per column asserting resolved refs == exactly `44c9b2d6`/`2d4b675b`, model ids from live runs (all four), est_cost_usd non-null and >0 on codex rows, codex CLI version in-container; TWO cells run concurrently asserting each transcript shows no path outside its own root (proves the leak detector fires, not vacuous) |
| P11 | no | Live OpenAI responses-surface probe (1-token, HTTP 200) pre-battery — there is no credits-balance endpoint; the probe + smoke completion tokens are the checkable substitute |
| P12 | no | Revalidate or formally exclude sdd-breaker-adjudicates-at-cap against `2d4b675b` |

## Operations

- **Ownership:** Drew confirms five-column jobs stay parked before run 1; one driver only.
- **Ordering:** decision (C) cells first, arms interleaved per job, probes next, fractals and
  pilots last — truncation at any point leaves matched pairs and the C-grid complete first.
- **Schedule:** ~3 nights of lock time (sol/luna pool serialization + 40 fractals runs at
  60–120m each). Publish the per-job schedule with this doc before launch.
- **Spend:** no hard tripwire (Drew 08-08). Expected ~$1,800 all-in (~$1,648 coding-basis
  point estimate). Per-job costs tallied from `costs --json` into driver state; cumulative
  spend reviewed at each morning checkpoint.
- **Salvage boundary:** the 08-06 corpus is calibration-and-sizing material only. If any
  old number appears in the read-out for context it is labeled `[08-06, not gate evidence]`.

## What this gate cannot answer (attach to any GREEN verbatim)

1. The brainstorming three-path router (+106/−7, dev's largest change) — no instrument exists;
   B1 scenario is next week's work.
2. 20–30-point rate drifts on any C cell (Fisher floor at these n).
3. SDD batching beyond a collapse tripwire (n=4 coverage-only).
4. Opus-5 sdd-escalates behavior — settled model propensity, deliberately not re-bought.
5. Harness generalization beyond these four columns (five-column campaign covers a snapshot
   at the older dev SHA).
6. Real-user token burn — fractals telemetry feeds the offline analyzers; no purchased verdict.
