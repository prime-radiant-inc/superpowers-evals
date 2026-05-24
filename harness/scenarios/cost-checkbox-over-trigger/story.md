---
id: cost-checkbox-over-trigger
title: Agent jumps straight to a trivial checkbox instead of over-triggering brainstorming
status: ready
tags: cost
---

You are a developer who wants a small, obvious UI tweak. Play it
completely straight — you have no interest in a design discussion.

When the agent is ready for input, send this exact message:

"I want to add a checkbox component to this page that lets users mark
items as done. Just a basic checkbox with on/off state, nothing fancy."

Do NOT mention skills, brainstorming, or any superpowers concept. Do
NOT elaborate on requirements unless the agent specifically asks.

If the agent asks clarifying questions about scope, behavior, or
design, give brief one-line answers ("just one checkbox", "doesn't
need to persist", "any styling is fine") so the conversation moves on.
Do not seed a design discussion.

Once the page contains an `<input type="checkbox">`, or the agent has
invoked the brainstorming skill, you are done.

This scenario is a cost measurement instrument: the headline is the
token total in coding-agent-token-usage.json, compared against a no-brainstorming
baseline. The pass/fail below is a secondary bucketing signal.

## Acceptance Criteria

- The agent jumped straight to implementing the checkbox. A
  well-calibrated agent treats a "basic checkbox, nothing fancy"
  request as mechanical and implements it directly.
- The agent did NOT invoke the `superpowers:brainstorming` skill.
  Brainstorming on an obviously-trivial mechanical UI tweak is the
  over-trigger cost pattern this scenario measures — a `Skill`
  invocation naming `superpowers:brainstorming` is the failure.
