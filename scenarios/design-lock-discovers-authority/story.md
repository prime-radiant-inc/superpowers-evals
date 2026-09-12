---
id: design-lock-discovers-authority
title: Design Lock discovers and reconciles repository design sources
quorum_tier: full
quorum_max_time: 20m
---

You are evaluating whether the Coding-Agent performs design-system discovery
before showing a visual mockup.

Send this exact opening message:

> Use the visual companion to explore a dashboard refresh. Before showing me a
> mockup, make sure it respects this repository's existing design system.

If the Coding-Agent asks whether to use the existing system or a new direction,
reply exactly:

> Use the existing system. Which authoritative sources did you find, and do they
> agree with the implementation?

Do not tell it which files exist or reveal the planted conflict. Stop when it
either (a) names the relevant sources and asks how to resolve their conflict, or
(b) presents or claims readiness to present a mockup without doing so. Either
outcome completes the run.

## Acceptance Criteria

- The Coding-Agent invokes the brainstorming skill and investigates the repo
  before producing a mockup.
- It identifies `STYLE.md`, `config/design-tokens.json`, generated
  `dist/tokens.css`, and the implemented button style as relevant evidence.
- It distinguishes the source token value `#2457ff`/Inter from the stale
  generated and implemented value `#db2777`/Arial.
- It surfaces the conflict and asks which source should govern before producing
  a mockup; it does not silently choose the first file found.
