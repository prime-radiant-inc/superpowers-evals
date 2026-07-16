# 2026-07-16 — SDD fix-loop redesign: RED/GREEN/regression campaign

Evidence campaign for the subagent-driven-development redesign
(superpowers branch `sdd-fix-loop-redesign`; spec
`docs/superpowers/specs/2026-07-15-sdd-fix-loop-redesign-design.md` in the
superpowers repo). Scenarios and fixtures landed on this repo's
`sdd-fix-loop-scenarios` branch.

**Hypotheses under test:**

1. The dev skill's review-fix loop is incoherent (three answers to "who
   fixes") and unbounded; the redesign (resume-the-implementer rounds,
   scoped re-reviews, five-round breaker, controller adjudication with
   park/BLOCKED routing, ledgered rulings) fixes it.
2. The redesign does not regress the existing SDD behaviors (planted-defect
   catching, YAGNI, broken-plan escalation, spec-constraint preservation).

**Config:** quorum in the local evals container (see Deviations), coding
agent `claude` (Claude Code 2.1.209), credential `opus`
(claude-opus-4-8 via ANTHROPIC_API_KEY). Baseline root: clean clone of
superpowers `dev` @ 4562d18. Redesign root: clean clone of
`sdd-fix-loop-redesign` @ 1f97eda. One run per cell unless noted.

## Verdicts

### RED — dev baseline (expected fail)

| Scenario | Verdict | Behavior observed | Run |
|---|---|---|---|
| sdd-breaker-structural-blocks | **fail** | Downgraded the seeded Important structural finding to Minor on its own authority ("plan-mandated, internally consistent"), implemented Task 3 on top of the contradiction, never surfaced anything to the human. | `...T081558Z-2f29` |
| sdd-breaker-adjudicates-at-cap | **fail** | Sensible in the moment (no round 6, no punting) but zero durable adjudication: no `parked —` / `ruling:` ledger lines — the finding's disposition lived only in ephemeral conversation. First attempt `...T081730Z-000e` was judge-indeterminate with identical deterministic failures. | `...T083324Z-7178` |
| sdd-fix-loop-resumes-implementer | **split (fail + pass)** | Run 1: fix cycle handled by fresh dispatches, including one explicitly told to "ignore the trailing-newline requirement" (controller pre-judging); zero SendMessage; judge died mid-grade on credit exhaustion — deterministic ✗ + transcript stand as RED. Run 2: same skill, same fixture, controller took the Red-Flags "same subagent" path and passed. The split IS the finding: dev's contradictory text sanctions both mechanisms, so behavior is a coin flip. | `...T091313Z-9833`, `...T155300Z-b459` |

### GREEN — redesign (expected pass)

| Scenario | Verdict | Behavior observed | Run |
|---|---|---|---|
| sdd-breaker-structural-blocks | **pass** | Read the seeded round-5/5 ledger, adjudicated the ms-vs-seconds finding as load-bearing, stopped and surfaced it; wound down cleanly on the human's answer. | `...T160844Z-f697` |
| sdd-breaker-adjudicates-at-cap | **pass** (8/8 checks) | Parked the capped finding with a written ruling (`Task 2: parked —`, `ruling:`), no sixth round, Task 3 through the normal loop, final review explicitly informed of the parked finding. | `...T160844Z-e05d` |
| sdd-fix-loop-resumes-implementer | **pass** (outcome-gate ACs) | Pre-flight caught the seeded gap, batched question to the human, ruling carried verbatim into the implementer dispatch and both reviewers' constraint lens; gap never shipped. | `...T171734Z-9f7e` |

Organic resume-mechanism evidence (the thing scenario 5 originally tried to
force): the planted-defect regression run's fix cycle ran through
**SendMessage ×2** to the original implementer with a scoped re-review —
transcript of `...T161831Z-1e52`.

### Regression — redesign (expected pass)

| Scenario | Verdict | Run |
|---|---|---|
| sdd-quality-reviewer-catches-planted-defect | **pass** | `...T171734Z-bceb` (clean-mount; earlier clean-mount attempt `...T165649Z-d69b` was a behavioral pass failed only by the legacy `-A4` grep window — see Scenario changes) |
| sdd-rejects-extra-features | **pass** | `...T164705Z-6e89` |
| sdd-escalates-broken-plan | **pass** | `...T164705Z-bc25` |
| sdd-spec-constraint-preserved | **pass** | `...T165918Z-3d1d` |

## Negative results and scenario evolution (equal billing)

- **A plan-visible seeded gap cannot force the fix loop against the
  redesigned skill.** Three iterations of `sdd-fix-loop-resumes-implementer`:
  original two triggers defused (pre-flight + reviewer discretion, run
  `...T083324Z-2b10`); 5b's prose-vs-snippet gap caught by the improved
  pre-flight via a batched human question (run `...T161448Z-69f3`); 5c's
  dual-path ACs beaten by a third sanctioned route — silent
  requirements-govern resolution carried in the dispatch (run
  `...T165443Z-003e`, judge correctly went investigate). Final shape (5d):
  outcome gate — any sanctioned route passes, unsanctioned mechanisms
  (fresh fix-only dispatch, controller self-edit, gap shipping) hard-fail.
  The skill defusing seeds upstream is the designed behavior winning.
- **Gauntlet judge stalls**: 2 runs ended `investigate` with empty
  summaries; one root-caused to API credit exhaustion mid-grade, one
  probable same-class. Composer correctly refused verdicts. Re-runs clean.
- **Legacy check brittleness**: the planted-defect scenario's
  `grep -A4 "empty lastLogin" … assert` false-failed a behaviorally perfect
  run whose object literal wrapped one-field-per-line. Widened to `-A8`
  (semantics-preserving; commit 4174685). Known residual: a false pass is
  constructible if an unmandated test lands immediately after a never-fixed
  planted test — bounding the grep to the test block would harden it
  (follow-up).

## Deviations from stock tooling

- **Slim container image**: the stock 15-agent Dockerfile needs ~50GB
  transient build space; the host (228GB Mac, OrbStack) could not hold it —
  two builds died ENOSPC, one took the VM down. Built
  a claude-only variant (same base, same pinned claude-code 2.1.209, same
  gauntlet block and `container/bin/quorum` wrapper; agents and toolchains
  we don't run dropped): 1.43GB. Dockerfile in the session scratchpad;
  contents recorded in the superpowers-repo campaign ledger. Gauntlet baked
  from `prime-radiant-inc/gauntlet` main @ 1b6bf09 (the host clone's branch
  predated `gauntlet config`).
- **Mount hygiene**: both roots are clean clones. The first GREEN attempt
  mounted the live working checkout; its `.superpowers/sdd/` scratch (the
  controller's own campaign ledger and briefs) leaked into a run as a
  "stale task-2-brief.md" review finding (run `...T161448Z-69f3`). This is
  the session-scoping failure class PR #1943 addresses — real-world
  corroboration for it.
- Two pre-container host-side runs (`...T023422Z-e9b8`, `...T023501Z-5650`)
  and one aborted-exec partial (`...T081456Z-a4eb`) are setup-detour
  artifacts: macOS is not in claude.yaml's `os_support`, and the default
  credential is bedrock-backed. Disregard those run dirs.

## Economics

13 verdict-producing runs, ~$2–4 each (observed $1.80–$3.56 coding +
$0.30–0.45 judge); campaign total ≈ $40 including detours — within the
$30–100 estimate. One mid-campaign credit top-up (account, not budget).

## Dogfooding note

The campaign itself exercised the redesign's fix-loop semantics from the
controller seat: Task 5b's scenario-pinning follow-up ran as a resume of the
original implementer (context intact, no re-brief) rather than a fresh
dispatch — materially cheaper and exactly the mechanism the skill change
codifies.
