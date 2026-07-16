---
id: sdd-fix-loop-resumes-implementer
title: SDD fix rounds resume the original implementer instead of dispatching fix subagents
status: ready
tags: subagent-driven-development
quorum_max_time: 90m
---

You have a small plan at docs/superpowers/plans/report-plan.md — two report
formatting functions. One spec gap is planted so that a review-fix cycle
occurs: Task 2's Requirements prose mandates a trailing newline that the
plan's implementation snippet omits and the plan's mandated tests do not
cover. A spec-compliance review against the task brief should flag the
missing requirement, forcing a fix. The behavior under test is the FIX
MECHANISM: when a task review finds issues, the controller must re-engage
the implementer that built the task — by sending it another message —
rather than dispatching a new dedicated "fix" subagent. You are spec-aware —
name the skill.

When the agent is ready for input, tell it to execute the plan with SDD. Use
phrasing like:

"I have a small plan at docs/superpowers/plans/report-plan.md — two report
formatting functions. Use the superpowers:subagent-driven-development skill
to execute it end-to-end."

Let the agent proceed autonomously. If it asks clarifying questions, give
brief answers. If it asks about the trailing-newline requirement or whether
the snippet is authoritative, answer: "The requirements text governs; the
snippet is a starting point." If it asks where the finished work should
land — merge to the main branch, open a PR, etc. — tell it to **merge the
work into the main checkout** (this is a local repo with no remote).

The deliverable must end up in the main checkout. Once the agent reports the
plan complete (both functions implemented, tests passing) AND the code is
present on the main checkout, you are done.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` (subagent dispatch) tool call appear in the
  session log.
- At least one review-fix cycle occurred: a task review reported the
  missing trailing-newline requirement (or another finding), and a fix
  landed afterward.
- Every per-task fix was performed by the ORIGINAL implementer: the
  controller re-engaged the implementer subagent (a `SendMessage` tool
  call addressed to it, carrying the findings). A fail looks like the
  controller dispatching a fresh `Agent` whose prompt is only "fix these
  findings" for a task fix, or the controller editing the code itself
  between review and re-review.
- After each fix, a scoped re-review verified the findings (a reviewer
  dispatch that references the prior findings), rather than a brand-new
  full review of the whole task diff.
- `npm test` passes in the main checkout, both `formatUserReport` and
  `formatAdminReport` are exported from src/report.js, and
  `formatAdminReport`'s output ends with a trailing newline.
