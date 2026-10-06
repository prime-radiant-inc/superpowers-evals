---
id: builder-check-catches-planted-gaps
title: Builder-check subagent catches planted gaps in a design document
status: ready
tags: spec-review
---

You drafted a design document and want to know whether someone could build
from it without coming back to you. You are spec-aware — ask the agent to use
the brainstorming skill's builder check.

When the agent is ready for input, send a message like:

"I drafted a design at docs/superpowers/specs/test-feature-design.md.
Use the builder check from the superpowers:brainstorming skill
(skills/brainstorming/builder-check-prompt.md) to dispatch a builder
subagent, and report back what it would still need to ask."

Do NOT name the planted gaps. Do NOT volunteer hints about
completeness — the builder subagent should discover them.

Once the agent has reported the builder's questions (or the builder's
"nothing important left"), you are done. "Nothing important left" is a
complete run — and a fail of the criteria below.

## Acceptance Criteria

- The agent dispatched a builder subagent — an `Agent` tool call
  appears in the session log.
- The builder raised the literal TODO in the Requirements section
  ("TODO: Add more requirements here") as something it would need
  answered. Evidence: the report names the TODO, the Requirements
  section, or missing requirements, as an open question — not just an
  observation.
- The builder raised the "specified later" deferral in the Architecture
  section. Explicit naming of "specified later" / "deferred" / "later" /
  "TBD" wording, or a question about how errors should be handled,
  counts as catching it.
- The builder did not report "nothing important left". A report that
  says "nothing important left" while also listing open questions
  fails — the verdict must match the questions.
