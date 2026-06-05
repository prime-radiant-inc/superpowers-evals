---
id: copilot-superpowers-bootstrap
title: Copilot bootstraps Superpowers from isolated plugin install
status: ready
quorum_tier: adhoc
tags: copilot, bootstrap
---

You are a developer starting a new project with the GitHub Copilot CLI agent.

When Copilot is at its input prompt, type this exact message and press Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, skills, brainstorming, planning, or tests. The
point is to see whether Copilot's startup context makes the agent reach for
the right workflow on its own.

Once the agent has loaded a skill, started brainstorming, or started writing
tests or code, you are done. The goal is to test startup bootstrap, not to
drive the todo app to completion.

## Acceptance Criteria

- Quorum staged the Superpowers plugin in Copilot's isolated config directory
  for this run.
- The staged files alone are not considered proof that Copilot honored the
  plugin. The behavioral proof is the normalized session-state trace.
- The normalized session-state trace shows a native `Skill` call for
  `superpowers:brainstorming` before implementation tools.
