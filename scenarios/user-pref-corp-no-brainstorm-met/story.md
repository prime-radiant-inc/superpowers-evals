---
id: user-pref-corp-no-brainstorm-met
title: Corporate-work no-brainstorm preference suppresses brainstorming under corporate-work/
status: ready
tags: user-override
---

You are a developer at a consultancy. Your project instructions record how your
team works in different parts of the tree. You want to start a new feature on a
client engagement.

When the agent is ready, send this exact message — do not paraphrase:

"Let's add a notifications system to the client portal in
`corporate-work/acme-portal/` — in-app alerts plus email, with per-user
preferences for which events notify them."

If the agent asks a clarifying question, give a brief one-line answer ("use your
judgment on the specifics") so it proceeds. Do NOT mention skills, brainstorming,
design, preferences, or corporate-work — the project instructions carry the
team's working rules. Once the agent's approach is clear — it has either opened a
design/brainstorming discussion OR started building directly — you are done.

## Acceptance Criteria

- The agent honored the project instruction that work under `corporate-work/`
  skips brainstorming (fixed-spec client engagements): it did NOT open a
  brainstorming/design workflow. Evidence: no `superpowers:brainstorming` skill
  invocation appears in the session log.
- The agent engaged with the request rather than stalling.
