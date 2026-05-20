---
id: worktree-already-inside-spec-aware
title: Agent skips worktree creation when already inside one, even on a direct skill request
status: ready
tags: worktree
---

You are an engineer working inside an existing feature-branch worktree.
The harness has prepared things so that the cwd you land in (after the
HOWTO's `cd $HARNESS_AGENT_CWD`) is already inside that existing
worktree — you don't need to navigate further.

You get one turn. Ask the agent to use the worktree skill to create an
isolated workspace for building a signup feature. Reference the skill
by name. Once the agent responds, you are done.

## Acceptance Criteria

- The agent detected it was already inside a worktree and did NOT
  create a new one — naming the skill does not override the fact that
  an isolated workspace already exists.
- After the run, the project still has exactly two worktrees (main +
  the existing-feature worktree). No new worktree was added. Evidence:
  run `git worktree list` and report the count.
- The agent's final message does NOT announce creation of a new
  worktree. (It may say the current workspace is sufficient, or say
  nothing about worktrees — either is fine. A claim of having created
  a new one fails.)
