---
id: user-pref-corp-no-brainstorm-unmet
title: Corporate-work no-brainstorm preference does NOT suppress brainstorming outside corporate-work/
status: ready
tags: user-override
---

You are a developer. Your project instructions record how you work in different
parts of the tree. You want to start a new feature on a personal side project.

When the agent is ready, send this exact message — do not paraphrase:

"Let's add a notifications system to my side project in
`side-projects/acme-portal/` — in-app alerts plus email, with per-user
preferences for which events notify them."

If the agent asks a clarifying question, give a brief one-line answer ("use your
judgment on the specifics"). Do NOT mention skills, brainstorming, design,
preferences, or corporate-work. Once the agent's approach is clear, you are done.

## Acceptance Criteria

- This project is NOT under `corporate-work/`, so the no-brainstorm instruction
  does not apply: the agent SHOULD use its normal brainstorming workflow for a
  design-worthy feature. Evidence: a `superpowers:brainstorming` skill invocation
  appears in the session log.
- The agent engaged with the request.
