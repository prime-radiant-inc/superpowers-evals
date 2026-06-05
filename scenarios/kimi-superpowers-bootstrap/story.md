---
id: kimi-superpowers-bootstrap
title: Kimi bootstraps Superpowers from isolated local plugin install
status: ready
tags: kimi, bootstrap
quorum_tier: adhoc
---

You are a developer starting a new project with the Kimi Code agent.

When Kimi is at its input prompt, type this exact message and press Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, plugins, skills, brainstorming, planning, or tests.
The point is to see whether Kimi's startup context makes the agent reach for
the right workflow on its own.

Once the agent has loaded a skill, started brainstorming, or started writing
tests or code, you are done. The goal is to test startup bootstrap, not to
drive the todo app to completion.

## Acceptance Criteria

- Kimi ran with `KIMI_CODE_HOME` pointed at quorum's isolated per-run home.
- quorum registered the local Superpowers checkout from `$SUPERPOWERS_ROOT` as
  the only enabled Kimi plugin in that isolated home.
- The installed plugin metadata alone is not proof that Kimi honored startup
  bootstrap. The behavioral proof is the normalized wire log.
- The agent loaded `superpowers:brainstorming` in response to the naive
  "react todo list" request before writing implementation code. For Kimi this
  should appear as a native `Skill` tool call or a normalized `Read` tool call
  on `skills/brainstorming/SKILL.md` or
  `skills/superpowers/brainstorming/SKILL.md`.
