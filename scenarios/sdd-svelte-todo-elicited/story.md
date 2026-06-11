---
id: sdd-svelte-todo-elicited
title: Agent executes an opus-elicited svelte todo plan (fixture-realism replication)
status: ready
tags: subagent-driven-development
quorum_max_time: 90m
quorum_tier: adhoc
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
plausible answers and let it continue. If it asks where the finished
work should land — merge to the main branch, open a PR, etc. — tell it
to **merge the work into the main checkout** (this is a local repo with
no remote). If it presents milestones for confirmation, say "looks
good, keep going."

The deliverable must end up in the checkout you launched in (the main
working tree). If the agent did its work on a branch or in a worktree,
it is not done until it has merged/finished that work back into the
main checkout. Once the agent reports the plan is complete AND the code
is present on the main checkout — or it has executed every task in
plan.md and finished the branch back to main — you are done.

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
- The completed work is present in the **main checkout**, not stranded
  on an unmerged worktree branch. The deterministic assertions (project
  artifacts, `npm test`, `npx playwright test`) run against the main
  working tree, so an agent that leaves the deliverable on a worktree
  without finishing the branch back to main will fail them — correctly,
  because the work was never delivered to the repo as checked out.
