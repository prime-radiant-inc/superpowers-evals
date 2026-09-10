---
id: diagnosing-session-discovery
title: Locate and inspect a remembered native session without starting a full diagnosis
status: ready
tags: diagnosing-superpowers,session-discovery
quorum_max_time: 8m
---

You are checking whether the Coding-Agent can discover one earlier conversation
from the native history already installed in its isolated home. This is a
discovery-only task. Do not ask it to modify the small repository in its working
directory.

When the Coding-Agent is ready, select the exact opening for its harness below
and send it as one message. Preserve the wording and do not add the harness name,
a session id, a filesystem path, or search advice.

For Claude, send exactly:

"On June 5, 2026, around 17:00 UTC, I asked you to create hello.txt containing
the word hi. Please find that earlier conversation and establish what the
file-writing tool did and whether it succeeded.

Use diagnosing-superpowers only to locate and inspect the session. Give me the
session id and path, what I asked, and the tool action and result that establish
the answer, with source locations. Stop there without running the full
diagnosis."

For Codex, send exactly:

"On June 2, 2026, around 21:45 UTC, I asked you to create hello.txt containing
hi with no other content. Please find that earlier conversation and establish
what the tool verification showed about its exact bytes.

Use diagnosing-superpowers only to locate and inspect the session. Give me the
session id and path, what I asked, and the tool action and result that establish
the answer, with source locations. Stop there without running the full
diagnosis."

For Pi, send exactly:

"On August 5, 2026, around 23:50 UTC, I asked for a minimal Express
authentication POC with JWT tokens expiring after 24 hours. Please find that
earlier conversation and establish what the existing health route returned when
you inspected app.js.

Use diagnosing-superpowers only to locate and inspect the session. Give me the
session id and path, what I asked, and the tool action and result that establish
the answer, with source locations. Stop there without running the full
diagnosis."

If the Coding-Agent asks for identifying information, reply once: "Use the cue
and time window in my request." Do not reveal a path, id, expected result,
record format, parser, or candidate. Otherwise respond neutrally without
confirming whether any proposed answer is correct.

Stop the run when the Coding-Agent delivers its discovery result or states a
specific limitation that prevents delivery. Do not ask it to try another search
or continue into the full diagnosis.

## Acceptance Criteria

- The Coding-Agent invoked the installed `diagnosing-superpowers` skill during
  this run. Evidence comes from the normalized trajectory's native skill load
  or an equivalent read of that skill's `SKILL.md`.
- The Coding-Agent delivered a discovery response containing a session identity
  and path, the recovered human request or requests, the requested tool action
  and result, and source locations; or it delivered a specific limitation that
  explains which of those items could not be recovered.
- The Coding-Agent stopped at discovery and did not start the full diagnosis
  workflow or ask the driver to approve one.

These criteria cover exposure and delivery mechanics. They do not establish
that the selected identity, recovered claims, or citations are correct. The
operator's independent offline review and private answer key decide discovery
correctness after the run.
