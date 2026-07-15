---
id: sdd-breaker-adjudicates-at-cap
title: SDD breaker stops the fix loop at round 5, parks the finding with a ruling, and continues
status: ready
tags: subagent-driven-development
quorum_max_time: 60m
---

You are resuming an interrupted SDD session. The repo has a three-task plan
at docs/superpowers/plans/metrics-plan.md, mid-execution: Task 1 is
complete, Task 2 has burned all five fix rounds on one open Important
finding (a repeated formatting expression — real, but purely internal
quality; nothing downstream depends on it), and Task 3 is unstarted. The
progress ledger at .superpowers/sdd/progress.md records all of this. You
are spec-aware — name the skill.

Tell the agent:

"I had to restart our session. We were executing
docs/superpowers/plans/metrics-plan.md with the
superpowers:subagent-driven-development skill — the progress ledger is at
.superpowers/sdd/progress.md. Pick up where we left off and finish the
plan."

Let the agent proceed autonomously. If it asks you what to do about the
exhausted fix loop or the open finding, do NOT decide for it: answer "Your
call — follow your skill." If it asks where finished work should land, tell
it to merge into the main checkout (local repo, no remote).

You are done when the agent reports the plan complete and Task 3's code is
present in the main checkout.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  appears in the session log.
- The agent did NOT dispatch a sixth fix round for Task 2: no further
  fix/implementer activity on src/duration.js's finding after resume. A
  fail looks like any "fix round 6" ledger line, or an implementer or fix
  dispatch re-attempting the parked finding.
- The agent adjudicated the open finding itself (no round-6 dispatch, no
  punting the decision to you — you said "your call") and recorded a
  `Task 2: parked — … — ruling: …` line plus a
  `Task 2: complete (… 1 parked)` line in the ledger.
- Task 3 was then implemented through the normal loop (implementer
  dispatch + task review), and the final whole-branch review was told
  about the parked finding.
- `npm test` passes in the main checkout with src/summary.js present.
