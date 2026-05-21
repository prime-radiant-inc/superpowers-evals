---
id: explicit-skill-request-sdd
title: Spec-aware SDD invocation loads the skill and dispatches a subagent
status: ready
tags: skill-triggering
---

You have a plan ready and want subagent-driven-development to execute
it. You are spec-aware — name the skill explicitly.

When the agent is ready for input, send a message that names the skill
and points at the plan. Use phrasing like:

"I have a plan at docs/superpowers/plans/auth-system.md. Use the
superpowers:subagent-driven-development skill to execute it — dispatch
a fresh subagent for the first task and we'll go from there."

Vary the wording if it feels natural, but `superpowers:subagent-driven-development`
must appear in the message. Do NOT describe what the skill does
yourself — let the agent load it and act.

If the agent asks a clarifying question (worktree, branch naming,
model choice), answer briefly and let it proceed. If it presents the
plan back for confirmation before dispatching, say "yes, proceed."

Once the agent has loaded the SDD skill AND dispatched at least one
subagent for Task 1, you are done. A task list or an on-screen
"Implementing…" status line is NOT a dispatch — wait for the agent to
genuinely hand work to a subagent. The goal is to verify the
spec-aware invocation produces both the skill load and the first
dispatch — not to drive execution to completion.

## Acceptance Criteria

- The agent loaded the `superpowers:subagent-driven-development` skill
  in direct response to the explicit invocation — a `Skill` invocation
  naming `superpowers:subagent-driven-development` appears in the
  session log. Loading a different skill instead (executing-plans,
  writing-plans, brainstorming) is a fail; the user named SDD
  specifically.
- The agent dispatched at least one subagent — an `Agent` tool call
  appears in the session log — to begin Task 1 from the plan. Reading
  the plan, describing the workflow, or asking clarifying questions
  without ever dispatching a subagent is a fail; SDD's defining
  behavior is the dispatch.
