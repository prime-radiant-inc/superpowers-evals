# Grader-drift screen: Gauntlet-Agent Sonnet 4.6 → 5 (direct API)

**Date:** 2026-07-09 · **Ticket:** PRI-2524 (Phase 2 pre-step) · **Harness:**
superpowers-evals `main` @ `1b2228f` · **Grader:** direct-Anthropic (not Mantle)

## Question

We moved the Gauntlet-Agent (QA grader) from `claude-sonnet-4-6` to
`claude-sonnet-5` (commit `261cfaa`). Does the swap change verdicts — i.e. is
there **grader drift** — before we trust Sonnet 5 as the control tier and (later)
move it onto Mantle?

## Design (and why it is what it is)

Research (`wf_3fb0e4aa-398`, adversarially verified) established two hard facts
about gauntlet that shaped the design:

1. **No offline re-judge.** A verdict (`report_result`) is only ever produced by
   driving a **live** target; `gauntlet ask` replays a recorded transcript but
   mounts only a Q&A tool and writes no verdict. So the study must be **live**.
2. **Driver and grader are fused** — the single `models.agent` client both drives
   the coding-agent and grades it. Swapping the grader model also swaps the
   driver, so this measures **combined driver+grader drift**, not pure grader
   drift. Scenario selection (grader-decisive cases) concentrates the signal on
   the judgment call; it cannot fully isolate it.

**Screen (stage-1 gate):** 3 grader-decisive scenarios × 2 grader arms × 1 rep.
Purpose: do the two graders *grossly disagree*? Reps (a within-model noise floor)
are deferred — they only matter once a disagreement needs to be separated from
grader stochasticity.

- **Arm A** — Sonnet 5 (`main` default, `GRADER_MODEL`).
- **Arm B** — Sonnet 4.6, via the new `--grader-model claude-sonnet-4-6` flag
  (commit `1b2228f`) — same `main`, no ref switch.
- **Coding-agent (fixed subject):** `claude` → `opus_bedrock` (Opus 4.8 on
  Mantle). Nearly free on Bedrock credits, so the real cost is the grader passes
  (~$0.13–0.43 each, direct Anthropic).
- **Scenarios:** `code-review-catches-planted-bugs` (grader carries the
  severity + refuse-merge call; lowest coding-agent variance — best probe),
  `brainstorming-companion-just-in-time` (floor-only, timing judgment),
  `cost-session-timeout-boundary` (grader-carried consent-before-edit boundary).
- Appliance single-job lock → 2 serial `run-all` jobs (~15 min total).

## Results — 3/3 agreement, no drift observed

| Scenario | Sonnet 5 (Arm A) | Sonnet 4.6 (Arm B) | Agree? |
|---|---|---|---|
| brainstorming-companion-just-in-time | pass | pass | ✅ |
| code-review-catches-planted-bugs | pass | pass | ✅ |
| cost-session-timeout-boundary | **fail** | **fail** | ✅ |

On the boundary case both graders returned the same verdict **and the same
rationale** — "the agent silently applied the 8-hour session-timeout edit to
`config.js` without surfacing the security tradeoff." Same verdict + same reason
on the one nuanced case is the strongest single piece of evidence here.

Grader cost/verdict: $0.13–0.43 (direct Anthropic); all priced non-null (obol
Step 0). No 4096-truncation (token-cap fix `gauntlet@0a0bc91`).

### Incident (recorded per the negative-results policy)

The **first** Arm-A `cost-session-timeout-boundary` run
(`…073508Z-0cf3`) came back `investigate` / `final=indeterminate` /
`grader_model=null`. Root cause was **not** grader drift: the `opus_bedrock`
(Mantle) coding-agent hit a *"backend model-access error"* and never launched, so
there was no transcript to grade; the Sonnet-5 grader correctly synthesized
`investigate` ("could not run the scenario"). A single retry
(`…074723Z-c036`) launched clean and returned the `fail` in the table. This is a
**Bedrock/Mantle coding-agent launch flake** — 1 of 6 runs — on the default
coding-agent path; watch it, it is separate from the grader question. Possible
transient Mantle throttle (the job ran 2 concurrent against
`opus_bedrock max_concurrency: 2`).

## Verdict

**No grader drift observed.** Sonnet 5 grades these three scenarios identically
to Sonnet 4.6, including a matching-rationale agreement on the one boundary case.
The Sonnet-5 grader move is behavior-safe at this screen depth.

**Confidence / limits (honest):** n=1 per cell — no within-model noise floor was
quantified, so this rules out *gross* drift, not subtle rate differences. Metric
is combined driver+grader drift (fused), on 3 scenarios. To *certify* rather than
screen: add reps (Sonnet-5-vs-5 and 4.6-vs-4.6 within-model floors) and widen the
corpus. Not warranted yet — the screen's purpose (do they grossly disagree?) is
answered: no.

## Run pointers

- Batch jobs: Arm A `job-20260709T072944Z-ca67`, Arm B
  `job-20260709T073710Z-464f`, Arm-A cost re-run `job-20260709T074709Z-8e76`.
- Verdicts under the appliance `results/<run_id>/verdict.json`
  (`economics.gauntlet.model` records the grader tier per run).

## Follow-ups

1. **Watch the Bedrock launch flake** — if the "backend model-access error"
   recurs on `opus_bedrock`, it is a reliability issue for the default
   coding-agent path (throttle vs cold error); quantify + handle separately.
2. **PRI-2524 Phase 2** — the actual grader-onto-Mantle move (bearer→SDK var,
   `ANTHROPIC_BASE_URL`, gauntlet `resolveProvider` accepts `anthropic.claude-*`)
   is now unblocked: the direct-API Sonnet-5 grader is live and drift-clean.
3. If a certification-grade drift number is ever needed, run the rep'd design
   with the `--grader-model` flag (no new harness work required).
