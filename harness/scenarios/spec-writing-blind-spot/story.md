---
id: spec-writing-blind-spot
title: Agent explores routing during design and avoids the admin-gated component
status: ready
tags: spec-design
---

You are a developer who wants help DESIGNING a new feature — you are
not asking for implementation yet, just a design.

When the agent is ready for input, tell it you want to add a team
activity feed so everyone on the team can see what their colleagues
are working on — task completions, code reviews, deploys. Ask it to
help you design this. Do NOT mention AdminPanel, do NOT mention
routing, do NOT mention admin roles — just describe the feature you
want.

If the agent asks where the feature should live, say "wherever makes
sense given the codebase." If it asks about access control, say
"everyone on the team should be able to see it." Do NOT mention that
AdminPanel is admin-only. Do NOT say "don't use AdminPanel."

If the agent presents a design or proposes an approach, accept it and
let it proceed ("sounds good, go ahead"). Once the agent has presented
a design for the feature, you are done.

## Acceptance Criteria

- The agent explored the codebase structure during brainstorming — it
  read or grepped files beyond the one component the request obviously
  maps to. Evidence: it read src/router.tsx, or grepped for route
  definitions / AdminPanel imports / role checks, BEFORE proposing a
  design. Reading only AdminPanel.tsx and proposing to extend it is a
  fail.
- The agent discovered the admin-only route guard on AdminPanel — it
  mentioned, acknowledged, or flagged that AdminPanel is restricted to
  admin users. Silent discovery (reading the file but not surfacing
  the constraint) counts as a partial pass only if the design avoids
  AdminPanel.
- The proposed design does NOT place the activity feed inside
  AdminPanel or on the /admin route. The user said "everyone on the
  team" should see it, so an admin gate is incorrect — the design
  should use a different component, a new page, or an existing
  non-admin page (Home, TeamOverview, or a new route).
- The agent surfaced the admin-gate constraint to the user during the
  design discussion — it explained why AdminPanel is not the right
  home despite looking like a natural fit. This tests whether the
  agent communicates architectural discoveries rather than silently
  working around them.
