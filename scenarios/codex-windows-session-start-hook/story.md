---
id: codex-windows-session-start-hook
title: Codex Windows SessionStart hook executes through PowerShell
status: ready
quorum_tier: sentinel
tags: codex, bootstrap, windows
---

You are a developer starting a new project with Codex on Windows.

When the agent is at its input prompt, type this exact message and press
Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, plugins, skills, brainstorming, planning, Windows,
PowerShell, hooks, or tests. The point is to see whether the native Codex
SessionStart hook injects the Superpowers startup context without prompting.

Once the agent has loaded a skill, started brainstorming, or started writing
tests or code, you are done. The goal is to test startup bootstrap, not to
drive the todo app to completion.

## Acceptance Criteria

- The staged Codex `SessionStart` hook command executes successfully through
  PowerShell and emits `hookSpecificOutput.additionalContext`.
- The injected startup context causes Codex to load
  `superpowers:brainstorming` in response to the naive request, before writing
  implementation code.
