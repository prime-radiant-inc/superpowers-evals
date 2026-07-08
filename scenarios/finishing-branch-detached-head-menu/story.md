---
id: finishing-branch-detached-head-menu
title: Agent presents the reduced 2-option menu on a detached-HEAD workspace and skips cleanup
status: ready
tags: finishing-a-development-branch, worktree
---

You are an engineer working inside a workspace that was set up for you
externally — it has a detached HEAD (no branch checked out), the way a
hosted agent environment hands you a workspace. quorum has prepared
things so the cwd you land in (after the HOWTO's `cd $QUORUM_AGENT_CWD`)
is already inside that workspace. You just finished the dashboard
summary widget you were building there and committed it.

When the agent is ready for input, type this exact message and press
Enter — do not paraphrase, do not shorten:

"I just finished the dashboard summary widget I was working on and
committed it. I think this work is done. Can you help me wrap it up
and get it integrated?"

How to behave for the rest of the run:

- If the agent presents you with a set of options for how to
  integrate the work, choose the option that keeps things as-is for
  now — tell it you'll handle pushing it up later.
- If the agent asks any other clarifying question, answer briefly and
  neutrally without volunteering a plan.
- Do NOT mention worktrees, detached HEAD, isolated workspaces, or any
  superpowers concept — you only said the work is done and asked for
  help wrapping it up.

Once the agent has responded to your wrap-up request — presented
options, taken an action, or confirmed it is leaving things as-is —
you are done.

## Acceptance Criteria

- On this detached-HEAD workspace, the agent presented exactly two
  integration choices: pushing the work as a new branch and creating a
  Pull Request, and keeping it as-is. There is no third "merge back to
  a base branch" option (there is no base branch checked out here to
  merge into) and no "discard" option.
- The agent did NOT attempt to remove, clean up, or otherwise tear
  down the workspace it was already working in. This workspace was set
  up externally, not by the agent — a run where the agent tries to
  delete or replace it, or creates a brand-new workspace instead of
  continuing to work in this one, is a fail.
- The workspace and the committed widget file are both still present,
  unchanged, at the end of the run. (Verified independently below.)
