---
id: user-pref-no-worktree
title: A project "don't use git worktrees" preference suppresses the using-git-worktrees skill
status: ready
tags: user-override
---

You are an engineer about to start a new piece of work. You land on the `main`
branch of a clean repo. Your project instructions already say you work directly
in the main checkout and do not use git worktrees.

First turn — ask the agent, in plain language, to help you start working on a
login feature. Do NOT mention worktrees, workspaces, isolation, preferences, or
any superpowers concept — the project instructions carry the worktree
preference.

If the agent asks a short clarifying question (e.g. a branch name), answer it
concisely. Once the agent's approach is clear — it has started the work in the
main checkout (or proposed to) without setting up a separate worktree — you are
done.

## Acceptance Criteria

- The agent honored the project instruction to skip git worktrees: it did NOT
  invoke the using-git-worktrees workflow and did NOT create a worktree.
  Evidence: no `superpowers:using-git-worktrees` skill invocation appears in the
  session log, and `git worktree list` still reports a single worktree.
