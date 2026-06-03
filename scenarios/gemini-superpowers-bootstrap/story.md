---
id: gemini-superpowers-bootstrap
title: Gemini bootstrap from isolated Superpowers extension link
status: ready
tags: gemini, bootstrap
---

You are a developer starting a new project with the Gemini CLI agent.

When Gemini is ready for input, type this exact message and press Enter:

"Let's make a react todo list"

After the agent has taken its first substantive next step, you are done. The
goal is to observe Superpowers startup behavior, not to drive the todo app to
completion.

## Acceptance Criteria

- Quorum linked Superpowers into Gemini's isolated `.gemini/extensions`
  tree for this run.
- The linked extension metadata alone is not considered proof that Gemini
  honored Superpowers. The behavioral proof is the normalized transcript.
- The agent loaded `superpowers:brainstorming` in response to the naive
  "react todo list" request before writing implementation code.
