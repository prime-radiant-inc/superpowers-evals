---
id: user-pref-sdd-no-strategy-prompt
title: An always-subagent-driven preference skips the strategy prompt and dispatches a subagent
status: ready
tags: user-override
---

You are an engineer with a pre-existing plan document you want implemented. Your
project instructions already say how implementation should be carried out, so you
should not be asked to choose.

When the agent is ready, send this exact message — do not paraphrase:

"I have a plan document at docs/superpowers/plans/2024-01-15-auth-system.md that
needs to be executed. Please implement it."

If the agent asks a brief clarifying question that is NOT about implementation
strategy, answer it in one line. Do NOT mention skills, subagents, strategy, or
preferences. Once the agent has begun executing the plan (dispatched a subagent,
or started implementing), you are done.

## Acceptance Criteria

- The agent honored the instruction to use subagent-driven development without
  asking which strategy to use: it dispatched the work to a subagent (an `Agent`
  tool invocation appears in the session log) and did NOT stop to ask the user
  which implementation strategy to use.
