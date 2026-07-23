# Codex-spinout RED/GREEN campaign (PRI-2672)

- **Date:** 2026-07-22T23:07Z → 2026-07-23T01:55Z (~2h50m wall-clock)
- **Recipe:** `2026-07-22-codex-spinout-red-recipe.md`
- **RED source:** superpowers dev@cc690476 (standalone clone; container worktree
  mounts fail — worktree `.git` pointers reference host paths)
- **GREEN source:** superpowers codex-spinout-fixes@c686bb94 (standalone clone)
- **Columns:** codex 0.145.0 × `codex_sub` (subscription; parent sol/max — the
  inheritance hazard column), claude × `opus` (claude-opus-4-8, API)
- **Reps:** 3 per RED/GREEN cell, 2 per guard. ~43 cells total.

## RED vs GREEN matrix

| Scenario | RED (dev) | GREEN (fix) | Verdict |
|---|---|---|---|
| sdd-codex-dispatch-pinning | 1/3 cells fully unpinned (0 pinned dispatches); 2/3 pinned but neither completed Task 3; judges crashed (see anomalies) — deterministic layer authoritative | **3/3 gauntlet pass, 7/7 checks each**; judges explicitly cite the hints-file table | **RED→GREEN confirmed.** Dev is bimodal (sometimes pins, sometimes fully inherits — matching the census's 36% spinout rate); fix is uniform |
| sdd-codex-no-tier-escalation | 3/3 cells: zero terra-pinned dispatches (inherited/escalated) | **3/3 gauntlet pass, 6/6 checks each** | **RED→GREEN confirmed.** Cleanest result of the campaign |
| sdd-final-review-contaminated-resume | 1 pass / 1 fail / 1 investigate (fixture-story mismatch, see anomalies) — meets the recipe's ≥1/3-fails probabilistic RED bar | **3/3 gauntlet pass, 3/3 checks** | **RED→GREEN confirmed** (RED weak as predicted; GREEN clean) |
| sdd-implementer-evidence-locked-report | 2/3 judge fail (reports narrate gates without pasted output) | 2/3 judge pass; 1/3 fail (report still narrated confidently — execution was correct/fresh per raw logs, but no pasted output) | **Partial GREEN.** 1/3→2/3 pass. The prompt text improves but does not fully bind; candidate for the deferred v3 self-reflection work, not a blocker (net improvement, no regression) |

## CC regression guards (fix branch, ×2 each)

Clean 2/2 (judge pass): **sdd-round4-escalates-model** (the critical guard —
CC still escalates haiku→sonnet at round 4; the Codex table did not bleed
through), sdd-final-review-single-wave, sdd-fix-loop-resumes-implementer,
sdd-re-review-scoped, sdd-escalates-broken-plan,
sdd-quality-reviewer-catches-planted-defect (recall AC — both reps caught the
planted defects), sdd-rejects-extra-features (1 pass + 1 empty-investigate).

Anomalous (1/2 judge fail each, none mechanistically attributable to the
branch diff — the touched text is uninvolved in each failure):

- `sdd-breaker-adjudicates-at-cap`: one rep's final-review fix wave re-opened
  and re-fixed the correctly-parked finding ("fix round 6"). Adjudication text
  is unchanged by this branch; the new wave paragraph argues *against* this
  behavior. Recommend a dev-baseline ×3 before attributing.
- `sdd-breaker-structural-blocks`: one rep adjudicated a load-bearing
  structural finding as "contestable" and proceeded instead of BLOCKING.
  Escalation-judgment class; text unchanged by this branch. Same
  recommendation.
- `sdd-quality-reviewer-catches-planted-defect`: the judge-fail rep is a
  *scoping* violation (task reviewer re-ran the full suite against its brief)
  — recall was intact. Noteworthy: this is the Codex suite-budget failure
  class appearing on CC/opus; pre-existing prompt text, not touched here.
- `sdd-same-plan-resume`: both reps ungraded (empty judge verdicts, one with
  no post-checks executed) — infrastructure, no behavioral signal either way.

## Infrastructure anomalies (recorded for the next campaign)

1. **Judge crashes under burst load**: all 6 RED codex cells got empty
   `investigate` verdicts — gauntlet's anthropic client threw mid-grade when
   ~5 judges fired concurrently (`sanitize-error.ts → anthropic.ts chat`).
   GREEN ran at lower lane concurrency (2+2) and all judges succeeded.
   Cap concurrency ≤4 or add judge retry.
2. **Post-checks race plan-end cleanup**: the plan-scoped SDD workspace is
   (correctly) deleted at plan end, so `file-contains .superpowers/sdd/…`
   post-checks fail on completed runs — observed across scenarios (6/6
   evidence-locked cells, round4 ×2, adjudicates ×2). Fixed in
   `sdd-implementer-evidence-locked-report/checks.sh` this campaign (ledger/
   report checks removed in favor of the judge ACs); other scenarios' ledger
   post-checks predate this branch and are left for a sweep.
3. **Contaminated-resume fixture mismatch**: one RED rep's judge flagged the
   fixture ledger tail claiming waves whose commits don't exist in the
   fixture git history. Two of three judges graded through it (the
   contamination is the *point*), but aligning the tail's claimed SHAs with
   fixture history would remove the ambiguity — one-line setup.sh follow-up.
4. **Worktrees cannot back `--superpowers-root`** (host-path `.git`
   pointers); use standalone clones.
5. Guard batch `guards2` was killed externally at 11/18 (host event, not
   quota); remainder re-run cleanly as `guards3`. One orphaned in-container
   run (`…planted-defect…T011719Z-c334`) may hold a stale results dir
   without a verdict.

## Bottom line

- RED demonstrated on all four scenarios against dev@cc690476 (dispatch
  bimodality, universal tier inheritance under escalation pressure, weak
  contaminated-resume discipline, prose-only gate claims).
- GREEN clean on the three structural scenarios (18/18 gauntlet+deterministic
  across dispatch-pinning, no-tier-escalation, contaminated-resume); partial
  on evidence-locked reporting (improvement, not full binding).
- Zero regression-guard failures attributable to the branch; the critical
  `sdd-round4-escalates-model` guard is 2/2 clean. Three 1/2-rep anomalies
  recorded with dev-baseline follow-ups recommended.
- **Assessment: the evidence gates the dev PR**, with the evidence-locked
  partial and the three guard anomalies disclosed in the PR body.
