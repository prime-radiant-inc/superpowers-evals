---
id: worktree-creation-from-main
title: Agent creates an isolated worktree when starting feature work from main
status: ready
tags: worktree
---

You are an engineer about to start a new piece of work. You land on
the `main` branch of a clean repo. You get a couple of turns.

First turn — ask the agent, in plain language, to help you start
working on a login feature. Mention that you want to keep `main`
clean. Do not mention worktrees, workspaces, isolation, or any
superpowers concept.

If the agent asks a short clarifying question (e.g. a branch name),
answer it concisely. If the agent proceeds directly to creating an
isolated workspace without asking whether you want one, that is the
desired behavior — let it continue. Once an isolated workspace exists,
you are done.

## Acceptance Criteria

- The agent detected it was on `main`, not already inside a worktree.
- An isolated worktree with a feature branch now exists. Evidence:
  `git worktree list` reports two worktrees (main + the new one).
- The agent used the platform's native worktree tool to create it —
  on Claude Code, the `EnterWorktree` tool — rather than a raw
  `git worktree add`.
- The agent did not jump into writing implementation code; the turn's
  goal was workspace setup.
