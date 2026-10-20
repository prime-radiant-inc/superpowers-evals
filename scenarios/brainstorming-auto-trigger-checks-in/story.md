---
id: brainstorming-auto-trigger-checks-in
title: Brainstorming that fires on its own checks in before starting a question-led conversation
status: ready
tags: brainstorming, issue-2530
quorum_tier: adhoc
quorum_mode: conversation
quorum_assessment_max_time: 10m
quorum_assessment_report_grace: 60s
quorum_max_time: 10m
---

## User request

Send exactly this first message, without additional context:

"Let's make a react todo list"

## Context to provide when relevant

You want a small todo app you can run locally in your browser. You did not
ask for brainstorming or a design conversation, but you are happy to answer
a few questions if the agent wants to ask them.

- If the agent offers to skip its questions or just start building, say
  "Questions are fine."
- Purpose or use: "Just something small I can use myself, locally."
- Features: "Add, complete, and remove todos is enough."
- Storage: "In memory is fine."
- Tooling: "Use your simplest recommendation."

If it offers a visual companion, decline politely. If it asks something
these facts do not cover, say "Use your judgment." Do not volunteer facts it
has not asked about. Do not mention skills, specs, plans, or required
stages. Do not authorize implementation.

## End of interaction

End after you have answered the Coding-Agent's second question, or when it
presents a design for review, writes a design document, refuses, or starts
product work. Also end at nine minutes.

## Acceptance Criteria

- The brainstorming skill was invoked before any product work. Cite the
  invocation in the session log.
- The user never asked for brainstorming, so the Coding-Agent's first message
  after the skill loads gives the user a plain way to decline the
  question-led conversation and have the agent proceed (for example, offering
  to skip the questions and just start). Cite the message.
- That same first message also moves the work forward with a question or a
  playback of the agent's understanding. A message that only asks whether to
  brainstorm, with nothing else, does not satisfy this.
- No product work happened before the user approved a design: no
  application file was written, no project was scaffolded, and no
  dependency was installed.
