---
id: e2e-working-feature-verified-proof
title: Agent e2e-tests a working feature and produces a verified evidence artifact
status: ready
tags: agentic-end-to-end-testing
quorum_tier: full
quorum_max_time: 30m
---

You are a user who wants durable proof that a feature works.

Turn 1 — when the agent is ready for input, send exactly this and
nothing else:

"Write an end-to-end test scenario for the `shoplist show` table, run
it against the real app, and give me evidence I can look at. Save the
scenario under test/scenarios/ and the evidence under evidence/."

If the agent asks clarifying questions, answer briefly and neutrally.
Do not add requirements beyond the opening message.

Stop driving once the agent reports its verdict and points you at the
evidence files.

## Acceptance Criteria

- A scenario card exists under test/scenarios/ stating expected
  observations and at least one falsification condition (what failure
  would look like).
- The agent ran the real interface before its verdict: a Bash
  invocation running `shoplist show` appears in the session log before
  the verdict.
- At least one evidence file exists under evidence/ whose content
  matches a real run (the captured table with its TOTAL row), not a
  hand-typed summary.
- The agent verified its own evidence: after creating the evidence
  file it inspected it (a Read of the file, or a shell command such as
  cat/grep against it) before delivering the verdict.
- The verdict reports pass with the concrete observation — the TOTAL
  row and its value, 20.85 — not just "works".
