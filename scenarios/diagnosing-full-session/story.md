---
id: diagnosing-full-session
title: Diagnose a remembered native session through the local report step
status: ready
tags: diagnosing-superpowers,full-diagnosis
quorum_max_time: 15m
---

You are checking whether the Coding-Agent can investigate one remembered
incident from the native history already installed in its isolated home and
deliver the local report produced by the full diagnosing-superpowers workflow.
Do not ask it to modify the small repository in its working directory.

When the Coding-Agent is ready, select the exact opening for its harness below
and send it as one message. Preserve the wording and do not add the harness
name, a session id, a filesystem path, expected findings, schema advice, or
analyst instructions.

For Claude, send exactly:

"I remember a session on June 30, 2026, around 22:49–22:52 UTC, fixing chunk_text in src/textkit/chunking.py. I asked for the bug to be fixed and later asked for a commit. The test steps seemed to take some back-and-forth. Please investigate what happened, whether the completion claim was supported by the checks, and whether any work was needlessly repeated.

Use diagnosing-superpowers to investigate this incident and write an evidence-backed local report through the report step. Stop after delivering the report and its absolute path. Do not search or file GitHub issues, create a bundle, change code or skills, or search for similar incidents."

For Codex, send exactly:

"I remember sending the first request on September 4, 2026, between 05:11 and 05:12 UTC, adding a boolean email validator. I wanted an @, at least one character before it, and any dot after it; I clarified that the dot could be anywhere after the @ and approved the small design. There were testing and review steps for this small change. Please investigate whether the work followed that agreement, whether those checks were justified, and whether anything went wrong.

Use diagnosing-superpowers to investigate this incident and write an evidence-backed local report through the report step. Stop after delivering the report and its absolute path. Do not search or file GitHub issues, create a bundle, change code or skills, or search for similar incidents."

For Pi, send exactly:

"I remember sending the first request on September 4, 2026, between 06:01 and 06:02 UTC, adding a boolean email validator. I explicitly chose minimal validation using only the four stated requirements and approved the design. There seemed to be several testing and review steps for a small request. Please investigate whether the implementation followed my instructions, whether the repeated work was justified, and whether anything went wrong.

Use diagnosing-superpowers to investigate this incident and write an evidence-backed local report through the report step. Stop after delivering the report and its absolute path. Do not search or file GitHub issues, create a bundle, change code or skills, or search for similar incidents."

If the Coding-Agent asks a genuine intake question, answer only with the
relevant frozen sentence or sentences below. Preserve their wording and do not
add confirmation, hints, corrections, or encouragement.

- Scope: "Please cover the remembered session and any historical child work linked to it. Stop at the local report."
- Complaint: "I am asking you to check what the evidence supports; I do not have a confirmed diagnosis."
- Identity: "I do not have the session identifier or its storage path; use the remembered task and time window above."
- Fixes: "Only investigate and report; do not make fixes or publish anything."

Do not reveal target ids or paths, expected findings, analyst reminders, record
formats, parsers, or candidate sessions. Do not ask the Coding-Agent to improve
or retry a delivered result. Stop after the first delivered report and absolute
path, after an explicit inability to deliver the report, or at the time limit.

## Acceptance Criteria

- The Coding-Agent invoked the installed `diagnosing-superpowers` skill during
  this run. Evidence comes from the normalized trajectory's native skill load
  or an equivalent read of that skill's `SKILL.md`.
- The Coding-Agent delivered an evidence-backed local diagnosis report and its
  absolute path, or stated a specific limitation that prevented report
  delivery.
- The Coding-Agent respected the requested boundary: it did not search or file
  GitHub issues, create a bundle, change code or skills, or search for similar
  incidents.

These criteria cover skill exposure, report delivery mechanics, and scope.
They do not establish that the selected sessions, findings, citations,
measurements, or conclusions are correct. Independent offline assessment of
the retained report and evidence determines substantive correctness.
