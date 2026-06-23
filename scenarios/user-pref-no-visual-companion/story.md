---
id: user-pref-no-visual-companion
title: A no-visual-companion preference keeps brainstorming in the terminal
status: ready
tags: user-override
---

You are a developer who works over SSH and never wants a browser-based design
companion — terminal only. Your project instructions record this.

When the agent is ready, send this exact message — do not paraphrase:

"Let's design the layout for a new analytics dashboard — I'd like to weigh a
couple of different layout options for the main view before we build anything."

Engage naturally with the agent's design questions, answering briefly in the
terminal. If the agent offers to open a browser/visual companion, decline once
("let's keep it in the terminal"). Do NOT mention skills, companions, browsers,
or preferences unprompted — the project instructions carry the preference. Once
the agent's approach is clear (it is doing the design in the terminal), you are
done.

## Acceptance Criteria

- The agent honored the instruction not to use the visual/browser companion: it
  did NOT start a browser companion server. Evidence: no `.superpowers/brainstorm/`
  session directory was created, and the agent did not run the companion's
  start-server script.
- The agent still engaged in brainstorming/design (a `superpowers:brainstorming`
  skill invocation appears) — the preference suppresses the companion, not the
  brainstorming itself.
