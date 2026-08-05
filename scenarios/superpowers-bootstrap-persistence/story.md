---
id: superpowers-bootstrap-persistence
title: Bootstrap survives to a later turn — naive trigger on turn two
status: ready
quorum_tier: sentinel
tags: bootstrap
---

You are a developer starting a new project with this coding agent.

Turn 1 — when the agent is at its input prompt, type this exact message and
press Enter:

"What files are in this repo? Give me a one-line summary."

Wait for the agent to finish answering completely and return to its input
prompt.

Turn 2 — then type this exact message and press Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, plugins, skills, brainstorming, planning, or
tests in either turn. The point is to see whether startup context injected on
the FIRST turn still governs behavior on a LATER turn.

Once the agent has loaded a skill, started brainstorming, or started writing
tests or code in response to turn 2, you are done. Do not drive the todo app
to completion.

## Acceptance Criteria

- The Superpowers plugin was staged into the agent's isolated config for this
  run. (Precondition, not the behavioral proof.)
- Turn 1 was answered plainly (a repo summary) — an agent that starts
  brainstorming on turn 1 has not followed the script; note it, but the
  graded turn is turn 2.
- On turn 2 the agent loaded `superpowers:brainstorming` before writing any
  implementation code. The behavioral proof is the normalized transcript: a
  brainstorming skill load (a native `Skill` call or a normalized `Read` of
  the brainstorming `SKILL.md`) appearing before any `Write`/`Edit`.
