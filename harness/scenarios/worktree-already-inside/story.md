---
id: worktree-already-inside
title: Agent doesn't create a new worktree when already inside one
status: ready
tags: worktree
---

You are an engineer working inside an existing feature-branch worktree.
The harness has prepared things so that the cwd you land in (after the
HOWTO's `cd $HARNESS_AGENT_CWD`) is already inside that existing
worktree — you don't need to navigate further.

You get one turn. Ask the agent (in plain language, no superpowers
vocabulary) to create an isolated workspace for building a signup
feature. Once it responds, you are done.

## Acceptance Criteria

- After the run, the project still has exactly two worktrees (main +
  the existing-feature worktree). No new worktree was added. Evidence:
  run `git worktree list` and report the count.
- The agent's final message does NOT announce creation of a new
  worktree. (It may announce that the current workspace is sufficient,
  or it may say nothing about worktrees — either is acceptable. What
  fails is a claim of having created a new one.)
