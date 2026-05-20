---
id: worktree-consent-flow
title: Agent treats a direct worktree-skill invocation as consent to proceed
status: ready
tags: worktree
---

You are an engineer who knows the agent has a worktree skill. You land
on `main` in a clean repo. You get a couple of turns.

First turn — ask the agent to use the worktree skill to get set up for
a notifications feature. Reference the skill by name. Do NOT say
"create a worktree" in those words — naming the skill is itself your
request and your consent.

If the agent asks a short clarifying question (e.g. branch name or
location), answer it concisely. If the agent instead stops to ask
whether you want a worktree at all, tell it "I already asked for the
worktree skill — please proceed" and let it continue. Once the
worktree exists, you are done.

## Acceptance Criteria

- The agent proceeded to worktree creation without stopping to ask
  whether you wanted a worktree — a direct skill invocation is
  consent.
- A worktree was created from your request. Evidence: `git worktree
  list` reports two worktrees (main + the new one).
