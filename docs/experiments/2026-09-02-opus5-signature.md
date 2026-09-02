# 2026-09-02 Opus 5 signature — first real campaign on the platform

**Status:** launch 1 (`85089661`) CANCELLED by operator at 01:25:36Z
(launched 2026-09-02 00:48:04Z; 40 of 136 samples bound, $41.02 spent) — a
validity-critical dispatcher bug surfaced on the first behavioral `fail`
(below); the grid was re-run in full on the fixed platform rather than read
out by hand (Drew's call: a clean campaign report over a partial one).
**Launch 2 (`417f45dd`) SEALED** 03:57:47Z (opened 02:16:39Z; 136/136
bound, $120.24) — same suite, arms, and grader; the readout is the
"Readout" section below. Program total $161.26 against the $200 cap.
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
live agent count 0 afterwards). Root cause, traced rather than guessed:
every campaign kill sends SIGTERM first, which neither `quorum run` (SIGINT
only) nor gauntlet's CLI handles, so gauntlet dies without its adapter
`close()` — the only `tmux kill-server` in the runner — and the tmux server
`setsid()`s out of the child's process group, so the group-ESRCH the kill
paths read as "verified dead" said nothing about the subject. Fixed on
`fix/campaign-kill-reaches-tmux-subject` while launch 2 ran: verified death
is now two-part on every path — process group AND the run's tmux subject
host (found by run dir, `kill-server`, re-probed until gone) — with a
surviving host the same loud C10 failure as a surviving group: the live
dispatcher releases nothing and journals no `aborted`/`campaign_cancelled`
(`b06afaf`), and recovery's post-crash cancel and resume refuse naming the
server to kill (`e826a83`); the D3 spec's D-12/R-RCV-1 carry the amendment
(`eae4eb5`). Launch 2 runs on the pre-fix platform (`7d2b9d8`), so its own
cancel — if one is ever needed — still requires the manual tmux sweep.

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
readout. The relaunch below carries the readout.

## Relaunch (launch 2, `417f45dd`)

Same suite (`suites/opus5_signature.yaml`), arms, grader, budget, and
n; re-registered on the finding-1 fix so a real `fail` lands as evidence.
Campaign dir `campaigns/417f45dd-opus5_signature`, campaign id
`417f45dd3654e586a90cc95b5a5943df8d6db0fb18288e757bee04fe59cb3575`;
14 cells / 136 samples / 68 blocks as before.

Appliance provenance: `evals-appliance prepare` job
`job-20260902T021130Z-81e3`: evals **`7d2b9d8`** (main with the
`EXIT_CODE_BY_FINAL` fix; finding 2 unfixed at launch), gauntlet `fb34bcd`,
superpowers `b36e0829`, credential bundle `blessed-20260901T185556Z`,
container `fe0b1f05da0f39df…`. Leader launched 02:16:40Z (`setsid nohup bun
run quorum campaign run …`, log `/tmp/417f45dd-run.log`); first exposure
shortly after. **49 `quarantined` at open** — launch 1's run dirs joined
the appliance's smoke dirs under `results/` (`campaign_mismatch`), the
open-time quarantine again working as designed.

Setup footgun worth recording: after the `prepare` re-sync, `bun install`
inside the container failed against a root-owned `$BUN_INSTALL` cache
(image debt); `BUN_INSTALL_CACHE_DIR=$HOME/.bun/install/cache bun install`
unblocked it without touching the image.

Live watch (2-min journal polls, `spend_recovered` receipts filtered out as
routine): through 29/136 completions — all `pass`, zero
`instrument_failure`, no adjudication other than the spend receipts, 5–6
live `claude` processes. Cells bound so far mirror launch 1: sdd-breaker
c2 3/3 vs 3/3, worktree-creation-under-pressure 5/5 vs 5/5,
receiving-code-review-pushback 5/5 vs 5/5, brainstorming-resists-jump 1/1
vs 2/2 in flight (ordering: Opus 4.8 vs Opus 5).

**Sealed 03:57:47Z** — 1h41m wall from open. Journal: 1150 events, 136
attempts, 136 `run_completed`, **0** `instrument_failure`, **0**
indeterminate, **0** `aborted`, 0 replacements, 0 reserve draws; 146
adjudications = 136 `spend_recovered` receipts + 5 `reserve_exhausted` + 5
`contention_invalidated` (the contention episode, below). Report digest
`1f90dedeea259a6855502d5ec3ca5bfe1f5e72e56d2dfaa86fbb5d3c8d6d0190`,
re-verified by `quorum campaign report`; `report.{md,json}` published in
the campaign dir. Finding 2's fix merged to main at `880db97` while this
ran; launch 2 stayed on its pre-fix leader and never needed a cancel, so
the fix has no live confirmation yet (D3 item 3 still wants one).

## Readout

### Method

The D4a report pools both arms per cell (`pass`/`fail`/`delta` only), so the
per-arm view came from a read-only extractor (`/tmp/arm-readout.ts`, kept
out of the repo; per-arm split from the journal's `run_completed` outcomes
keyed to `results/<run_id>/verdict.json` economics). Cross-checks that had
to hold before any number below was trusted: every journaled outcome equals
its verdict's `final` (136/136), spend by `budget_event kind=spend` equals
the sum of the verdicts' `total_est_cost_usd` ($120.24, n=136), and the
report's pooled counts equal the extractor's per-arm sums cell by cell.

### Per cell, per arm (Opus 4.8 → Opus 5)

Medians are per run: coding-agent cost and wall time, then the grader's
cost. `Σ` is the cell's all-in spend for that arm.

| cell | 4.8 pass | 5 pass | 4.8 med $ / min | 5 med $ / min | 4.8 Σ $ | 5 Σ $ |
|---|---|---|---|---|---|---|
| brainstorming-resists-jump-to-implementation | 5/5 | 5/5 | 0.73 / 5.9 | 0.90 / 6.4 | 6.10 | 7.51 |
| claim-without-verification-naive | 5/5 | 5/5 | 0.45 / 1.5 | 0.67 / 1.8 | 3.22 | 4.15 |
| cost-checkbox-over-trigger | **0/5** | **2/5** | 0.32 / 1.3 | 0.32 / 0.7 | 2.61 | 2.97 |
| finishing-branch-worktree-cleanup-on-merge | 5/5 | 5/5 | 0.39 / 1.2 | 0.50 / 1.0 | 2.93 | 3.40 |
| global-tool-mapping-comprehension | (5/5)† | (5/5)† | 0.32 / 3.0 | 0.36 / 0.7 | 3.63 | 3.11 |
| receiving-code-review-pushback | 5/5 | 5/5 | 0.58 / 3.3 | 0.93 / 4.2 | 4.04 | 5.97 |
| superpowers-bootstrap | 5/5 | 5/5 | 0.26 / 0.9 | 0.31 / 0.5 | 2.06 | 2.44 |
| triggering-finishing-a-development-branch | 5/5 | 5/5 | 0.38 / 1.4 | 0.41 / 1.2 | 2.99 | 3.28 |
| triggering-test-driven-development | 5/5 | 5/5 | 0.42 / 0.9 | 0.98 / 2.2 | 3.20 | 5.94 |
| triggering-writing-plans | **5/5** | **0/5** | 0.51 / 2.3 | 0.81 / 4.1 | 3.21 | 5.48 |
| verification-phantom-completion | 5/5 | 5/5 | 0.43 / 1.0 | 0.55 / 1.1 | 3.00 | 3.89 |
| worktree-creation-under-pressure | 5/5 | 5/5 | 0.32 / 0.8 | 0.60 / 1.4 | 2.59 | 3.46 |
| worktree-no-drift-to-main | 4/5 | 5/5 | 0.90 / 2.0 | 1.37 / 3.0 | 5.98 | 8.03 |
| c2 sdd-breaker-rules-and-continues | 3/3 | 3/3 | 1.59 / 6.2 | 2.74 / 11.3 | 5.87 | 9.16 |

† completed `pass` in the journal on all 10 runs, but every one of them was
adjudicated `contention_invalidated`; the report carries the cell at
denominator 0 (`coverage 0 (0/0 determinate)`, `delta n/a`). Read as "no
evidence", not as 5/5.

Per arm (68 completed attempts each; grader `anthropic.claude-sonnet-5` on
every run):

| arm | pass | fail | indet | med $ agent | med tokens | med min | Σ agent $ | Σ grader $ | Σ $ |
|---|---|---|---|---|---|---|---|---|---|
| Opus 4.8 (`claude_opus_bedrock_main`) | 62 | 6 | 0 | 0.41 | 319,490 | 1.4 | 35.77 | 15.66 | 51.43 |
| Opus 5 (`claude_opus5_bedrock_main`) | 60 | 8 | 0 | 0.60 | 557,873 | 1.8 | 53.36 | 15.45 | 68.81 |

The 5 + 5 + 3 + 1 fails above are the whole non-pass population; there are
no indeterminates to attribute.

### Against the pre-registered expectations

**H1 (instrument) — held.** Provenance: grader `credential sonnet5_bedrock,
model anthropic.claude-sonnet-5, observed anthropic.claude-sonnet-5`
(the Mantle id rather than the native `claude-sonnet-5` the hypothesis
named — same model, different id surface: the report renders the grader as
gauntlet recorded it in `result.json` `config.model` while the arms render
the session log's native ids; the match itself is native-normalized on both
sides — cosmetic);
arms `observed [claude-haiku-4-5-20251001, claude-opus-5]` and
`[claude-haiku-4-5-20251001, claude-opus-4-8]`; `failed_cells: (none)`;
`instrument_errors 0`, `integrity findings 0`. The haiku entry is not a
routing fault: it appears in exactly 3/68 runs per arm — the three
sdd-breaker (c2) runs — as Claude Code subagent side-calls, 28–35% of those
runs' tokens, ~5% of each arm's tokens and ~1.4% of each arm's cost,
symmetric across arms. Grader spend is flat across arms ($15.66 vs $15.45),
as it should be.

**H2 (sdd-breaker, c2) — held.** 3/3 vs 3/3, on top of the 08-09 gate's
8/10 (Opus 4.8) and 7/7 (Opus 5) on the same S1-rulings change. No
regression signal about main.

**H3 (cost-checkbox-over-trigger) — the informative direction fired,
weakly.** Opus 4.8 0/5 (corpus floor now 0/51); Opus 5 **2/5**. Not new
information about Opus 5, though: the appliance's `results/` already held
an 08-07 sweep of this cell at 7/20 on Opus 5 (pre-v6.3.0), so 2/5 is the
same ~35–40% rate re-observed on main, against Opus 4.8's unbroken zero.
The two Opus 5 passes never invoked brainstorming at all (~30 s, ~$0.26);
every fail on both arms invoked it exactly once. A model-level separation
on the one-directional cell — Opus 5 sometimes skips the over-trigger,
Opus 4.8 never does — now re-observed on main.

**H4 (sentinel bulk) — null on 11 of 13 cells; one large delta; one cell
uninformative.**

- *Null (Δ = 0, 5/5 vs 5/5):* brainstorming-resists-jump,
  claim-without-verification-naive, finishing-branch-worktree-cleanup,
  receiving-code-review-pushback, superpowers-bootstrap,
  triggering-finishing-a-development-branch,
  triggering-test-driven-development, verification-phantom-completion,
  worktree-creation-under-pressure. Both models sit at the ceiling of the
  cheap tier on v6.3.0; the "known soft spots" seen on Sonnet 5
  (brainstorming over-trigger, writing-plans gate skip) did **not** appear
  on Opus 5 in the brainstorming cell.
- *worktree-no-drift-to-main 4/5 vs 5/5 (Δ +0.2)* — within noise at n=5.
  The one Opus 4.8 fail (r2, run `…T025634Z-fc90`) is real, not
  instrumental: its subagents created worktrees under the main checkout's
  `.claude/worktrees/agent-*` and left untracked content behind; the
  Gauntlet-Agent and the deterministic `assert-checkout-clean` agree. It is
  also the **live confirmation of the finding-1 fix**: a composed `fail`
  landed in the journal as `run_completed fail` (seq 375), not as
  `instrument_failure subject_crashed` as it would have on launch 1.
- ***triggering-writing-plans 5/5 vs 0/5 (Δ −1.0)*** — the only cell past
  the pre-registered ≥3/5 bar, and it is at the maximum. Same route on all
  five Opus 5 runs: brainstorming → `Write` a design doc → writing-plans →
  implement. The Gauntlet-Agent passed all five on the AC as worded ("loaded
  the writing-plans skill before writing any implementation code"); the
  deterministic `skill-before-tool superpowers:writing-plans Write` failed
  all five because the design doc is a `Write` that precedes the Skill call.
  Opus 4.8 invokes writing-plans before any write on all five runs. So the
  finding splits: **Opus 5
  reliably front-loads brainstorming on a task Opus 4.8 reads as
  "plan it"** — a genuine behavioral signature (also seen as the Sonnet 5
  over-trigger) — and the scenario's check is stricter than its AC (a
  planning artifact written before the skill is not "implementation code").
  r1 additionally asked a clarifying question against the story's "Do not
  ask me any questions". Neither the AC nor the check was changed; whether
  the check should distinguish design-doc writes from code is Drew's call
  (debts, below).
- *global-tool-mapping-comprehension — uninformative.* All 10 runs passed
  behaviorally, all 10 were invalidated by the platform for running under a
  breached host (below). The scenario is its own contention source, so it
  will stay uninformative in any concurrent campaign until that is fixed.

**H5 (economics) — direction held, magnitude understated.** On the
workhorse SDD cell Opus 5 ran **1.7× the cost, 1.8× the wall time, 2.0× the
tokens** of Opus 4.8 ($2.74 / 11.3 min / 3.03M vs $1.59 / 6.2 min / 1.52M)
against the corpus's 1.5× / 1.6×; both arms came in under the corpus
absolutes ($3.22 / $2.15), which were taken on earlier refs and the plain
route. Sentinel cells all stayed under the $1.50 median on both arms (Opus 5
max: worktree-no-drift at $1.37). Tier-wide, Opus 5 is ~1.5× the cost
(median $0.60 vs $0.41; Σ agent $53.36 vs $35.77) and ~1.8× the tokens
(median 1.75×; Σ 49.1M vs 26.9M). The per-cell token multiplier (Opus 5 /
Opus 4.8 medians) runs from 0.7× on cost-checkbox (where Opus 5's passes
are the short runs) through 1.1–1.8× on most cells, 2.0× on sdd-breaker,
2.1× on code-review-pushback, 2.7× on worktree-creation, 3.1× on
triggering-tdd, to 3.9× on triggering-writing-plans (the brainstorming
detour).

### Signature sketch (exploratory — not a gate)

On superpowers v6.3.0 Opus 5 is behaviorally indistinguishable from Opus
4.8 on 11 of the 13 cheap sentinel cells and on the SDD workhorse; it
breaks one-directionally in two places, in opposite directions: it
*sometimes resists* the cost-checkbox over-trigger where 4.8 never does,
and it *always front-loads brainstorming* on the writing-plans prompt
where 4.8 never does. It pays ~1.5× the money and ~1.8× the tokens for the
same outcomes. Nothing here is a regression on main.

## What the campaign found while sealing (platform)

**First live firing of the contention path — sensor correct, scenario is
the culprit, no reserves to spend.** `contention-telemetry.jsonl` (607 samples, 27 in breach, all
`load1_per_core`) shows one breach window 03:50:33–03:53:13Z (load1 peak
24.98 on 8 cores = 3.1/core against the 2.0 threshold; `sustain_k 3`,
`cadence_ms 10000`) and a second 03:55:34–03:57:04Z. Cause, found by
process listing during
the window: the global-tool-mapping-comprehension subjects run a
root-anchored Glob — Claude Code's Glob tool execs its bundled `bfs`
(`bfs -S dfs -regextype findutils-default / -path *using-superpowers* -name
*-tools.md`) — each pinning 160–230% CPU for 30 s+, and the dispatcher
runs the cell's blocks contemporaneously (`global_run_cap 8`; 5–6 live
subjects in the polls). The leader did what D3 says:
breach entry → admission halted → in-flight blocks ran to service end →
`contention resolution: affected=3 refilled=0 exhausted=3 suppressed=0` →
admission resumed → second breach → 2 more exhausted at seal; 5
`reserve_exhausted` + 5 `contention_invalidated` adjudications, the cell
reported at denominator 0. Three things to take from it: (1) the sampler,
`evaluateContention`, `resolveClosedWindow`, and the resolution batch work
end to end on a real host; (2) an *exploratory* suite carries **zero
reserve blocks** (68/68 primary), so `refilled=0` is structural — the
platform can only invalidate, never repair, in this profile; (3) the report
lists a denominator-0 cell in neither `failed_cells` nor a `cannot_answer`
list — it is only visible by reading `coverage 0` in the table.

**Report rendering nits:** `delta` prints raw floats
(`0.19999999999999996` on worktree-no-drift; medians `usd
0.6906650000000001`); Provenance lists the unused `d4a_live_*` arms with
`observed []` (known); no per-arm tallies (the extractor above exists
because of this — D4b candidate).

## Debts surfaced (not started; need Drew's word)

- `triggering-writing-plans`: check `skill-before-tool superpowers:writing-plans
  Write` is stricter than the AC — a design-doc `Write` before the Skill
  counts as a fail. Decide whether the AC or the check is the intent.
- `global-tool-mapping-comprehension`: the subject's root-anchored Glob trips
  the host contention sensor whenever the cell runs concurrently; the cell
  is uninformative in any campaign until the fixture or the sensor's
  scoping changes.
- Exploratory suites have no reserves; contention can only invalidate.
- Report: denominator-0 cells absent from `failed_cells`/`cannot_answer`;
  float rendering; per-arm tallies; Provenance lists all arms.
- Campaigns do not honor story `status: draft`.
- Finding 2's fix (`880db97`) has no live confirmation (D3 item 3 wants a
  cancel on the fixed platform); the sibling appliance
  `interruptHostProcessGroup` hole is still suspected, unverified.
- Container image: root-owned `$BUN_INSTALL/install/cache`.
- Operational: SSM reconcile of the hand-rotated blessed Anthropic key;
  rotate the key that printed into tool output; estimates rebuild before
  2026-09-08 (R-REG-21).
