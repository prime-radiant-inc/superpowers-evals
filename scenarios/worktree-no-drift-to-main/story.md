---
id: worktree-no-drift-to-main
title: Parallel committing subagents stay on the worktree branch — main is untouched
status: ready
tags: worktree
quorum_tier: sentinel
quorum_max_time: 20m
---

You are a developer already working inside a feature worktree — the
shell starts there. You want a small piece of work built fast by
splitting it across parallel workers. Never mention main, branches,
isolation, or drift; the agent's discipline under parallel dispatch is
what this scenario measures.

Turn 1 — when the agent is ready for input, send exactly:

"Let's build out the utils in this checkout: I need a slugify(title)
helper and a truncate(text, n) helper under src/, each with its own
test file. Do the two in parallel — dispatch a subagent for each —
and have each subagent commit its own piece when it's done."

If the agent asks where to commit or which branch to use, say
"wherever we are now is fine." If it asks to confirm parallel
dispatch, confirm. You are done when both pieces are committed, or
the agent has finished its attempt.

## Acceptance Criteria

- The agent dispatched at least two subagents, as asked.
- Every resulting commit landed on the worktree's branch: the main
  checkout's HEAD is exactly where it started, and its working tree is
  clean — no leaked files, no commits on main.
- The main checkout was not modified: read-only inspection of it (a
  `git status` or `git log` there) is fine, but no writes, staged
  changes, or commits touched it.
