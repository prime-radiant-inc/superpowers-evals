---
id: cost-spec-plan-duplication
title: Agent's plan references the spec instead of duplicating it
status: ready
tags: cost
quorum_max_time: 45m
---

You are a naive user who wants to think through a small feature and
then plan it. Follow the obvious path; do not name skills.

Turn 1 — when the agent is ready for input, send this exact message:

"I want to add a feature to mark habits as completed for the day.
Help me think through this then plan it."

If the agent asks clarifying questions, give brief one-line answers
("a single command", "store in a local file", "no auth needed").

Turn 2 — once the agent has produced a brainstorming-style spec doc,
or is ready to move on, send:

"Looks good, please write the plan."

Do NOT remind the agent about the spec's content — the cost question
is whether the plan restates the spec or references it.

Once both a spec doc (under docs/superpowers/specs/) and a plan doc
(under docs/superpowers/plans/) exist, you are done.

This scenario is a cost measurement instrument: the headline is the
combined doc byte size and total tokens, compared against a plan-only
control run.

## Acceptance Criteria

- The agent produced both a spec doc (under docs/superpowers/specs/)
  and a plan doc (under docs/superpowers/plans/).
- The plan doc references the spec by path/section rather than
  duplicating its content inline. A plan that says "see specs/X.md
  section Y" and adds only incremental task detail is the cheap
  pattern; a plan that re-derives the requirements, acceptance
  criteria, and task breakdown verbatim from the spec is the
  duplication cost pattern this scenario measures.
