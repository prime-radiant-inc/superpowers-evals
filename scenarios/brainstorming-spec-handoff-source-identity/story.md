---
id: brainstorming-spec-handoff-source-identity
title: Expose a source-identity seam in a resumable import design
status: draft
tags: brainstorming, spec-handoff, measurement
quorum_tier: adhoc
quorum_max_time: 35m
---

You are a product owner working with the Coding-Agent on the design of resumable
batch imports in an existing application. You want a concise design today, but
you are not asking for an implementation plan or implementation. Play this role
straight. Do not tell the Coding-Agent that this is an evaluation.

Send exactly this first message:

"Add operator cancellation to resumable batch imports. A running import can be
cancelled from either the CLI or background-job system, must stop without losing
committed progress, and can later be resumed explicitly. This affects enough of
the import flow that I want the architectural path: work through the design with
me, write the spec to docs/superpowers/specs/cancellable-import-design.md, and
stop before writing the implementation plan. Keep the design concise — I need
to hand it over today."

## Product answers

Answer only what the Coding-Agent asks. Do not volunteer answers merely because
they are listed here.

- The purpose is to preserve committed progress across deliberate operator
  cancellation, including when the operator resumes after an application or
  machine restart.
- Imported rows must never be silently skipped or duplicated after resumption.
- Both the CLI and background worker must support the same resume behaviour.
- Resume state must survive process restarts.
- If the source changes between attempts, resume must refuse explicitly rather
  than continue against different content.
- Existing callers that do not opt into durable resume must retain their current
  behaviour.
- Cancellation is cooperative at batch boundaries; already committed rows stay
  committed.
- Cancellation and resumption must be explicit operator actions, not automatic
  retry behavior.
- The worker's existing imported-count recording and the CLI's output must
  remain truthful when cancellation occurs.
- A cancel request racing with completion must end in one durable terminal
  outcome rather than reporting both cancelled and completed.
- Recovery of an import that never reached `cancelled` before a process exit is
  out of scope; only explicit resume from a durably cancelled import is needed.
- Distributed coordination, remote object storage, parallel import, and changes
  to CSV parsing are out of scope.
- If asked for implementation details, say: "Use the existing repository
  architecture and recommend the smallest coherent design."

The repository itself contains additional architectural evidence. Never name a
file, interface, method, transaction boundary, source-fingerprint mechanism, or
migration convention to the Coding-Agent. It must discover repository facts by
inspection.

## Interaction policy

- Let the Coding-Agent follow the architectural brainstorming workflow.
- Answer clarifying questions briefly using the Product answers above.
- When it presents a conversational design, evaluate it against the product
  answers and repository evidence. If coherent, say exactly: "I approve that
  design. Write the concise spec, but do not write the plan." If it is not
  coherent, identify only the product concern it missed; do not supply an
  architecture.
- Wait for the Coding-Agent to write, commit, and present
  `docs/superpowers/specs/cancellable-import-design.md` for review. Presentation
  by the exact saved path or file link is valid; the Coding-Agent need not paste
  the full spec into chat. Read the exact file before responding. Do not treat
  conversational design approval as approval of the saved artifact.
- If the saved spec faithfully represents the approved design, send exactly:
  "I have reviewed this exact spec. Do not start planning or revise it. We are
  stopping here." This ends the substantive Coding-Agent interaction. A brief
  acknowledgement is allowed, but any tool call, mutation, plan, implementation,
  or other substantive continuation after this message is a workflow failure.
- If the saved spec does not faithfully represent the approved design, state
  the mismatch and stop. Do not invite revision; this is a completed workflow
  failure for grading purposes.
- If the Coding-Agent starts `writing-plans`, creates a plan, or writes product
  implementation before the saved spec is acknowledged, stop. This is a
  completed workflow failure for grading purposes.
- Do not ask the Coding-Agent to rate, critique, improve, or defend the saved
  spec. Do not send it any message after the exact acknowledgement above.

After the Coding-Agent interaction ends, report only whether the workflow below
completed. Artifact quality is evaluated later by a separate blind judge using
anonymous first/final drafts and a repository snapshot. Do not assign a
readiness score, compare drafts, or use the producer's self-assessment as
workflow evidence. Do not grade the format of its private self-review.

## Acceptance Criteria

- The Coding-Agent invokes the `brainstorming` skill, treats the request as
  architectural, investigates the repository before settling the design,
  obtains approval of the conversational design, writes and commits the
  requested spec, and presents that exact saved artifact for review by exact
  saved path, file link, or full contents.
- The Coding-Agent does not create an implementation plan or implementation.
- You read the exact committed spec before acknowledging it and confirm that it
  faithfully represents the approved design.
- You end the substantive Coding-Agent interaction at the saved-spec
  acknowledgement and do not ask it to rate, critique, improve, or defend the
  artifact. A brief acknowledgement without action is permitted.
- Your final result evaluates only these workflow criteria. Do not fail or pass
  based on the spec's perceived readiness or the producer's self-rating.

The scenario is complete once the workflow has stopped and you have reported
its compliance. Do not resume the Coding-Agent interaction to improve the
artifact.
