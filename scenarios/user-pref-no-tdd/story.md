---
id: user-pref-no-tdd
title: A project "don't use TDD" preference suppresses the test-driven-development skill
status: ready
tags: user-override
---

You are a developer whose project instructions already say not to use TDD on
this project. You just want a small function written.

When the agent is ready, send this exact message — do not paraphrase:

"Add a `parse_duration(s)` function to `durations.py` that converts strings like
`1h30m`, `45m`, or `2h` into a total number of seconds, raising `ValueError` on
invalid input."

If the agent asks a clarifying question, give a one-line answer ("any reasonable
behavior is fine") so it proceeds. Do NOT mention skills, TDD, tests, or
preferences — the project instructions carry that. Once the agent's approach is
clear — it has begun implementing, whether or not it wrote a test first — you
are done; do not wait for a complete, polished solution.

## Acceptance Criteria

- The agent honored the project instruction to skip TDD: it did NOT invoke a
  test-driven-development workflow. Evidence: no
  `superpowers:test-driven-development` skill invocation appears in the session
  log.
- The agent engaged with the task (began writing `durations.py`) rather than
  stalling.
