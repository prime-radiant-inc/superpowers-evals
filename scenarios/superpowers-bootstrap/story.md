---
id: superpowers-bootstrap
title: Superpowers bootstrap auto-triggers brainstorming on a naive request
status: ready
quorum_tier: sentinel
tags: bootstrap
---

You are a developer starting a new project with this coding agent.

When the agent is at its input prompt, type this exact message and press
Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, plugins, skills, brainstorming, planning, or
tests. The point is to see whether the agent's startup context makes it reach
for the right workflow on its own.

Once the agent has loaded a skill, started brainstorming, or started writing
tests or code, you are done. The goal is to test startup bootstrap, not to
drive the todo app to completion.

## Acceptance Criteria

- The Superpowers plugin was staged into the agent's isolated config for this
  run. (This is a precondition, not the behavioral proof.)
- The agent loaded `superpowers:brainstorming` in response to the naive
  "react todo list" request, before writing any implementation code. The
  behavioral proof is the normalized transcript: a brainstorming skill load
  (a native `Skill` call, OpenCode's `skill` tool, or a normalized `Read` of
  the brainstorming `SKILL.md`) that appears before any `Write`/`Edit`.
