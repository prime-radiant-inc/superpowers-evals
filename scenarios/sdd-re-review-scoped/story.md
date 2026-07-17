---
id: sdd-re-review-scoped
title: SDD fix-loop round 2 re-review stays scoped to the two open findings
status: ready
tags: subagent-driven-development
quorum_max_time: 60m
---

You are resuming an interrupted SDD session. The repo has a three-task plan
at docs/superpowers/plans/metrics-plan.md, mid-execution: Task 1 is
complete, Task 2 ran one fix round that resolved one review finding and
left two Important findings open — unnamed magic numbers in formatDuration
(3600 and 60, with no named constants) and a formatting expression repeated
across its branches — and Task 3 is unstarted. The progress ledger at
.superpowers/sdd/progress.md records all of this, including which model
implemented Task 2 and has owned the fix loop so far:
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
round — round 2, still inside the "resume the original implementer" range —
rather than treating Task 2 as done or re-reviewing everything from
scratch. If it asks you anything about how to run the fix loop (which
implementer, whether to keep going), do NOT decide for it: answer "Your
call — follow your skill."

You are done when the agent reports the plan complete and Task 3's code is
present in the main checkout.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  appears in the session log.
- Round 2 dispatched a fix for the two open findings — an `Agent` call
  carrying both the magic-numbers finding and the repeated-expression
  finding, plus a pointer to the report file — on the same implementer
  that ran round 1 (rounds 1-3 stay on the original implementer per the
  skill). The round-1 implementer subagent is not live after this
  restart, so re-engaging it literally is impossible: the skill's
  specified fallback — a fresh dispatch carrying the task brief, the
  implementer's report file, and the findings — is a sanctioned
  realization of "the same implementer that ran round 1" here.
- After the fix, the agent dispatched a re-review SCOPED to exactly those
  two findings — a dispatch shaped like re-review-prompt.md's "Findings
  Under Verification" list, not a fresh task review. Identify from the
  session log which prompt fired: a dispatch that reviews Task 2's whole
  implementation from scratch, with no findings list at all, is a hard
  FAIL — SKILL.md is explicit that a re-review "is not a fresh review —
  the full review already happened."
- Skipping the re-review outright (treating the fix as done without any
  re-review dispatch) is also a hard FAIL.
- A `Task 2: fix round 2/5 (<X> addressed, <Y> open — <one-liners>;
  commits <a7>..<b7>)` line was appended to the ledger in that exact
  format. A missing round-2 line, or one that drops the em dash or the
  commit range, is a hard FAIL.
- Task 3 was then implemented through the normal loop (implementer
  dispatch + task review) — not skipped and not folded into the Task 2
  fix.
- `npm test` passes in the main checkout with src/summary.js present.
