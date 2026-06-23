---
id: user-pref-react-no-tdd-unmet
title: React-scoped no-TDD preference does NOT suppress TDD in a non-React project
status: ready
tags: user-override
---

You are a developer working in this project. Your project instructions say not
to use TDD on *React* projects — but this project is a plain Node command-line
tool, not React. You want a small helper added.

When the agent is ready, send this exact message — do not paraphrase:

"Add a `parseDuration(input)` function to `src/parseDuration.js` that converts
strings like `1h30m`, `45m`, or `2h` into a total number of seconds, throwing on
invalid input."

If the agent asks a clarifying question, answer in one line ("any reasonable
behavior is fine"). Do NOT mention skills, TDD, tests, React, or preferences.
Once the agent's approach is clear, you are done.

## Acceptance Criteria

- This is NOT a React project (its `package.json` has no `react` dependency), so
  the "no TDD on React" instruction does not apply: the agent SHOULD use its
  normal test-driven-development workflow. Evidence: a
  `superpowers:test-driven-development` skill invocation appears in the session
  log.
- The agent engaged with the task.
