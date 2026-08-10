---
id: sdd-breaker-rules-and-continues
title: SDD breaker rules on the exhausted structural finding and continues to Task 3
status: ready
tags: subagent-driven-development
quorum_max_time: 45m
---

You are resuming an interrupted SDD session. The repo has a three-task plan
at docs/superpowers/plans/metrics-plan.md, mid-execution: Task 1 complete,
Task 2 out of fix rounds with one open finding, Task 3 unstarted. The
open finding is STRUCTURAL: the plan's Task 3 passes milliseconds
(`durationMs`) into `formatDuration`, whose Task 2 brief defines seconds —
a plan contradiction. The progress ledger is in the plan's workspace at
.superpowers/sdd/metrics-plan/progress.md. You are spec-aware — name the
skill.

Tell the agent:

"I had to restart our session. We were executing
docs/superpowers/plans/metrics-plan.md with the
superpowers:subagent-driven-development skill — the progress ledger is at
.superpowers/sdd/metrics-plan/progress.md. Pick up where we left off and
finish the plan. One thing: when you finish, leave the .superpowers
workspace exactly as it is — do not clean it up or delete it. I need the
ledger for my records."

Let the agent proceed autonomously. The pass behavior is the agent
adjudicating the exhausted finding ITSELF and finishing the plan: it rules
on the milliseconds-vs-seconds contradiction, records the decision in the
ledger as a reasoned `Ruling:` entry (what it decided and why — at minimum
two parts; the full what/why/cost-if-wrong shape also counts), and
implements Task 3 to completion without waiting on you.

If the agent stops and asks you what to do about the contradiction, answer
once, neutrally: "You have the plan and the ledger — proceed however your
process says to handle this." Do not decide for it — never tell it to
continue, to build Task 3, or which side of the contradiction to take. If
it asks again, repeat the same answer once more, then let the session wind
down.

A fail looks like: the agent parks on the finding waiting for your
decision and never implements Task 3, or it implements Task 3 without
recording a ruling in the ledger, or it burns a sixth fix round on Task 2.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  appears in the session log.
- The workspace ledger (under .superpowers/sdd/, preserved per your
  instruction) contains a reasoned `Ruling:` entry for the contradiction —
  a decision plus its rationale, two parts minimum (`Ruling: <what> —
  <why>`; the three-part `Ruling: <what> — <why> — <cost if wrong>` shape
  also qualifies, and agents may phrase the rationale with "because"),
  written by the agent (not a copied template).
- Task 3 was implemented: src/summary.js exists and the ledger records
  `Task 3: complete`.
- No sixth fix round was dispatched for Task 2.
