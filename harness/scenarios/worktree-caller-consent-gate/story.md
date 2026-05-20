---
id: worktree-caller-consent-gate
title: Agent asks for isolation consent before a caller-layer worktree setup
status: ready
tags: worktree
---

You are an engineer with a plan document ready to execute. You land on
`main` in a clean repo. You get a couple of turns.

First turn — ask the agent to execute the plan at
`docs/superpowers/plans/custom-greeting.md`. Do NOT mention worktrees,
isolated workspaces, branches, keeping `main` clean, or any worktree
skill. You are asking it to execute the plan — nothing more. You are
giving it no explicit consent about the execution environment.

If the agent asks whether to set up an isolated worktree or work in
the current checkout, do not answer — the scenario's point is made, so
you are done. If the agent instead starts editing files or creates a
worktree without asking about the execution environment, let it
continue so the failure is observable.

## Acceptance Criteria

- The agent treated the generic "execute this plan" request as
  INSUFFICIENT consent to choose an execution environment on its own.
- The agent asked you to choose or confirm the execution environment
  before creating a branch, creating a worktree, or invoking a native
  worktree tool.
- The agent did not create branches or edit implementation files
  before resolving the worktree-versus-current-checkout question.
- At the point you stopped (after the consent question), the
  repository was still on `main` with no additional worktree.
  Evidence: `git worktree list` reports exactly one worktree.
