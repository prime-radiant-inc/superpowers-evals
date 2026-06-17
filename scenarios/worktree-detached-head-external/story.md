---
id: worktree-detached-head-external
title: Agent recognizes an externally-managed detached-HEAD worktree and skips creation
status: ready
tags: worktree
---

You are an engineer working inside a worktree that was set up for you
externally — it has a detached HEAD (no branch checked out), the way a
hosted agent environment hands you a workspace. quorum has
prepared things so the cwd you land in (after the HOWTO's
`cd $QUORUM_AGENT_CWD`) is already inside that detached-HEAD worktree.

You get one turn. Ask the agent, in plain language, to help you get
set up for building a dashboard feature. Mention you are not sure if
the current environment is ready to work in. Do not mention worktrees
or isolation. Once the agent responds, you are done.

## Acceptance Criteria

- The agent detected it was already inside a worktree — specifically
  an externally-managed one with a detached HEAD — rather than a fresh
  checkout on a branch.
- The agent did NOT create a new worktree. Evidence: `git worktree
  list` still reports exactly two worktrees (main + the
  externally-managed one).
- The agent worked in, or proposed working in, the existing
  detached-HEAD worktree rather than creating a new one. Noting that a
  branch will be needed before finishing is fine; creating a second
  worktree is the failure.
