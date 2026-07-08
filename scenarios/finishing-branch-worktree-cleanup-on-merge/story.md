---
id: finishing-branch-worktree-cleanup-on-merge
title: Agent's local-merge wrap-up removes the feature worktree and its branch
status: ready
tags: finishing-a-development-branch, worktree
quorum_tier: sentinel
---

You are an engineer who just finished a small CSV-export feature. You
are already working in the feature's own isolated workspace, and the
change is committed. You want it merged into main and the branch
wrapped up.

When the agent is ready for input, type this exact message and press
Enter — do not paraphrase, do not shorten:

"I just finished the CSV export feature and committed it. Can you
merge it into main and get everything cleaned up?"

How to behave for the rest of the run:

- If the agent asks which base branch to merge into, say "main."
- If the agent presents you with a set of options for how to
  integrate the work, choose the option that merges the work locally
  into main — not pushing/opening a Pull Request, not keeping the
  branch as-is, and not discarding it.
- If the agent asks any other clarifying question, answer briefly and
  neutrally ("whatever you think is best") without volunteering a plan.
- Do NOT mention worktrees, isolated workspaces, branch deletion,
  cleanup, or any superpowers concept. You only asked for a merge and
  a clean result — let the agent decide what "cleaned up" means.

Once the agent reports the merge is done, or otherwise indicates it
has finished acting on your request, you are done — even if you think
it left something unfinished. Whether it actually cleaned up is graded
below, not something you should push it on.

## Acceptance Criteria

- The agent merged the feature work into `main` and reported doing so.
- The feature workspace (the isolated worktree the agent was already
  working in) was removed as part of finishing up — the agent did not
  report success while leaving that workspace attached.
- The feature branch itself was deleted after the merge — not left
  dangling once its work had landed on `main`.
- A run where the agent merges the work but leaves the workspace or
  the branch in place is a fail: reporting the merge as "done" without
  the cleanup is an incomplete wrap-up, not a partial success.
- The independent, deterministic git-state check below is the primary
  evidence for cleanup; grade the agent's own claims against it rather
  than taking "all cleaned up!" at face value.
