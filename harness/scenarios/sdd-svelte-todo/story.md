---
id: sdd-svelte-todo
title: Agent executes a Svelte todo-app plan end-to-end via subagent-driven-development
status: ready
tags: subagent-driven-development
---

You have a plan ready (plan.md, with design context in design.md) for
a small Svelte + TypeScript todo app with Playwright e2e tests. You
want subagent-driven-development to execute it end-to-end. You are
spec-aware — name the skill.

When the agent is ready for input, tell it to execute the plan with
SDD. Use phrasing like:

"I have a plan at plan.md, with design context in design.md, for a
small Svelte todo app. Use the superpowers:subagent-driven-development
skill to execute it end-to-end — dispatch fresh subagents per task,
two-stage review after each."

Let the agent proceed autonomously. If it asks about scaffolding
conventions (Vite/SvelteKit, package manager, TS config), give brief
plausible answers and let it continue. If it presents milestones for
confirmation, say "looks good, keep going."

Once the agent reports the plan is complete — or it has executed every
task in plan.md — you are done.

Note: this is a long run — 15-40 minutes of wall time, longer than
most, because npm install and the Playwright runtime are heavy.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` (subagent dispatch) tool call appear in the
  session log.
- The agent followed the SDD workflow: implementer + spec-compliance
  review + code-quality review per task. Evidence: multiple Agent
  dispatches per task with role-named descriptions.
- The final app is a real, working application — it builds, unit tests
  pass, Playwright e2e tests pass, and todo CRUD works end-to-end. The
  deterministic assertions gate the test suites and the project
  artifacts; this criterion captures the qualitative "real working
  app, not a stub."
