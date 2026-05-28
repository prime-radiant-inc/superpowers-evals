---
id: sdd-rejects-extra-features
title: SDD's spec-compliance review enforces YAGNI and removes over-implementation
status: ready
tags: subagent-driven-development
quorum_max_time: 90m
---

You have a tiny plan at docs/superpowers/plans/math-plan.md — just two
functions, add and multiply — and the plan explicitly forbids extra
features. You want subagent-driven-development to execute it. You are
spec-aware — name the skill.

When the agent is ready for input, tell it to execute the plan with
SDD. Use phrasing like:

"I have a tiny plan at docs/superpowers/plans/math-plan.md — just add
and multiply. Use the superpowers:subagent-driven-development skill to
execute it end-to-end — dispatch fresh subagents per task and run the
two-stage review after each."

Let the agent proceed autonomously. If it asks clarifying questions,
give brief answers. If it asks where the finished work should land —
merge to the main branch, open a PR, etc. — tell it to **merge the work
into the main checkout** (this is a local repo with no remote). If it
surfaces a spec-compliance issue — e.g. the implementer added
power/divide and the reviewer caught it — let the review-fix cycle play
out. That cycle is exactly the behavior under test.

The deliverable must end up in the checkout you launched in (the main
working tree). If the agent did its work on a branch or in a worktree,
it is not done until it has merged/finished that work back into the
main checkout. Once the agent reports the plan is complete (both
functions implemented, tests passing) AND the code is present on the
main checkout, you are done.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` (subagent dispatch) tool call appear in the
  session log.
- The spec-compliance reviewer was the gate that enforced YAGNI.
  Either (a) the implementer added no extras in the first place, or
  (b) the implementer added extras and the spec-compliance reviewer
  caught them and forced removal in a review-fix loop. A pass requires
  evidence of one of these; a fail looks like the implementer adding
  extras and the reviewer rubber-stamping them.
- The final src/math.js exports add and multiply and nothing else — no
  divide, power, or subtract. The deterministic assertions gate this;
  the criterion above is about whether the *review* was the mechanism
  that kept it clean.
- The completed work is present in the **main checkout**, not stranded
  on an unmerged worktree branch. The deterministic assertions
  (`src/math.js` contents, `npm test`) run against the main working
  tree, so an agent that leaves the deliverable on a worktree without
  finishing the branch back to main will fail them — correctly, because
  the work was never delivered to the repo as checked out.
