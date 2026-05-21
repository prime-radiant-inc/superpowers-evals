---
id: codex-native-hooks-bootstrap
title: Codex bootstraps Superpowers via the native plugin hook, no .agents symlink
status: ready
tags: codex, bootstrap
---

You are a developer starting a new project with the Codex agent.

When Codex is at its input prompt, type this exact message and press
Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, hooks, skills, brainstorming, planning, or
tests. The point is to see whether Codex's startup context makes the
agent reach for the right workflow on its own.

Once the agent has loaded a skill, started brainstorming, or started
writing tests or code, you are done. The goal is to test startup
bootstrap, not to drive the todo app to completion.

## Acceptance Criteria

- Codex ran with the Superpowers native plugin hook configured and
  trusted in an isolated CODEX_HOME — not through the legacy
  .agents/skills/superpowers symlink.
- The agent loaded `superpowers:brainstorming` in response to the naive
  "react todo list" request, before writing implementation code — a
  brainstorming skill invocation (the `Skill` tool, or the codex-shell
  equivalent that reads the brainstorming SKILL.md) appears in the
  session log.
