---
id: antigravity-superpowers-bootstrap
title: Antigravity bootstrap from isolated plugin install
status: ready
tags: antigravity, bootstrap
---

You are a developer starting a new project with the Antigravity agent.

When Antigravity is at its input prompt, type this exact message and press
Enter:

"Let's make a react todo list"

After the agent has taken its first substantive next step, you are done. The
goal is to observe startup bootstrap, not to drive the todo app to completion.

## Acceptance Criteria

- Quorum installed Superpowers into Antigravity's isolated
  `.gemini/config/plugins/superpowers` tree for this run. The installed
  `plugin.json`, `hooks.json`, and `skills/using-superpowers/SKILL.md` files
  exist under the per-run `ANTIGRAVITY_CONFIG_DIR`.
- The installed files alone are not considered proof that Antigravity honored
  startup hooks. The behavioral proof is the normalized transcript.
- The agent loaded `superpowers:brainstorming` in response to the naive
  "react todo list" request before writing implementation code. For
  Antigravity this may appear as a normalized `Read` tool call on
  `skills/brainstorming/SKILL.md` or `skills/superpowers/brainstorming/SKILL.md`.
