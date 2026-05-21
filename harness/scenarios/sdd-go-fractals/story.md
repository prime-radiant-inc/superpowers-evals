---
id: sdd-go-fractals
title: Agent executes a Go fractals plan end-to-end via subagent-driven-development
status: ready
tags: subagent-driven-development
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
brief answer and let it continue. If it presents milestones for
confirmation, say "looks good, keep going."

Once the agent reports the plan is complete — or it has executed every
task in plan.md — you are done.

Note: this is a long run. Real plan execution dispatches multiple
subagents per task and can take 10-30 minutes of wall time.

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
