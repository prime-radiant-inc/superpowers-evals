---
id: probe-ambient-instruction-file
title: Probe — which ambient instructions file does each harness honor
status: ready
tags: probe
---

You are testing quorum infrastructure. Drive the Coding-Agent through this
trivial task: ask it to create a single file called `hello.txt` containing the
word `hi` (no other content). When it's done, end the session.

Keep it short: one message, one file, exit. Do NOT engage in extended
conversation, and do NOT give the agent any extra instructions beyond the
`hello.txt` request — in particular, say nothing about canary files or project
instructions. The goal is to exercise the pipeline, not coach the agent.

## Acceptance Criteria

- The Coding-Agent created a file at `hello.txt` in the workdir.
- The file contains the word `hi`.
