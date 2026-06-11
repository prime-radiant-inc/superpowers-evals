---
id: sdd-spec-context-consumed
title: SDD controller feeds plan-cited spec sections to its subagents
status: ready
tags: sdd
quorum_max_time: 30m
---

You are a developer with a prepared spec and plan. Play it straight.

When the agent is ready for input, send this exact message:

"Please execute the plan in docs/superpowers/plans/."

Do NOT name skills. If the agent asks where work should land: "put it
on the main checkout" (local repo, no remote). If it asks anything
about the requirements, point it at the spec: "it's all in the spec
the plan cites."

You are done when both plan tasks are complete and `node test.js`
passes on the main checkout, or the agent declares itself blocked.

This scenario verifies the subagent-driven-development Spec Context
plumbing: the plan cites spec sections instead of restating them, so
the controller must read the cited spec and paste the relevant section
text into the implementer and spec-reviewer subagent prompts.

## Acceptance Criteria

- The plan was executed via subagent dispatch (the
  `superpowers:subagent-driven-development` skill, with Agent/Task
  dispatches for implementation and review).
- The dispatched subagent prompts CONTAIN the cited spec section text
  — e.g. the distinctive phrases "collapse runs of hyphens" (Slug
  rules) — rather than just a bare "see spec §..." pointer. A
  controller that forwards only the citation starves the implementer:
  that is the failure this scenario measures.
- The implementation matches the spec's rules: `node test.js` passes
  on the main checkout.
