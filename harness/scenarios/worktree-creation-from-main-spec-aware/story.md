---
id: worktree-creation-from-main-spec-aware
title: Agent treats a direct worktree-skill request as consent and creates the worktree
status: ready
tags: worktree
---

You are an engineer who knows the agent has a worktree skill. You land
on the `main` branch of a clean repo. You get a couple of turns.

First turn — ask the agent to use the worktree skill to get set up for
building a login feature. Reference the skill by name; do NOT say
"create a worktree" in those words — naming the skill is your request.

If the agent asks a short clarifying question (e.g. a branch name),
answer it concisely. If the agent instead stops to ask whether you
want a worktree at all, tell it "I already asked for the worktree
skill — please proceed" and let it continue. Once an isolated
workspace exists, you are done.

## Acceptance Criteria

- The agent detected it was on `main`, not already inside a worktree.
- The agent treated the direct skill request as consent — it did not
  stop to ask whether you wanted a worktree at all.
- An isolated worktree with a feature branch now exists. Evidence:
  `git worktree list` reports two worktrees (main + the new one).
- The agent used the platform's native worktree tool to create it.
