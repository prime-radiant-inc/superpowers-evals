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
3. codex handles fix rounds through a sanctioned route — native resume if
   the harness supports it, else the specified (never-yet-run) fallback.
4. Core redesign mechanics nobody has probed — round-4 escalation to a
   more capable model, findings-scoped re-review — actually happen.

**Merge-supporting iff:** replication core reproduces the author's GREEN at
≥2/3 per cell with zero unsanctioned-mechanism fails; codex handles fix
rounds via a sanctioned route — native resume if the harness supports it,
else the specified fallback — with *which route* a measured outcome (a
capability precheck determines the expected one); regression/interaction
divergences dissolve under reps or pre-exist on dev (the #1943-panel
standard); new probes pass *or* are defeated by designed skill behavior
(documented, like the author's 5a–5c defeats).

**Known observability limit (stated up front):** every seeded-restart
fixture kills the live implementer, so the skill's fallback clause
legitimately fires — rounds 1–3 *live resume* cannot be forced by any
seeded scenario. The campaign therefore instruments for it organically: a
pre-registered transcript sweep (below) classifies every treatment-arm fix
cycle in blocks 4–6, where the planted-defect scenario is the most likely
organic source (the author's only resume evidence arose there). Zero
organic resume observations is reported as an evidence gap, not silently
absorbed into "merge-supporting."

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
| 0 Scenario audit | Hostile read of the 3 new scenarios' checks/fixtures for false-pass holes (incl. non-ASCII literal traps, e.g. the em-dash in the `parked —` ledger greps that a compliant ASCII-writing agent would fail); fix before running | — | 0 |
| 1 Replication core | 3 new scenarios × 2 arms: claude n=3 all; codex n=3 on the 2 unpinned breakers | 18 + 12 | 30 |
| 2 Coin-flip base rate | +4 claude dev-arm reps of `sdd-fix-loop-resumes-implementer` (→ n=7 dev-arm with block 1) | 4 | 4 |
| 3 Codex fix-route | Route-extend the pinned scenario to sanction every sanctioned codex route (native resume if supported, else the fallback); codex treat n=3 / control n=2. Gated on the capability precheck (below) | 5 | 5 |
| 4 Regression (author's 4) | PR arm: claude n=1 each except planted-defect n=3 (noisy); codex n=1 each; a fail triggers a contemporaneous *paired* re-run (both arms, same window, n=2) | 10 | 10 (+4 gated) |
| 5 Interaction | #1943 pair (`sdd-same-plan-resume`, `sdd-stale-foreign-workspace`) 2 × 2 arms × 2 agents, n=1 — differential **per cell** against the 1943-validation dev profiles (stale-foreign on dev: claude ✗ / codex ✓ — a codex ✗ on the PR arm is a candidate regression, not expected noise); `sdd-spec-context-consumed` claude n=3 × 2 arms (demonstrated noisy); `user-pref-sdd-no-strategy-prompt` codex-only, both arms n=1 (claude fails both refs — known scenario debt); `mid-conversation-skill-invocation` claude PR n=1 | 8+6+2+1 | 17 |
| 6 End-to-end | `sdd-go-fractals-opus48` (claude) + `sdd-go-fractals-gpt55` (codex), PR arm n=1; fails trigger contemporaneous paired re-runs as in block 4. Fractals over svelte to dodge the vite-orphan wedge | 2 | 2 (+2 gated) |
| 7 New hostile probes | (a) round-4 escalation integrity; (b) scoped re-review discipline; (c) final-review single-fix-wave; claude treat n=2 + control n=1 each for (a)/(b); (c) treat n=2 + control n=2 (dev lacks the rule entirely — control shows the scenario discriminates) | 6+4 | 10 |

**Totals:** ≈78 measured runs + ≤8 triage-gated contingency ≈ $260–380.

## Measurement protocols

- **Block 2 — mechanism classification (pre-registered):** scenario
  verdicts are outcome-gated and do *not* measure mechanism. Every dev-arm
  run of `sdd-fix-loop-resumes-implementer` (n=7) gets a transcript read
  classifying it: {resumed implementer, fresh/dedicated fix dispatch,
  pre-flight defused, other}. Criterion: the coin-flip claim is
  *supported* if ≥2 distinct mechanisms are each observed ≥2× among runs
  that entered a fix cycle; if <4 runs enter a fix cycle, the block is
  reported as underpowered — not adjudicated either way.
- **Blocks 4–6 — resume sweep (pre-registered):** every treatment-arm
  transcript is swept for organic fix cycles; each is classified with the
  block-2 taxonomy. Organic rounds 1–3 resumes are the only obtainable
  live-resume evidence (see observability limit above).
- **Codex capability precheck (before block 3):** establish whether codex
  can send a follow-up message to a live spawned agent (docs + a cheap
  local probe, not an appliance run). Outcome sets block 3's expected
  route; the route actually taken is read from each transcript.
- **Triage-triggered pairing:** blocks 4–6 run controls only on a fail,
  but never as a lone late-window control — a fail triggers a fresh
  *contemporaneous pair* (treatment + control submitted together), which
  is what the nonstationarity doctrine permits.

## New scenario work

Three authored artifacts. Iteration happens **locally in the claude-slim
container**; every measured run is **100% on the appliance**.

1. **Route-list extension** of `sdd-fix-loop-resumes-implementer` (its
   pinning comment already anticipates this): sanction every route the
   skill itself sanctions for codex — native resume if the capability
   precheck shows it exists, else the specified fallback (fresh dispatch
   carrying brief + report + findings); unsanctioned mechanisms (fresh
   fix-only dispatch, controller self-edit, gap shipping) stay hard-fails.
   Unpin codex.
2. **Probe (a) — round-4 escalation integrity:** fixture seeded mid-loop
   with the ledger's last line a completed fix round 3/5 with open
   findings, and the stuck implementer's model tier recorded in the
   ledger/brief as a *cheap tier* — escalation is specified relative to
   the stuck implementer ("at least one tier above the implementer that
   got stuck"), so seeding a cheap tier makes "more capable model" fully
   checkable regardless of the session's own model. Checks: round 4
   dispatches a *fresh* implementer on a higher tier than the seeded one;
   the ledger records the round transition.
3. **Probe (b) — scoped re-review discipline:** the ledger has no
   representation for "post-fix awaiting re-review" (round lines are
   appended only after fix + re-review complete), so that state cannot be
   seeded. Instead: seed a mid-loop state (last line `fix round R/5`, open
   findings) and observe the *entire next round* — gate on the re-review
   dispatch being findings-scoped (re-review-prompt shape), not a fresh
   full review.
4. **Probe (c) — final-review single-fix-wave:** fixture seeded with all
   tasks complete (some with parked/deferred lines) and the final
   whole-branch review pending with findings. Gates: ONE fix dispatch for
   all findings, exactly one scoped re-review, residuals adjudicated
   breaker-style (park with ruling or BLOCKED) — "There is no second fix
   wave" is specified, merge-critical, and covered nowhere else.

All probes reuse the seeded-ledger resume pattern the author's breaker
scenarios proved out, and all are outcome-gated per the 5d lesson: any
sanctioned route passes; unsanctioned mechanisms fail. Because seeded
restarts kill the live implementer, probes (a)/(b) exercise the fallback
dispatch path by design — live resume is covered only by the blocks 4–6
sweep. Scenario work lands on a branch and is PR'd to evals `main`.

## Execution mechanics and schedule

**Preflight (before any measured run):**

- Appliance doctor/prepare via the installed helper.
- **Grader budget provisioning, not just a check:** the grader
  (`claude-sonnet-5`) bills the shared direct-Anthropic key, and an
  SDD-heavy panel drained it after ~6 gauntlet runs on 2026-07-16. Top the
  key up to ≥2× the campaign's estimated grader spend before wave 1,
  re-check the balance **between every batch**, and size batches so a
  drain voids at most one batch. (PRI-2524, grader-on-Mantle, is the
  durable fix if it lands first.)
- **Bedrock credential probe:** `opus_bedrock` funds ~60% of the runs and
  its account RPM/TPM quota is explicitly unprobed (credentials.yaml
  comment). Verify the token is live and probe quota headroom; if headroom
  allows, raise `max_concurrency` above 2 via evals `main` + appliance
  repo sync — this is the single biggest wall-clock lever.
- Confirm obol prices every model in play (both coding models + grader).

**Two waves:**

- **Wave 1** (no authoring dependency): blocks 1+2+4+5+6 ≈ 63 runs,
  submitted as paired batches in one window; claude and codex lanes run
  concurrently. **Claude is the slow lane**: `opus_bedrock` is capped at
  `max_concurrency: 2` (codex `openai_responses` is 5), and claude carries
  ~46 of the 78 runs. Local scenario authoring for wave 2 proceeds in
  parallel.
- **Wave 2:** blocks 3+7 ≈ 15 runs once the new scenarios pass local
  iteration.
- Contingency re-runs fold into whichever wave surfaces them.

**Schedule honesty:** at the current Bedrock cap of 2, the claude lane
alone is ~20+ serial slots — ≈12–18 h of appliance time for wave 1 at
realistic SDD run durations, i.e. ~2 appliance days, not the burn-rate
figure a parallel claude lane would give. If the preflight quota probe
supports raising the cap to 4–6, wave 1 compresses to ≈6–9 h. The spec
commits to the honest number and treats the cap raise as the optimization,
not the assumption. The single-job lock constrains batch submission, not
throughput — submit waves as large batches, don't dribble blocks.

The draft-status #1943 pair runs by explicit scenario name (excluded from
run-all). The block-6 end-to-end builds run as individual jobs with a
post-run process-tree check (vite-orphan wedge mitigation, even though
fractals is the chosen fixture). Judge-stall / `investigate` verdicts are
not observations — re-run and log the stall.

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

**Contingencies:** #1943 merges mid-campaign → **control stays at the
campaign-start pre-#1943 pin** (re-pinning control to a dev tip containing
#1943 while treatment lacks it would make the arms differ by two skill
changes — both touch the ledger machinery); the merge is noted in the log
as an external-validity caveat only. PR #1998 force-push → stop, re-pin,
restart affected blocks only.
