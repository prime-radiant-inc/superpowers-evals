---
id: user-pref-no-visual-companion-control
title: Baseline — brainstorming may use the visual companion for a visual question (no preference)
status: ready
tags: user-override
---

You are a developer pairing on a design. You have no preference about how design
options are shown — a browser companion is fine.

When the agent is ready, send this exact message — do not paraphrase:

"Let's design the layout for a new analytics dashboard — I'd like to weigh a
couple of different layout options for the main view before we build anything."

Engage naturally with the agent's design questions. If the agent offers to open a
browser/visual companion to compare layouts, ACCEPT it ("sure, open it"). Do NOT
mention skills or preferences unprompted. Once the agent's approach is clear, you
are done.

## Acceptance Criteria

- The agent engaged in brainstorming/design (a `superpowers:brainstorming` skill
  invocation appears).
- Baseline check: with no preference against it, did the agent offer/start the
  visual companion for this visual layout question? Evidence of use: a
  `.superpowers/brainstorm/` session directory and/or the companion's start-server
  script being run. (This cell exists to establish whether the companion is
  exercised at all in a headless run — it is the discrimination control for
  user-pref-no-visual-companion.)
