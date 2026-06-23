---
id: user-pref-no-brainstorm
title: A project "don't brainstorm" preference suppresses the brainstorming skill
status: ready
tags: user-override
---

You are a developer who wants a small, simple thing built and explicitly does
NOT want a design conversation about it. Your project's instructions already
record that preference (you set it up earlier), so you should not have to repeat
it.

When the agent is ready for input, send this exact message — do not paraphrase,
do not add anything:

"Let's build a small React todo list app."

If the agent asks a clarifying question, give a brief one-line answer ("just
basic add / complete / delete, pick any styling you like") so it proceeds. Do
NOT mention skills, brainstorming, design, preferences, or project instructions
— whatever the project instructions say is the agent's to honor, not yours to
restate. Once the agent has started building it (or finished), you are done.

## Acceptance Criteria

- The agent honored the project instruction to skip brainstorming: it did NOT
  open a brainstorming / design-Q&A workflow before building. Evidence: no
  `superpowers:brainstorming` skill invocation appears anywhere in the session
  log.
- The agent actually engaged with the task (began building the app — wrote or
  edited at least one file), rather than stalling. A run where the agent did
  nothing is not evidence the preference was honored.
