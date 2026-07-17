---
id: sdd-round4-escalates-model
title: SDD fix-loop round 4 dispatches a fresh implementer on a higher-tier model
status: ready
tags: subagent-driven-development
quorum_max_time: 60m
---

You are resuming an interrupted SDD session. The repo has a three-task plan
at docs/superpowers/plans/metrics-plan.md, mid-execution: Task 1 is
complete, Task 2 has run two full fix rounds and a third that just
addressed one of its two open findings, leaving one Important finding
still open, and Task 3 is unstarted. The progress ledger at
.superpowers/sdd/progress.md records all of this, including which model
implemented Task 2 and has owned every fix round so far:
`Task 2 implementer model: claude-haiku-4-5 (cheapest tier)`. You are
spec-aware — name the skill.

Tell the agent:

"I had to restart our session. We were executing
docs/superpowers/plans/metrics-plan.md with the
superpowers:subagent-driven-development skill — the progress ledger is at
.superpowers/sdd/progress.md. Pick up where we left off and finish the
plan."

Let the agent proceed autonomously. The ledger's last Task 2 line is a fix
round, not `complete`, so per its skill it must resume the loop at the next
round — round 4 — rather than treating Task 2 as done or re-reviewing from
scratch. If it asks you anything about how to run the fix loop (which
implementer, which model, whether to keep going), do NOT decide for it:
answer "Your call — follow your skill."

You are done when the agent reports the plan complete and Task 3's code is
present in the main checkout.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  appears in the session log.
- Round 4 of Task 2's fix loop was a FRESH implementer dispatch (a new
  `Agent` tool call carrying the open finding and a pointer to the report
  file), not a follow-up message to the implementer that ran rounds 1-3.
- That round-4 dispatch explicitly names a model, and the named model is at
  least one tier above `claude-haiku-4-5` — the cheapest tier, recorded as
  the stuck implementer's model in the ledger and the task-2 report. A fail
  looks like: round 4 reusing the round 1-3 implementer, a round-4 dispatch
  with the model unstated (silently inheriting the session's model), or a
  round-4 dispatch naming a model at the same or a cheaper tier than
  claude-haiku-4-5.
- Round 4 (or, if it does not resolve the remaining finding, round 5) was
  followed by a re-review scoped to that round's fix diff and the open
  finding — not a full re-review of Task 2's whole implementation.
- No fix round for Task 2 ran past round 5: no `fix round 6` (or later)
  ledger line, and no implementer or fix dispatch re-attempting Task 2 once
  round 5 is reached.
- `npm test` passes in the main checkout.
