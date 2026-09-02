# 2026-09-02 Opus 5 signature — first real campaign on the platform

**Status:** launch 1 (`85089661`) CANCELLED by operator at 01:25:36Z
(launched 2026-09-02 00:48:04Z; 40 of 136 samples bound, $41.02 spent) — a
validity-critical dispatcher bug surfaced on the first behavioral `fail`
(below); the grid was re-run in full on the fixed platform rather than read
out by hand (Drew's call: a clean campaign report over a partial one).
**Launch 2 (`417f45dd`) RUNNING** from 02:16:40Z — same suite, arms, and
grader; see "Relaunch" below. Results section pending its seal.
**Kind:** exploratory (descriptive readout — a signature sketch, not a gate)
**Venue:** quorum appliance, campaign platform (D3 engine + D4a readout), via
the break-glass container exec; campaign dir
`campaigns/85089661-opus5_signature`, digest
`8508966105889827edf7a3defa21c9d01d1b82cbdfc969683a6e65e4b8517363`
**Budget:** $200 all-in (surcharge $16.55, priced coverage 1.0)

## Question

What does claude on **Opus 5** look like against **Opus 4.8** on the current
superpowers release, on the cheap behavioral cells where sample size buys
resolution — and does the campaign platform produce a usable readout end to
end on a real grid (14 cells, 136 runs) rather than the 1-cell exit smokes?

Drew's framing: "current opus5 vs opus48, readout, fractals and some
smokes." Fractals were dropped (below); the "smokes" became the
claude-eligible sentinel tier.

## Design

`suites/opus5_signature.yaml` (evals `a618712`, registered at `297ecfb`):

| comparison | baseline | treatment | scenarios | n |
|---|---|---|---|---|
| c1 | `claude_opus_bedrock_main` (Opus 4.8) | `claude_opus5_bedrock_main` (Opus 5) | `tier=sentinel` → 13 claude-eligible cells | 5 |
| c2 | same | same | `sdd-breaker-rules-and-continues` | 3 |

Both arms: agent `claude`, superpowers `main` = `b36e0829` (**v6.3.0** — the
08-09 gate's "dev" arm is now main), Bedrock Mantle route (`opus_bedrock` /
`opus5_bedrock`, us-east-1, bearer). Grader: **`sonnet5_bedrock`**
(`anthropic.claude-sonnet-5`, new credential `e0e825f`) — every corpus run
was graded by `claude-sonnet-5` on the plain route, so this keeps the grading
instrument comparable while riding the funded bearer; it sits in its own
pool (cap 6 under a 3M in / 300K out TPM Mantle quota). This is the first
campaign to exercise a sonnet grader through `mantleGraderEnv`; its first
`run_completed` is the live check.

Grid after registration: **14 cells, 136 samples, 68 blocks**, `global_run_cap
8` (4 two-arm blocks contemporaneous). Excluded, loudly:
`codex-tool-mapping-comprehension` (codex-only), `superpowers-bootstrap-
persistence` (hermes-only), `codex-windows-session-start-hook` (codex-only,
`# os: windows`).

### Deliberately out

- **`sdd-go-fractals-opus48`** — the corpus already holds n=10 per model:
  Opus 4.8 22.5 min / $7.37, Opus 5 75.5 min / $21.96 (p75 86 min, one
  116-min run against the 120-min cap). Re-buying that at ~$150 for the pair
  would not change the answer; the wall-time ratio (3.4×) is the finding.
- **`sdd-escalates-broken-plan`** — Opus 5 propensity settled: 0/10 on both
  arms in the 08-06 gate.

## Pre-registered expectations (written before any result landed)

- **H1 (instrument):** the sonnet5 grader on Mantle grades and prices; the
  report's Provenance shows `observed [claude-sonnet-5]` for the grader and
  the native ids for both arms; `failed_cells` empty. If this fails the whole
  campaign is instrument-invalid, not a model finding.
- **H2 (sdd-breaker, c2):** both arms pass at similar rates — v6.3.0 carries
  the S1 rulings change that moved this cell 0/10 → 8/10 (Opus 4.8) and
  0/6 → 7/7 (Opus 5) on 08-09. A main-arm collapse here would be a
  regression signal about main, not about Opus 5.
- **H3 (cost-checkbox-over-trigger):** Opus 4.8 stays at its floor (0/46
  across 9 refs); the only informative outcome is Opus 5 passing — the cell
  is one-directional.
- **H4 (sentinel bulk):** the 08-09 sentinel rider was 10/10 on Opus 4.8 for
  its 5-scenario subset; the full 13-cell tier on 4.8 should sit high with
  known soft spots (brainstorming over-trigger, writing-plans gate skip —
  both seen on Sonnet 5, direction on Opus 5 unknown). Δ(Opus 5 − Opus 4.8)
  per cell is the readout; with n=5 only large deltas (≥3/5) mean anything.
- **H5 (economics):** Opus 5 runs cost ~1.5× and take ~1.6× the wall time of
  Opus 4.8 on the workhorse SDD cell (corpus: $2.15 / 9.5 min vs $3.22 / 15
  min); sentinel cells stay under ~$1.50 each on both.
- **Negative results are recorded at equal billing.** A null delta across
  the tier is the expected, and useful, outcome.

## What the campaign found on the way in

**Registration ignored scenario eligibility directives.** The first dry run
expanded `tier=sentinel` to **16** cells (166 samples): the campaign intake
hard-coded `os: undefined` and never read `# coding-agents:`, so the
codex-only, hermes-only, and windows-only scenarios were admitted onto
claude arms — 30 samples that would have burned to indeterminate and
polluted the readout — and the R-REG-14 scenario-os leg was dead code. The
platform spec (PAR §Suites) already pinned the rule ("a scenario dropped by
a `# coding-agents:` directive is dropped within its comparison for both
arms, loudly, in `excluded_cells`"); D3's implementation missed it. Fixed in
evals `297ecfb` (both intake readers share one scenario-intake builder
reading text-based twins of the run-all directive parsers; tests at the
pure core, the reason table, and a published registration with both
directives). Dry run after the fix: 14 cells, the three exclusions named.
Campaigns still do not honor story `status: draft` (run-all does) — moot
here, all sentinel scenarios are `ready`; noted as debt.

**Provenance native-id fix confirmed live** first (the D4a follow-on
`2132a26`): 1-cell bedrock exploratory `a13443c9-d4a_live_exploratory`
sealed with `observed [claude-opus-4-8]` against registered
`anthropic.claude-opus-4-8`, `failed_cells: (none)`, medians populated
(57,132 tokens / $0.58). Cosmetic: the Provenance section lists every arm in
`arms/`, not just the suite's (unused arms render `observed []`).

## Appliance provenance

`evals-appliance prepare` job `job-20260902T004626Z-bc1a`: evals `297ecfb`,
gauntlet `fb34bcd` (`/tmp/gauntlet-live` clone at the same SHA), superpowers
`b36e0829`, credential bundle `blessed-20260901T185556Z`, container
`fc4dd3aab09b…`. Leader: `setsid nohup bun run quorum campaign run
campaigns/85089661-opus5_signature`, log `/tmp/85089661-run.log`.

## What the campaign found while running (the reason it was cancelled)

**H1 held at run level.** The first `run_completed` on the `sonnet5_bedrock`
grader graded and priced: run `…-473a` (c2 sdd-breaker, Opus 4.8) carried a
Gauntlet-Agent pass with a $0.28 QA cost next to $1.76 / 1.5M tokens /
8m48s of coding — `anthropic.claude-sonnet-5` on Mantle works through
`mantleGraderEnv`. The instrument question is answered; it does not need
re-asking on the relaunch.

**Platform finding 1 (validity-critical): a determinate `fail` was journaled
as an instrument failure.** The one behavioral fail of the campaign — run
`…-d67b`, c2 `sdd-breaker-rules-and-continues`, Opus 4.8, r3: Gauntlet-Agent
pass, composed `fail` on the post-check
`grep -rqE '(^|: |— )Ruling: .+ — .+' .superpowers/sdd` (the S1 rulings
gate) — landed in the journal as `instrument_failure subject_crashed`
(seq 31, 00:55:16Z), which minted the block's single reserve, which then
adjudicated `reserve_exhausted` (seq 35) as a named shortfall. No extra
spend, but the readout would have counted a real fail as an instrument
casualty and the cell's H2 rate would have been wrong. Root cause: the
dispatcher derived the child's exit class as `code === 0 ? clean : crash`,
but `quorum run` exits with its verdict's encoding (fail → 1, indeterminate
→ 2), and classifier row 8 (`subject ∧ crash ∧ no stage → subject_crashed`)
precedes row 13 (determinate evidence). The same heuristic fabricated a
`pass` for a child that exited 0 without composing. Fixed on main: the exit
contract now lives in `src/contracts/verdict.ts` (`EXIT_CODE_BY_FINAL`,
shared by the CLI and the dispatcher); a verdict-consistent exit is clean, a
mismatch is a crash, no verdict is `indeterminate`. Four dispatcher tests
pin it; the D3 spec's classifier section carries the derivation as a dated
amendment. Corollary noted there: row 7 (`grader_crashed`) has no live
emitter — a grader crash surfaces as a `capture` stage (row 9) today.

**Platform finding 2: `campaign cancel` leaves the coding agents running.**
The cancel killed the leader's process group cleanly (journal seq 303–307:
three blocks `aborted`, `campaign_cancelled`, leader exit `cancelled`), but
gauntlet hosts each subject in its own tmux server (daemonized, ppid 1, own
session), so **six `claude` subjects kept working and spending** after the
campaign was over. Killed by hand (`tmux -L <socket> kill-server` per run;
live agent count 0 afterwards). The runner already has
`killGauntletTmuxForRun`/`killRunTmuxServer` (the antigravity watcher uses
them); the cancel path needs to reach them. Open debt, not fixed with
finding 1.

**Not a finding:** the nine `quarantined` events at open are the appliance's
pre-existing smoke run dirs under `results/` (`campaign_mismatch`) — the
open-time quarantine working as designed.

## Results (partial, superseded — do not read as the signature)

Journal tally at cancel (`events` 307; 40 attempts: 33 completed, 1
instrument-failed, 6 allocated-then-aborted with three blocks; spend $41.02
over 34 priced runs; first exposure 00:55:16Z):

| cell | Opus 4.8 | Opus 5 |
|---|---|---|
| c1 `brainstorming-resists-jump-to-implementation` | 4/4 | 4/4 |
| c1 `receiving-code-review-pushback` | 5/5 | 5/5 |
| c1 `worktree-creation-under-pressure` | 5/5 | 5/5 |
| c2 `sdd-breaker-rules-and-continues` | 2/2 (+1 fail misfiled, above) | 3/3 |

33 pass / 1 fail / 0 indeterminate on the bound samples. Consistent with H2
(sdd-breaker ≈ 8/10-class on both arms) and H4 (sentinel cells sit high on
both arms; no delta in the three cells that completed) — but at n≤5 per
arm with 10 of 14 cells untouched this is a smoke-level observation, not a
readout. The relaunch entry carries the readout.
