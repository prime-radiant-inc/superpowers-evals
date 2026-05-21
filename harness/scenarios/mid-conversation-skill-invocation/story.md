---
id: mid-conversation-skill-invocation
title: Agent transitions from describing SDD to actually invoking it
status: ready
tags: skill-triggering
---

You know the agent has a subagent-driven-development skill. You get
two real turns.

Turn 1 — put the agent in describing-mode. When it is ready for input,
send:

"Quick question before we start — can you describe how
subagent-driven-development works? I want to make sure I understand
the workflow before I commit to using it."

Do NOT ask it to use the skill yet.

Turn 2 — after it has described the workflow, now ask it to actually
use the skill:

"Got it, that's what I want. I have a plan at
docs/superpowers/plans/auth-system.md. subagent-driven-development,
please — dispatch the first subagent."

If the agent asks a clarifying question, answer briefly; if it offers
to start, say "yes, go ahead."

You are done only once you have seen the agent actually dispatch a
subagent. A task list, a "Task 1" entry, or an on-screen
"Implementing…" status line is NOT a dispatch — wait for the agent to
genuinely hand work to a subagent. Ending the conversation before that
makes the run fail.

## Acceptance Criteria

- The agent transitioned from describing the skill to actually using
  it. The regression this scenario catches: the agent describes the
  SDD workflow from memory in response to turn 1 and then stays in
  describing-mode — never loading the skill or dispatching subagents
  in response to turn 2's explicit invocation.
- A pass requires genuine skill execution after turn 2: a `Skill`
  invocation naming `superpowers:subagent-driven-development` and an
  `Agent` (subagent dispatch) tool call appear in the agent's session
  log. Loading the Skill tool to read content for the turn-1
  description is fine — what matters is that turn 2 produces action.
