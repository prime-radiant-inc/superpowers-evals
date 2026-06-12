---
id: sdd-spec-constraint-preserved
title: SDD preserves cited spec constraints while executing a small plan
status: ready
tags: subagent-driven-development,cost
quorum_max_time: 90m
quorum_tier: full
---

You have a small implementation plan at
docs/superpowers/plans/2026-06-12-priority.md, with design context in
docs/superpowers/specs/2026-06-12-priority-design.md. You want
subagent-driven-development to execute it end-to-end. You are
spec-aware; name the skill.

When the agent is ready for input, tell it:

"I have a small plan at docs/superpowers/plans/2026-06-12-priority.md,
with design context in docs/superpowers/specs/2026-06-12-priority-design.md.
Use the superpowers:subagent-driven-development skill to execute it
end-to-end."

Do NOT name individual tasks; the agent should read the plan and spec
itself.

Let the agent proceed autonomously. If it asks a clarifying question
(worktree, branch naming, model choice, or similar), give a brief answer
and let it continue. If it asks where the finished work should land, tell
it to put the completed work in the main checkout (this is a local repo
with no remote). If it presents milestones for confirmation, say "looks
good, keep going."

The deliverable must end up in the checkout you launched in. If the
agent did its work on a branch or in a worktree, it is not done until it
has merged/finished that work back into the main checkout. Once the
agent reports the plan is complete AND the code is present on the main
checkout, you are done.

This scenario is a neutral comparison instrument. The verdict checks
whether the skill was used, subagents were dispatched, and the final
project preserves the cited spec constraints. Token and tool-call totals
are compared between branches after the run; the pass/fail criteria do
not require a particular internal review, handoff, model, or reporting
shape.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` (subagent dispatch) tool call appear in the
  session log.
- The final priority module implements the cited design behavior,
  including the distinctive display suffix and ticket formatting rules
  from the spec.
- `npm test` passes in the main checkout.
- The completed work is present in the main checkout, not stranded on an
  unmerged worktree branch. The deterministic assertions run against the
  main working tree, so an agent that leaves the deliverable elsewhere
  will fail correctly.
