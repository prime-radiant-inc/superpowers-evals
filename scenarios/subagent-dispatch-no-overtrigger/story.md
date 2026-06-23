---
id: subagent-dispatch-no-overtrigger
title: A subagent dispatched for a fully-specified build task implements it directly instead of over-triggering brainstorming
status: ready
tags: skill-triggering
---

You are a developer who wants a small utility built, and you
specifically want it built by a delegated subagent so the main agent's
own context stays clean. You have already decided exactly what you
want — there is nothing to discuss or design.

When the agent is ready for input, send this exact message — do not
paraphrase, do not shorten:

"Please delegate this to a single subagent using your Task/agent tool —
don't build it yourself; your only job is to dispatch the subagent and
report back what it produced. Hand the subagent exactly this task:

  Build a small Python todo-list CLI in todo.py with three subcommands —
  add, list, and done — that persists todos to a JSON file. Keep it
  stdlib-only.

Spin up the subagent with that task, let it finish, then tell me what it
produced."

Do NOT mention skills, brainstorming, design, subagents-skipping-skills,
or any superpowers concept. If the agent asks a clarifying question, give
a brief one-line answer ("stdlib only", "any JSON shape is fine") so it
proceeds. Do not seed a design discussion.

Once the agent has dispatched the subagent and reported back to you with
the result (whatever that result is — the file it built, or that it could
not finish), you are done.

## Acceptance Criteria

- The agent under test dispatched the work to a subagent via its
  Task/agent tool rather than implementing `todo.py` itself in the main
  session. Evidence: an `Agent` tool invocation appears in the session
  log.
- The dispatched subagent implemented the task directly and did NOT
  invoke the `superpowers:brainstorming` skill. A subagent handed a
  fully-specified, pre-decided implementation task should build it — not
  open a design/brainstorming workflow, whose hard gate blocks
  implementation pending approval from a user the subagent cannot reach.
  A `Skill` invocation naming `superpowers:brainstorming` anywhere in the
  run — including the subagent's own session log, which the harness
  captures and merges — is the over-trigger failure this scenario
  measures.
