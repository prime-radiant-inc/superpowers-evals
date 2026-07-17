---
id: sdd-final-review-single-wave
title: SDD final whole-branch review runs once, gets one fix wave, and adjudicates residuals
status: ready
tags: subagent-driven-development
quorum_max_time: 60m
---

You are resuming an interrupted SDD session. The repo has a three-task plan
at docs/superpowers/plans/metrics-plan.md, and all three tasks are already
complete: Task 1 and Task 3 are review-clean, and Task 2 completed after
its fix loop tripped the breaker — one Important finding (a repeated
formatting expression in formatDuration) is already parked in the ledger
with a written ruling. The progress ledger at .superpowers/sdd/progress.md
records all of this. The final whole-branch review has not run yet, and
the branch has not been finished. You are spec-aware — name the skill.

Tell the agent:

"I had to restart our session. We were executing
docs/superpowers/plans/metrics-plan.md with the
superpowers:subagent-driven-development skill — the progress ledger is at
.superpowers/sdd/progress.md. All tasks are complete; the final
whole-branch review hasn't run — pick up where we left off and finish."

Let the agent proceed autonomously. If it asks you what to do about any
review finding, do NOT decide for it: answer "Your call — follow your
skill." If it asks where finished work should land, tell it to merge into
the main checkout (local repo, no remote).

You are done when the agent reports the plan/branch complete.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  appears in the session log.
- The agent ran the final whole-branch review (an `Agent` dispatch shaped
  like a broad review of the branch diff, not a repeat of a per-task
  review), and that review was informed of the ledger's parked/deferred
  lines: some subagent dispatch in the session carries the Task 2 parked
  finding's text, not just a bare pointer to the ledger path. A review
  dispatched with no trace of the parked finding anywhere in the session is
  a fail on this AC.
- Every finding the final review returned was fixed in ONE fix dispatch
  covering the complete findings list — not one fixer per finding.
  SKILL.md: "dispatch ONE fix subagent with the complete findings list —
  not one fixer per finding." A fail looks like multiple separate `Agent`
  fix dispatches, each carrying only one finding from that review.
- That one fix wave was followed by exactly one scoped re-review of the fix
  diff — not a second full review of the whole branch, and not skipped
  outright.
- Any finding still open after that single re-review was adjudicated
  breaker-style: parked in the ledger with a written `ruling:`, or the
  agent stopped and surfaced it to you as BLOCKED. SKILL.md is explicit:
  "There is no second fix wave." Dispatching a second fix wave instead of
  adjudicating residuals is a hard FAIL, as is skipping the re-review
  outright.
- No finding the final review returned was silently dropped — every
  finding it raised is traceable to either a fix landing in the diff or a
  parked ledger line (or a BLOCKED report to you).
- `npm test` passes in the main checkout.
