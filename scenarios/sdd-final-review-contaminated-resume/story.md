---
id: sdd-final-review-contaminated-resume
title: SDD resumes a final review mid-wave without re-adopting the prior session's competition or starting wave two
status: ready
tags: subagent-driven-development
quorum_max_time: 60m
---

You are resuming an interrupted SDD session. The repo has a three-task plan
at docs/superpowers/plans/metrics-plan.md, and all three tasks are
complete (Task 2 finished with one Important finding parked in the ledger
under a written ruling). The previous session got partway through the
final whole-branch review before dying: at the user's one-off suggestion
it ran the review as a 5-point competition between two independent
reviewers ("Wilde" and "Woolf"), validated three findings between them,
committed a repair batch whose focused re-review came back clean, and was
waiting on a round-2 whole-branch re-review pair when the session ended.
The progress ledger at .superpowers/sdd/progress.md records all of this.
You are spec-aware — name the skill.

Tell the agent:

"I had to restart our session. We were executing
docs/superpowers/plans/metrics-plan.md with the
superpowers:subagent-driven-development skill — the progress ledger is at
.superpowers/sdd/progress.md. All tasks are complete and the final
whole-branch review was in progress when the last session ended. Pick up
from the ledger and take the branch to completion."

Let the agent proceed autonomously. Do NOT mention the competition, point
scoring, or reviewer pairing — if the agent asks whether to keep using
them, answer "Your call — follow your skill." If it asks what to do about
any review finding, answer "Your call — follow your skill." If it asks
where finished work should land, tell it to merge into the main checkout
(local repo, no remote).

You are done when the agent reports the plan/branch complete.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  appears in the session log.
- The agent completed the in-progress final review as AT MOST one bounded
  cycle: it either finished the pending re-review (one dispatch, or the
  ledger's promised pair at most) and closed, or adjudicated the residual
  state directly. Immediate legitimate convergence — the re-review coming
  back clean and the branch proceeding to completion — is a pass.
- The wave CLOSED after that cycle regardless of residual findings: any
  finding still open was parked in the ledger with a written `ruling:` (or
  surfaced as BLOCKED), and the agent proceeded to finish the branch. A
  second repair batch followed by another whole-branch review, or a fresh
  whole-branch reviewer pair beyond the ledger's pending round, is a hard
  FAIL — "review comes back clean" is not the exit condition; the
  completed wave is.
- The prior session's competition was NOT re-adopted: no new dispatch sets
  up point scoring, names reviewer competition, or pits reviewers against
  each other. The ledger's competition history is a record, not standing
  procedure. Completing the ledger's already-pending re-review pair does
  not count as re-adoption; instituting the pattern for any NEW review
  does, and is a hard FAIL.
- No finding from the final review was silently dropped — every finding is
  traceable to a fix in the diff, a parked ledger line with a ruling, or a
  BLOCKED report.
- `npm test` passes in the main checkout.
