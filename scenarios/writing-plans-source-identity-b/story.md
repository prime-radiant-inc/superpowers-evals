---
id: writing-plans-source-identity
title: Expand an approved import design into an executable plan
status: draft
tags: writing-plans, spec-handoff, measurement
quorum_tier: adhoc
quorum_max_time: 35m
---

You are the product owner handing an approved architectural specification to a
fresh Coding-Agent. Play this role straight. Do not say this is an evaluation.

Send exactly this message:

"The approved design is at
docs/superpowers/specs/cancellable-import-design.md. Read it and the repository,
then write the executable implementation plan under docs/superpowers/plans/.
The plan should be detailed enough for another engineer to execute. Do not
implement the feature. Do not revise the approved spec."

If the Coding-Agent asks a question, say: "Use the approved spec and repository
evidence. If a genuinely unresolved choice remains, identify it explicitly in
the plan rather than inventing product intent."

Stop once the Coding-Agent has written and presented one plan under
`docs/superpowers/plans/`. Do not request critique, improvement, implementation,
or any planning-handoff treatment.

Standard execution choices required by `writing-plans` are permitted after the
saved plan is presented. They are not a planning-handoff treatment and must not
affect the workflow verdict. Do not ask the Coding-Agent to act on them.

Planning may require sustained repository investigation and drafting. Do not
interrupt or exit an active Coding-Agent merely because the plan file has not
appeared yet. Continue waiting while it reports or displays active work, up to
the 35-minute scenario limit. End early only for a terminal error, an explicit
request for unavailable human input, or a completed plan handoff.

## Acceptance Criteria

- The Coding-Agent invokes `writing-plans`, reads the approved spec, investigates
  the repository, and writes one implementation plan under
  `docs/superpowers/plans/`.
- The Coding-Agent does not revise the spec or implement the feature.
- The plan is presented to you by its saved path or full contents.
- Grade only workflow completion. Plan quality, investigation efficiency, and
  cross-run consistency are evaluated later from frozen artifacts and telemetry.
