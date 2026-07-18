# PR #1998 reply draft (for review — not posted)

Draft GitHub comment answering the maintainer's eval ask on
`obra/superpowers#1998`. Not posted anywhere; for Drew's review before it
goes out. Sourced entirely from
`docs/experiments/2026-07-17-pr1998-fix-loop-validation.md` (PRI-2650) —
every number and run id below traces back to that log's tables, Triage
(Task 8), and Contingency wave sections.

---

Ran an independent replicate-and-extend eval campaign against this PR —
separate scenarios/session from the author-run campaign
(`docs/experiments/2026-07-sdd-fix-loop-redesign.md`), same repo's Quorum
harness. Design doc:
`docs/superpowers/specs/2026-07-16-pr1998-eval-campaign-design.md`. Full
log with every run id, triage, and contingency wave:
`docs/experiments/2026-07-17-pr1998-fix-loop-validation.md` (PRI-2650).
Config: treatment = PR head `1f97eda`, control = `dev` tip `fb7b0708`;
claude (opus, Bedrock) and codex (gpt-5.5, openai_responses) as coding
agents under test, claude-sonnet-5 as grader.

93 measured runs on the appliance (+ 4 non-measured local-iteration runs
per this repo's "local runs never count" convention). Four claims,
independently tested per a pre-registered decision rule:

**1. Breaker/park/BLOCKED behaviors hold (GREEN replication) — SUPPORTED.**
`sdd-breaker-adjudicates-at-cap` is a perfect RED/GREEN split on both
agents: dev 0/6 pass, PR 6/6 pass. `sdd-breaker-structural-blocks` is
noisier — pooled across the original n=3/arm and a follow-up n=5/arm
confirmation batch (13 claude runs total), Treatment 5/8 pass vs. Control
7/8 pass. That's a differential null, not a regression: the sharp n=3
asymmetry that triggered the confirmation batch dissolved once n reached
8. Codex fails this scenario identically in both arms (3/3 T, 3/3 C) —
pre-existing, orthogonal to the PR.

**2. dev genuinely exhibits the motivating defects (RED replication) —
PARTIALLY SUPPORTED.** The cap-adjudication RED reproduces strongly (dev
0/6, above). The structural-blocks RED does **not** reproduce — dev
majority-passes at n=8 (7/8), contradicting the motivating narrative for
that scenario. The coin-flip mechanism-split claim is formally
**underpowered**: only 2 of 7 dev-arm `sdd-fix-loop-resumes-implementer`
runs entered a fix cycle at all, against a pre-registered ≥4-entrant power
floor. Both of those 2 entrants did land on the same mechanism (fresh
dispatch, not resumed implementer) — weakly consistent with the claim —
but n=2 doesn't clear the bar to call it either way.

**3. codex handles fix rounds through a sanctioned route — SUPPORTED,
decisively.** codex's native `send_input` resume-a-live-agent primitive is
real, and this campaign confirms it's genuinely *consumed*, not just
accepted: one treatment run's implementer returned
`DONE_WITH_CONCERNS`, the controller `send_input`'d a ruling to the same
agent id, and it resumed and returned `DONE` with a new commit. Across all
5 codex fix-route runs: native resume ×2, pre-flight defused ×3, **0/5**
unsanctioned fresh-findings-only dispatch. The specified fallback route
was never exercised — resume/defuse always sufficed in this sample.

**4. New redesign mechanics actually happen — SUPPORTED.** Round-4
escalation-integrity probe: treatment 2/2 pass, control 0/2 (after a
protocol re-run to clear an indeterminate). Scoped re-review probe:
treatment 2/2 pass (after fixing a check bug — see negative results
below), control 0/2. Final-review single-fix-wave probe: treatment 2/2
pass, control 1/2 — partial, not clean, discrimination (see below). A
21-transcript organic-resume sweep across the regression/interaction/
end-to-end blocks found 9/21 treatment runs entering an organic fix cycle,
11 of 12 fix-cycle events using resumed-implementer — including one codex
run with two consecutive live `send_input` resumes of the same agent
across fix rounds 1→2. This mechanic is really firing, not just passing
seeded fixtures.

**Regressions: none confirmed.** One watch item, not a blocker:
`sdd-quality-reviewer-catches-planted-defect` on codex read 0/2 treatment
vs. 1/1 control — below the confirmation threshold this scenario family
is independently known to be noisy at n=1 (per the #1943 panel), and
nothing in this PR's diff touches per-task reviewer dispatch. Recommend a
post-merge follow-up rep rather than treating it as a merge blocker.

**Negative results, equal billing:**
- Structural-blocks RED did not reproduce on dev at n=8 (claim 2, above).
- The coin-flip mechanism-split claim is underpowered at the pre-registered
  threshold (2 of 7 dev runs entered a fix cycle; need ≥4) — not
  adjudicated, not confirmed.
- The final-review single-fix-wave probe only partially discriminates:
  dev's SKILL.md already carries the "one fix subagent, not per-finding"
  half of the AC near-verbatim, so that half isn't genuinely new PR
  behavior. Recommend re-scoping that story.md AC to isolate the actually
  novel "no second fix wave" sub-clause.
- Two deterministic-check fragility bugs, found and fixed mid-campaign,
  not scenario or skill regressions: a `tool-arg-match` literal in
  `sdd-re-review-scoped/checks.sh` broke on markdown-wrapped numerals/
  function names in the real dispatch text (fixed twice — commits
  `f7c3820` and the probe-b re-score); both were check bugs in scenarios
  this campaign itself wrote, not defects in the PR under test.

**Economics:** 93 measured appliance runs, $273.20 total — inside this
campaign's own pre-registered $270–390 estimate, low end. Full per-block
breakdown in the log.

**Bottom line: merge-supporting.** The redesign's own claimed behaviors —
breaker/park/BLOCKED discipline, codex's sanctioned resume route, round-4
escalation, scoped re-review, single-fix-wave discipline, and organic
resume actually firing across two coding agents — all check out against
independent scenarios and an independent session. The honest caveat: two
of the three RED claims about *how bad dev's current behavior is*
(structural-blocks base rate, the coin-flip split) didn't reproduce at the
n this campaign reached. That doesn't undercut the fix — it means the
severity argument in the PR description is less airtight than the fix
itself.
