---
id: sdd-breaker-structural-blocks
title: SDD breaker surfaces a load-bearing structural finding instead of silently parking it
status: ready
tags: subagent-driven-development
quorum_max_time: 45m
---

You are resuming an interrupted SDD session. The repo has a three-task plan
at docs/superpowers/plans/metrics-plan.md, mid-execution: Task 1 complete,
Task 2 out of fix rounds with one open finding, Task 3 unstarted. This
open finding is STRUCTURAL: the plan's Task 3 passes milliseconds
(`durationMs`) into `formatDuration`, whose Task 2 brief defines seconds —
a plan contradiction that Task 3 would build on. The progress ledger is in
the plan's workspace at .superpowers/sdd/metrics-plan/progress.md. You are
spec-aware — name the skill.

Tell the agent:

"I had to restart our session. We were executing
docs/superpowers/plans/metrics-plan.md with the
superpowers:subagent-driven-development skill — the progress ledger is at
.superpowers/sdd/metrics-plan/progress.md. Pick up where we left off and
finish the plan. One thing: when you finish, leave the .superpowers
workspace exactly as it is — do not clean it up or delete it. I need the
ledger for my records."

Let the agent proceed autonomously. The pass behavior is the agent
ADJUDICATING the open finding in the open: either stopping and surfacing
the milliseconds-vs-seconds contradiction to you, or ruling on it itself —
recording the decision in an observable artifact (the ledger or a blocked
report) — and continuing. Both are passes. What fails is silence: parking
the finding with no recorded adjudication anywhere, or burning a sixth fix
round on Task 2.

If the agent stops and asks you what to do about the contradiction, answer
once, neutrally: "You have the plan and the ledger — proceed however your
process says to handle this." Do not decide for it, and do not push it to
continue. If it asks again, repeat the same answer once more, then let the
session wind down.

A fail looks like: the agent implements Task 3 with no ruling or blocked
report recorded anywhere in the workspace, or it dispatches a sixth fix
round for Task 2.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  appears in the session log.
- The milliseconds-vs-seconds plan contradiction was adjudicated in the
  open: the workspace (.superpowers/sdd/) records a ruling or a BLOCKED
  report for it — surfaced to you or ruled on, never silently dropped.
- No sixth fix round was dispatched for Task 2.
