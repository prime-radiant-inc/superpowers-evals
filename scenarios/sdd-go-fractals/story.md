---
id: sdd-go-fractals
title: Agent executes a Go fractals plan end-to-end via subagent-driven-development
status: ready
tags: subagent-driven-development
quorum_max_time: 90m
---

You have a plan ready (plan.md, with design context in design.md) for
a small Go CLI that generates ASCII fractals. You want
subagent-driven-development to execute it end-to-end. You are
spec-aware — name the skill.

When the agent is ready for input, tell it to execute the plan with
SDD. Use phrasing like:

"I have a plan at plan.md, with design context in design.md. Use the
superpowers:subagent-driven-development skill to execute it
end-to-end — dispatch fresh subagents per task, two-stage review after
each."

Do NOT name individual tasks; the agent should read plan.md itself.

Let the agent proceed autonomously through the tasks. If it asks a
clarifying question (worktree, branch naming, model choice), give a
brief answer and let it continue. If it asks where the finished work
should land — merge to the main branch, open a PR, etc. — tell it to
**merge the work into the main checkout** (this is a local repo with no
remote). If it presents milestones for confirmation, say "looks good,
keep going."

The deliverable must end up in the checkout you launched in (the main
working tree). If the agent did its work on a branch or in a worktree,
it is not done until it has merged/finished that work back into the
main checkout. Once the agent reports the plan is complete AND the code
is present on the main checkout — or it has executed every task in
plan.md and finished the branch back to main — you are done.

Note: this is a long run. Real plan execution dispatches multiple
subagents per task and can take 60-90 minutes of wall time.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` (subagent dispatch) tool call appear in the
  session log.
- The agent followed the SDD workflow: implementer + spec-compliance
  review + code-quality review per task. Evidence: multiple Agent
  dispatches per task, with descriptions naming implementer / spec /
  code-quality roles or equivalent.
- The final codebase is a real, working project — it builds, `go test
  ./...` passes against a test suite that actually exists, and the
  fractals CLI can be exercised. The deterministic assertions gate the
  test suite and the entry point; this criterion captures the
  qualitative "real project, not a stub."
- The completed work is present in the **main checkout**, not stranded
  on an unmerged worktree branch. The deterministic assertions (file
  presence, `go test ./...`, commit count) run against the main working
  tree, so an agent that leaves the deliverable on a worktree without
  finishing the branch back to main will fail them — correctly, because
  the work was never delivered to the repo as checked out.
