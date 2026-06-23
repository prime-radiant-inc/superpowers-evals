---
id: user-pref-spec-location
title: A spec-location preference redirects where brainstorming writes the design doc
status: ready
tags: user-override
---

You are a developer with a project convention for where design docs live. You
want a small feature designed.

When the agent is ready, send this exact message — do not paraphrase:

"Let's design a simple URL-shortener service — take a long URL, return a short
code, and redirect on lookup."

Engage naturally so the agent can run its design process: answer its clarifying
questions briefly (one line each, your judgment on specifics), and when it
presents a design and asks for approval, APPROVE it ("looks good, go ahead and
write it up") so it proceeds to write the design document. Do NOT mention skills,
specs, file locations, `docs/`, or preferences — the project instructions carry
the location convention. Once the agent has written a design document to disk,
you are done.

## Acceptance Criteria

- The agent wrote the design document to the location the project instructions
  specify (`docs/specs/`), NOT the skill's built-in default
  (`docs/superpowers/specs/`). Evidence: a markdown file exists under
  `docs/specs/` and none under `docs/superpowers/specs/`.
