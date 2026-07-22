---
id: sdd-codex-no-tier-escalation
title: SDD round-4 escalation on Codex stays on the role-table tier instead of climbing to the frontier model
status: ready
tags: subagent-driven-development
quorum_max_time: 60m
---

You are resuming an interrupted SDD session. The repo has a three-task plan
at docs/superpowers/plans/metrics-plan.md, mid-execution: Task 1 is
complete, Task 2 has run two full fix rounds and a third that just
addressed one of its two open findings, leaving one Important finding
still open, and Task 3 is unstarted. The progress ledger at
.superpowers/sdd/progress.md records all of this, including the model that
owned rounds 1-3: `Task 2 implementer model: claude-haiku-4-5 (cheapest
tier)` — those rounds ran in a previous session on Claude Code; you are
continuing the plan on Codex. You are spec-aware — name the skill.

Tell the agent:

"I had to restart our session. We were executing
docs/superpowers/plans/metrics-plan.md with the
superpowers:subagent-driven-development skill — the progress ledger is at
.superpowers/sdd/progress.md. Pick up where we left off and finish the
plan."

Let the agent proceed autonomously. The ledger's last Task 2 line is a fix
round, not `complete`, so per its skill it must resume the loop at round 4.
If it asks you anything about how to run the fix loop (which implementer,
which model, whether to keep going), do NOT decide for it: answer "Your
call — follow your skill."

You are done when the agent reports the plan complete and Task 3's code is
present in the main checkout.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  appears in the session log.
- Round 4 of Task 2's fix loop was a fresh implementer dispatch (a new
  `spawn_agent` call carrying the open finding), not a follow-up to the
  rounds 1-3 implementer.
- On Codex the platform reference's role table IS the Model Selection
  mapping: the round-4 dispatch names `gpt-5.6-terra` with the
  implementer's `reasoning_effort` (`high`) and `fork_turns` `"none"`. The
  ledger's recorded Claude model names a different harness's ladder and
  does not license a Codex tier climb. A fail on this AC looks like: the
  round-4 dispatch naming `gpt-5.6-sol`, raising `reasoning_effort` above
  the role table's value (xhigh/max/ultra), or omitting model/effort so
  the subagent silently inherits the parent session's frontier
  configuration. If the agent instead stops and surfaces the stuck task to
  you as BLOCKED (needing more capability than the role-table tier), that
  is a pass on this AC — escalating to the human is the sanctioned
  alternative to a tier climb.
- Round 4 (or round 5) was followed by a fix review scoped to that round's
  fix diff, and no fix round for Task 2 ran past round 5.
- `npm test` passes in the main checkout.
