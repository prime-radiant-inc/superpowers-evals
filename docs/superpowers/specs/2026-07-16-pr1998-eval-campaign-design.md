# PR #1998 (SDD fix-loop redesign) — independent eval campaign design

**Date:** 2026-07-16
**Subject:** superpowers PR #1998 (`sdd-fix-loop-redesign`, head `1f97eda`, base `dev`)
**Role:** independent replicate-and-extend validation, answering the PR's
direct ask to @arittr. The PR-authoring session already ran a 13-run
RED/GREEN/regression campaign (`docs/experiments/2026-07-sdd-fix-loop-redesign.md`,
evals commit `8192fe2`); this campaign is the independent check on it.

## Why an independent campaign

The author-run campaign is well-documented but not independent evidence:

1. **n=1 per cell** almost everywhere; the headline RED claim ("dev's fix
   mechanism is a coin flip") rests on n=2.
2. **Author-tuned scenarios**: one session wrote the skill change, the
   scenarios (iterating scenario 5 four times until GREEN passed), and the
   grades.
3. **One agent, one model**: claude on direct-API opus 4.8 in a custom slim
   container. The PR *specifies* a fallback for harnesses without subagent
   resume (fresh dispatch carrying brief + report + findings) that was never
   executed; codex is exactly that harness and got zero runs.
4. Adjacent open PR #1943 touches SDD ledger/workspace semantics, and #1998
   specifies exact ledger line formats — untested interaction.

## Objective and decision rule

Four claims get independently tested:

1. The redesign's breaker/park/BLOCKED behaviors hold (GREEN replication).
2. dev genuinely exhibits the motivating defects, including the coin-flip
   mechanism split at a real n (RED replication).
3. The specified-but-never-run no-resume fallback works on codex.
4. Core redesign mechanics nobody has probed — round-4 escalation to a
   more capable model, findings-scoped re-review — actually happen.

**Merge-supporting iff:** replication core reproduces the author's GREEN at
≥2/3 per cell with zero unsanctioned-mechanism fails; the codex fallback
path is exercised (or its absence is documented as a spec-gap finding);
regression/interaction divergences dissolve under reps or pre-exist on dev
(the #1943-panel standard); new probes pass *or* are defeated by designed
skill behavior (documented, like the author's 5a–5c defeats).

If dev's RED does not reproduce at n≥3, that undermines the PR's
motivation, not necessarily its safety — reported honestly either way.
Negative results get equal billing.

## Arms, refs, credentials

- **Control:** superpowers `dev` tip, SHA pinned at campaign start.
- **Treatment:** PR head `1f97eda`, pinned. A force-push mid-campaign stops
  affected blocks and re-pins (noted in the log).
- Arms run **contemporaneously paired** (same batch window). No comparisons
  to the author's numbers or the #1943 panel's — nonstationarity doctrine:
  base rates wander across batches; only within-campaign pairs count.
- **claude:** appliance default credential (`opus_bedrock`).
  **codex:** explicit `--credentials openai_responses` (appliance
  `codex_sub` default has no auth). **Grader:** harness-pinned
  `claude-sonnet-5`.
- Noted deltas from the author's config (direct-API opus, claude-code
  2.1.209, slim local container): acceptable — no claim under test is
  endpoint-sensitive; recorded in the log.

## Run matrix

| Block | What | Cells | ~Runs |
|---|---|---|---|
| 0 Scenario audit | Hostile read of the 3 new scenarios' checks/fixtures for false-pass holes; fix before running | — | 0 |
| 1 Replication core | 3 new scenarios × 2 arms: claude n=3 all; codex n=3 on the 2 unpinned breakers | 18 + 12 | 30 |
| 2 Coin-flip base rate | +4 claude dev-arm reps of `sdd-fix-loop-resumes-implementer` (→ n=7 dev-arm with block 1) | 4 | 4 |
| 3 Codex fallback | Route-extend the pinned scenario to sanction the no-resume fallback; codex treat n=3 / control n=2 | 5 | 5 |
| 4 Regression (author's 4) | PR arm: claude n=1 each except planted-defect n=3 (noisy); codex n=1 each; controls triage-gated | 10 | 10 (+4 gated) |
| 5 Interaction | #1943 pair (`sdd-same-plan-resume`, `sdd-stale-foreign-workspace`) 2 × 2 arms × 2 agents, n=1 — differential framing, fail-leaning everywhere until #1943 merges; `sdd-spec-context-consumed` claude n=3 × 2 arms (demonstrated noisy); `user-pref-sdd-no-strategy-prompt` codex-only, both arms n=1 (claude fails both refs — known scenario debt); `mid-conversation-skill-invocation` claude PR n=1 | 8+6+2+1 | 17 |
| 6 End-to-end | `sdd-go-fractals-opus48` (claude) + `sdd-go-fractals-gpt55` (codex), PR arm n=1; controls gated. Fractals over svelte to dodge the vite-orphan wedge | 2 | 2 (+2 gated) |
| 7 New hostile probes | (a) round-4 escalation integrity; (b) scoped re-review discipline; claude treat n=2 + control n=1 each | 6 | 6 |

**Totals:** ≈74 measured runs + ≤6 triage-gated contingency ≈ $250–350.

## New scenario work

Three authored artifacts. Iteration happens **locally in the claude-slim
container**; every measured run is **100% on the appliance**.

1. **Route-list extension** of `sdd-fix-loop-resumes-implementer` (its
   pinning comment already anticipates this): sanction the no-resume
   fallback route so a compliant codex run can pass; unsanctioned
   mechanisms (fresh fix-only dispatch, controller self-edit, gap shipping)
   stay hard-fails. Unpin codex.
2. **Probe (a) — round-4 escalation integrity:** fixture seeded mid-loop at
   round 3/5 with an open finding. Checks: round 4 dispatches a *fresh*
   implementer on a *more capable model*; the ledger records the round
   transition. Authoring note: read the PR's SKILL.md for the specified
   behavior when the session already runs the most capable available model
   (opus_bedrock may be exactly that case); the ACs must sanction that
   branch rather than fail it.
3. **Probe (b) — scoped re-review discipline:** fixture seeded post-fix
   awaiting re-review. Checks: the re-review dispatch is findings-scoped
   (re-review-prompt shape), not a fresh full review.

Both probes reuse the seeded-ledger resume pattern the author's breaker
scenarios proved out, and both are outcome-gated per the 5d lesson: any
sanctioned route passes; unsanctioned mechanisms fail. Scenario work lands
on a branch and is PR'd to evals `main`.

## Execution mechanics and schedule

**Preflight (before any measured run):** appliance doctor/prepare via the
installed helper; **Anthropic key credit check** (the grader shares it —
exhaustion masks capture failures as indeterminates, bitten twice);
confirm obol prices every model in play (both coding models + grader).

**Two waves:**

- **Wave 1** (no authoring dependency): blocks 1+2+4+5+6 ≈ 63 runs,
  submitted as paired batches in one window; claude and codex lanes run
  concurrently (codex is the slow lane at concurrency 2). Local scenario
  authoring for wave 2 proceeds in parallel.
- **Wave 2:** blocks 3+7 ≈ 11 runs once the new scenarios pass local
  iteration.
- Contingency re-runs fold into whichever wave surfaces them.

Expected appliance run time ≈ 6–9 hours total (anchor: the 36-run #1943
panel; observed burn rate ≈ $200 per 5–8 h); calendar ≈ one day. The
single-job lock constrains batch submission, not throughput — submit waves
as large batches, don't dribble blocks.

The draft-status #1943 pair runs by explicit scenario name (excluded from
run-all). Heavy 90m scenarios run as individual jobs with a post-run
process-tree check (vite-orphan wedge mitigation, even though fractals is
the chosen fixture). Judge-stall / `investigate` verdicts are not
observations — re-run and log the stall.

## Verdict, triage, deliverables

Triage per `docs/superpowers/skills/triaging-a-failing-eval.md`; every
non-pass is attributed (skill defect vs scenario debt vs harness debt vs
judge noise) before counting against the PR. Known-noisy scenarios
(`sdd-quality-reviewer-catches-planted-defect`, `sdd-spec-context-consumed`)
are never read at n=1.

**Deliverables:**

1. Experiment log `docs/experiments/2026-07-16-pr1998-fix-loop-validation.md`
   — hypotheses, pinned SHAs, per-block verdicts, negative results at equal
   billing.
2. Reply on PR #1998 answering the maintainer's eval ask.
3. Scenario/route-extension PR to evals `main`.
4. Memory update (signature files + campaign pointer).

**Contingencies:** #1943 merges mid-campaign → re-pin dev control and note
the boundary; block-5 differentials stay valid either way. PR #1998
force-push → stop, re-pin, restart affected blocks only.
