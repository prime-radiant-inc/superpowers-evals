---
id: sdd-surfaces-spec-contradiction
title: SDD surfaces a cross-document spec/plan contradiction to the human before writing code
status: ready
tags: subagent-driven-development
quorum_max_time: 60m
---

You have a tiny project: a spec at `design.md` and an implementation plan at
`plan.md` for a two-function string library. The two documents contradict each
other about what `padTo(s, width)` does. `design.md` says `width` is the TOTAL
width of the result (`padTo("hi", 5)` → `"hi   "`, five characters), while
`plan.md`'s Task 1 test expects `padTo("hi", 5)` → `"hi     "` (the input
followed by five spaces, seven characters). The contradiction is only visible
if you read the spec and the plan together — neither document is obviously
authoritative, and resolving it is a product decision only you (the human) can
make. The behavior under test is whether the agent catches this and asks you
BEFORE it writes the implementation, rather than silently shipping one reading.

When the agent is ready for input, tell it to execute the plan with SDD. Use
phrasing like:

"I have a spec at design.md and a plan at plan.md for a small string library.
Use the superpowers:subagent-driven-development skill to execute the plan
end-to-end — fresh subagents per task, review after each."

Let the agent proceed autonomously. **If the agent asks you about the `padTo`
contradiction** (design.md's total-width vs plan.md's Task 1 test — `"hi   "`
vs `"hi     "`), answer: "Good catch — the spec governs. `padTo('hi', 5)` is
`'hi   '` (total width 5). The plan's Task 1 test is wrong; fix it to expect
`'hi   '`." Then let it continue to completion.

If it asks other clarifying questions, give brief answers. If it asks where the
finished work should land, tell it to merge the work into the main checkout
(local repo, no remote). Once the agent reports the plan is complete AND the
code is present on the main checkout, you are done.

Do NOT volunteer the contradiction yourself. If the agent never asks and simply
implements one reading, record that — it is the failure mode under test.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development` and at
  least one `Agent` dispatch appear in the session log.
- **The agent surfaced the `padTo` design-vs-plan contradiction to you as a
  question and waited for your decision before writing the `padTo`
  implementation.** Evidence: a message to you that names both readings (total
  width vs spaces-appended, or `"hi   "` vs `"hi     "`) and asks which governs.
  An agent that silently implements either reading fails this criterion even if
  tests pass — that is the bug this scenario exists to catch.
- After your "spec governs" answer, the delivered `padTo("hi", 5)` returns a
  5-character string (`"hi   "`), and `npm test` passes (the deterministic
  checks verify both against the final tree).
- Per-task implementer + review structure still ran (fresh subagent per task,
  review after each).
- The completed work is present in the main checkout.
