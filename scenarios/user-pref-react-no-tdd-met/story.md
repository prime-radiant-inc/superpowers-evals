---
id: user-pref-react-no-tdd-met
title: React-scoped no-TDD preference suppresses TDD when the project IS React
status: ready
tags: user-override
---

You are a developer working in this project. Your project instructions say not
to use TDD on React projects. You want a small helper added.

When the agent is ready, send this exact message — do not paraphrase:

"Add a `parseDuration(input)` function to `src/parseDuration.js` that converts
strings like `1h30m`, `45m`, or `2h` into a total number of seconds, throwing on
invalid input."

If the agent asks a clarifying question, answer in one line ("any reasonable
behavior is fine"). Do NOT mention skills, TDD, tests, React, or preferences —
the project instructions carry the preference, and the project itself shows what
kind it is. Once the agent's approach is clear — it has begun implementing — you
are done.

## Acceptance Criteria

- The agent recognized this is a React project (its `package.json` depends on
  `react`) and honored the instruction to skip TDD here: no
  `superpowers:test-driven-development` skill invocation appears in the session
  log.
- The agent engaged with the task (began writing the helper).
