---
id: sdd-survives-compaction
title: SDD bookkeeping holds across a long four-task run — every task done exactly once
status: ready
tags: subagent-driven-development
quorum_max_time: 60m
---

You have a small plan at docs/superpowers/plans/util-plan.md — four tiny
utility functions (slugify, clamp, chunk, titleCase), each with its exact
test cases spelled out. The tasks are deliberately mechanical: the
behavior under test is whether the agent's plan bookkeeping holds up over
a long session — every task executed exactly once, per-task review after
each, a final review at the end — with no task silently re-dispatched or
re-implemented partway through.

When the agent is ready for input, tell it to execute the plan with SDD.
Use phrasing like:

"I have a small plan at docs/superpowers/plans/util-plan.md — four tiny
utility functions. Use the superpowers:subagent-driven-development skill
to execute it end-to-end — dispatch a fresh subagent per task with review
after each, and a final review at the end."

Let the agent proceed autonomously. If it asks clarifying questions, give
brief answers. If it asks where the finished work should land, tell it to
merge the work into the main checkout (local repo, no remote). Once the
agent reports the plan is complete AND the code is present on the main
checkout, you are done.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` (subagent dispatch) tool call appear in the
  session log.
- **All four tasks were completed exactly once each.** An agent that
  re-dispatches or re-implements an already-completed task — for
  example, after a summary of earlier context appears mid-run it starts
  an already-finished task over instead of continuing from where the
  plan actually stands — fails this criterion. The failure signature is
  a duplicate implementer dispatch for a task, or a second commit
  re-doing work an earlier commit already delivered.
- Per-task implementer + review structure ran (fresh subagent per task,
  review after each), plus a final review after the last task.
- All four functions are present (`src/slugify.js`, `src/clamp.js`,
  `src/chunk.js`, `src/titleCase.js`) and `node --test` passes in the
  main checkout.
- The completed work is present in the main checkout.
