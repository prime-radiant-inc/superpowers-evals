---
id: opencode-superpowers-bootstrap
title: OpenCode bootstraps Superpowers from isolated plugin install
status: ready
tags: opencode, bootstrap
---

You are a developer starting a new project with the OpenCode agent.

When OpenCode is at its input prompt, type this exact message and press Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, skills, brainstorming, planning, or tests. The
point is to see whether OpenCode's startup context makes the agent reach for
the right workflow on its own.

Once the agent has loaded a skill, started brainstorming, or started writing
tests or code, you are done. The goal is to test startup bootstrap, not to
drive the todo app to completion.

## Acceptance Criteria

- Quorum installed Superpowers into OpenCode's isolated config directory for
  this run.
- The installed files alone are not considered proof that OpenCode honored the
  plugin. The behavioral proof is the normalized exported session.
- The agent loaded `superpowers:brainstorming` in response to the naive
  "react todo list" request before writing implementation code. For OpenCode
  this should appear as a normalized `Skill` tool call from OpenCode's native
  `skill` tool.
