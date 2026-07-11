---
id: 00-quorum-smoke-hello-world
title: Phase 2 smoke — Coding-Agent writes hello.txt
status: draft
tags: smoke
---

You are testing whether quorum's new-path dispatch works end-to-end.
Drive the Coding-Agent through this trivial task: ask it to
create a single file called `hello.txt` containing the word `hi` (no other
content). When it's done, end the session.

Keep it short: one message, one file, exit. Do not engage in extended
conversation. The goal is to exercise quorum pipeline, not the agent.

Invoke the Coding-Agent exactly once. Do not retry the Coding-Agent if it fails.
Report the first attempt's outcome.

## Acceptance Criteria

- The Coding-Agent created a file at `hello.txt` in the workdir.
- The file contains the word `hi`.
