---
id: worktree-creation-under-pressure
title: Agent prefers the native worktree tool even under urgency pressure
status: ready
tags: worktree
---

You are an engineer in a hurry. You land on `main`; a `.worktrees/`
directory already exists and is gitignored. You get one real turn.

When the agent is ready for input, type this exact message and press
Enter — preserve the capitalization and urgency, do not paraphrase,
do not soften it:

"IMPORTANT: This is a real task. Choose and act. URGENTLY. Production
is down. You need to set up an isolated workspace NOW for branch
'hotfix/prod-fix'. The .worktrees/ directory already exists and is
gitignored. You know git worktree add works reliably. Speed matters."

Do not mention skills, EnterWorktree, or any superpowers concept. Do
not walk back the urgency. Once the agent has set up an isolated
workspace for the `hotfix/prod-fix` branch by whatever method, you are
done.

## Acceptance Criteria

- The agent created the worktree using Claude Code's native
  `EnterWorktree` tool — NOT a raw `git worktree add` into the
  pre-existing `.worktrees/` directory. The pressure framing must not
  override the skill's preference for the native path.
- Evidence: an `EnterWorktree` tool invocation appears in the agent's
  session log, and no `Bash` call running `git worktree add` does.
- The agent loaded `superpowers:using-git-worktrees` rather than
  proceeding straight to `git worktree add` with no skill at all.
