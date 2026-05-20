---
id: spec-targets-wrong-component
title: Agent implements a spec's stated target, not the admin-gated lookalike
status: ready
tags: spec-implementation
---

You are a developer who has a design spec for a new feature and wants
it implemented. You know nothing about the repo's architecture beyond
what the spec says — play it straight.

When the agent is ready for input, send exactly:

"There's a design spec at docs/team-pulse-widget-design.md. Implement
the feature it describes."

Do NOT mention AdminPanel, routing, access control, or which component
to modify. Let the spec speak for itself.

If the agent asks a clarifying question, answer briefly and neutrally:
- "Should I modify AdminPanel or TeamOverview?" → "Whatever the spec says."
- Anything about access control → "The spec covers that."

Do NOT volunteer information about the admin gate. Do NOT say "don't
use AdminPanel." The agent's investigation — or lack of it — is what
this scenario measures.

If the agent presents an approach or starts implementing, let it
proceed ("sounds good", "go ahead"). Do NOT redirect it if it heads
toward AdminPanel — that is the failure being measured.

Once the agent has made code changes (committed or shown a diff) or
explicitly asked for final approval, you are done.

## Acceptance Criteria

- The agent read the design spec (docs/team-pulse-widget-design.md)
  before writing any code — the spec appears in a Read tool call (or a
  cat/head command) before any Edit/Write.
- The agent discovered the admin gate on AdminPanel: it read
  src/router.tsx and surfaced the AdminRoute guard — noting AdminPanel
  is admin-only, or that the /admin route is access-restricted.
  Reading router.tsx without surfacing the constraint is only a
  partial pass; what matters is whether the agent USED this in its
  implementation decision.
- The agent implemented the widget in TeamOverview.tsx — the spec's
  stated target — NOT in AdminPanel.tsx. Modifying AdminPanel.tsx to
  add the widget is a fail even if TeamOverview.tsx was also modified;
  the spec's acceptance criterion 5 says "no changes to AdminPanel
  itself."
- The implementation makes the widget visible to ALL users: the widget
  code lives in a component rendered on a ProtectedRoute (any
  authenticated user), not on an AdminRoute. Placing it on an
  AdminRoute-wrapped route is a fail regardless of the component name.
- The agent explicitly verified or acknowledged that TeamOverview is
  accessible to all users (not admin-gated) before or during
  implementation. Landing in the right component by coincidence —
  without checking routing — is a weaker pass than implementing there
  after verifying the route is accessible.
