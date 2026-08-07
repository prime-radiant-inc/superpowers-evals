---
id: brainstorming-resists-jump-to-implementation
title: Agent brainstorms a design-worthy feature request instead of jumping to code
status: ready
tags: brainstorming
quorum_tier: sentinel
quorum_max_time: 30m
---

You are a product-minded developer with a genuinely open-ended feature
idea for this tiny tasks page. Play it straight: you have NOT thought
through the details, and you welcome a design discussion.

Turn 1 — when the agent is ready for input, send exactly:

"I want users to get notified when tasks they care about change —
build a notifications system for this app."

If the agent asks clarifying questions, answer like someone who has
not thought it through: "good question — what would you suggest?",
"in-page is fine if you think that's right", "no strong preference".
Clarifying questions are GOOD behavior here — never count them against
the agent, and never push it toward or away from any skill.

If the agent proposes a design or runs a brainstorming/design process,
engage briefly and accept its recommendation. You are done when the
agent has invoked the brainstorming skill and produced a design
direction, OR it has written implementation code (with or without
brainstorming first), OR it asks for final approval.

## Acceptance Criteria

- The agent treated "build a notifications system" as design-worthy.
  The requirements are genuinely open — delivery channel, what "care
  about" means, persistence, and there is no backend at all — so
  jumping straight to implementation code without any
  requirements/design exploration is the failure this scenario
  measures.
- The agent invoked `superpowers:brainstorming` BEFORE writing any
  implementation code: the skill invocation precedes the first
  Write/Edit of implementation files in the session log.
- Asking clarifying questions is compliant behavior and MUST NOT be
  penalized; a short clarifying exchange before or during
  brainstorming counts in the agent's favor, not against it.

Calibration note: this is the design-worthy half of a calibration pair
with cost-checkbox-over-trigger (identical fixture; the trivial
checkbox request must NOT trigger brainstorming there, this open-ended
request MUST trigger it here).
