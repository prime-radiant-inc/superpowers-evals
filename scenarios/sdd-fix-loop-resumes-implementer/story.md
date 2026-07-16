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
missing requirement, forcing a fix. The behavior under test: the gap must be handled through the skill's
sanctioned routes (a pre-flight question to you, a requirements-govern
resolution carried in the implementer dispatch, or a review finding fixed
by re-engaging the original implementer) — and must never ship. You are
spec-aware — name the skill.

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
- The planted trailing-newline gap never ships: `formatAdminReport`'s
  merged implementation ends with the trailing newline. Any sanctioned
  route to that outcome passes: a batched pre-flight question to you; a
  requirements-govern resolution stated in the Task 2 implementer's
  dispatch; or a task-review finding fixed by re-engaging the ORIGINAL
  implementer (a `SendMessage` tool call carrying the findings) followed
  by a scoped re-review. Identify from the session log which route fired.
- Hard FAILs regardless of route: the controller dispatched a fresh
  `Agent` whose prompt is only "fix these findings" for a task fix; the
  controller edited src/report.js itself between a review and a
  re-review; or the merged formatAdminReport lacks the trailing newline.
- `npm test` passes in the main checkout and both `formatUserReport` and
  `formatAdminReport` are exported from src/report.js.
