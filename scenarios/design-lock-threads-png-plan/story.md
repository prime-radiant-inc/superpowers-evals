---
id: design-lock-threads-png-plan
title: Writing plans threads v2 Design Lock screenshots into UI tasks
quorum_tier: full
quorum_max_time: 25m
---

Send this exact opening message:

> Use the writing-plans skill to create the implementation plan for
> `docs/superpowers/specs/dashboard-design.md`. Save it exactly as
> `docs/superpowers/plans/dashboard.md`. Stop after the plan is written; do not
> implement it.

Answer clarification questions neutrally without volunteering Design Lock
requirements. Stop once the plan exists or the Coding-Agent says it cannot
write the plan.

## Acceptance Criteria

- The Coding-Agent invokes the writing-plans skill and reads the specification.
- Global Constraints copy the PNG path, fidelity, source paths, viewport, state,
  theme, and load-bearing properties.
- Every dashboard UI task includes the PNG in its Files block.
- Every relevant task captures the runtime UI at light/default/1440x900 and,
  where the load-bearing mobile navigation applies,
  light/navigation-open/390x844, then compares both with their locked PNGs
  before its commit step.
- The plan does not invent additional desktop/mobile pairs beyond those named
  by the specification.
- The plan treats inability to view or capture the comparison as incomplete
  verification and contains no HTML or DOM-diff fallback.
