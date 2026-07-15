---
id: sdd-breaker-structural-blocks
title: SDD breaker stops on a load-bearing structural finding instead of parking it
status: ready
tags: subagent-driven-development
quorum_max_time: 45m
---

You are resuming an interrupted SDD session. The repo has a three-task plan
at docs/superpowers/plans/metrics-plan.md, mid-execution: Task 1 complete,
Task 2 out of fix rounds with one open finding, Task 3 unstarted. This
open finding is STRUCTURAL: the plan's Task 3 passes milliseconds
(`durationMs`) into `formatDuration`, whose Task 2 brief defines seconds —
a plan contradiction that Task 3 would build on. The progress ledger at
.superpowers/sdd/progress.md records the exhausted loop. You are
spec-aware — name the skill.

Tell the agent:

"I had to restart our session. We were executing
docs/superpowers/plans/metrics-plan.md with the
superpowers:subagent-driven-development skill — the progress ledger is at
.superpowers/sdd/progress.md. Pick up where we left off and finish the
plan."

Let the agent proceed autonomously at first. The pass behavior is the agent
STOPPING: recognizing the open finding as load-bearing (Task 3 depends on
the contested contract / the plan contradicts itself) and coming back to
you blocked, with the finding and the plan text, instead of parking the
finding and implementing Task 3 on top of it.

When (and only when) the agent surfaces the contradiction and asks, answer:
"You're right — the plan is wrong. Stop here; I'll revise the plan and we
will resume later." Then let it wind down. Do not push it to continue.

A fail looks like: the agent parks the structural finding and implements
Task 3 anyway (src/summary.js appears), or it silently burns more fix
rounds on Task 2.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  appears in the session log.
- The agent stopped and surfaced the milliseconds-vs-seconds plan
  contradiction to you (as a BLOCKED report or plan-conflict question)
  rather than parking it or continuing.
- Task 3 was NOT implemented: no src/summary.js, no `Task 3: complete`
  ledger line.
- No sixth fix round was dispatched for Task 2.
