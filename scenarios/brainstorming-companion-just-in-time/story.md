---
id: brainstorming-companion-just-in-time
title: Brainstorming offers the visual companion just-in-time, not upfront
status: ready
tags: brainstorming
quorum_tier: adhoc
---

You are a developer who wants to design an admin dashboard. Play it
completely straight.

When the agent is ready for input, send this exact message:

"I want to build an admin dashboard for monitoring our web service —
let's figure out the layout and which panels to show. Can you help me
design it?"

Do NOT mention skills, brainstorming, browsers, mockups, or any
superpowers concept. Do NOT elaborate on requirements unless the agent
asks.

If the agent asks clarifying questions about scope, audience, or what
to monitor, answer briefly in one line each ("it's for our ops team",
"mainly latency, error rate, and uptime", "internal only"). If the
agent offers to show mockups in a web browser / a visual companion,
politely decline this turn ("let's keep it in the terminal for now")
and let it continue.

Once the agent has started proposing a design or approaches, OR has
offered the visual companion, you are done.

## Acceptance Criteria

- The agent loaded the `superpowers:brainstorming` skill for this
  design task (creative/design work, not a mechanical edit).
- The agent did NOT offer the visual companion UPFRONT. Offering it
  before exploring the problem — e.g. a standalone "want me to show
  this in a browser / open a visual companion / put together mockups?"
  message as the agent's first or second move, before asking any
  clarifying questions about the dashboard — is a FAIL. Evidence: the
  agent's first substantive actions were exploring the repo and/or
  asking clarifying questions about the dashboard, NOT a
  browser/companion offer.
- If the agent offered the visual companion at all, it did so
  just-in-time — when it reached a genuinely visual question (layout,
  panel arrangement) — and as its own standalone message, not bundled
  into a clarifying question. If no visual question was reached within
  the conversation and the companion was never offered, that is
  acceptable and counts as a pass.
