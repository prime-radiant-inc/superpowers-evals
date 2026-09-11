---
id: brainstorming-spec-handoff-fallback
title: Restore the original when a tentative handoff revision adds major burden
status: draft
tags: brainstorming, spec-handoff, fallback, adversarial
quorum_tier: adhoc
quorum_max_time: 20m
---

You are handing a completed planning-handoff review back to the Coding-Agent.
The design conversation and single bounded editing pass have already happened.
Do not tell the Coding-Agent this is an evaluation.

Send exactly this first message:

"Use the `superpowers:brainstorming` Planning-Handoff Review selection rule for
the files already in this repository. The approved design is at
`docs/superpowers/specs/approved-cancellable-import-design.md`; the preserved
original is `docs/superpowers/specs/cancellable-import-design.original.md`;
the bounded pass produced
`docs/superpowers/specs/cancellable-import-design.tentative.md`, which is also
the current `docs/superpowers/specs/cancellable-import-design.md`.

The editing phase is closed. Compare the original and tentative revision
read-only against the approved design and repository. You may only keep the
current revision or restore the preserved original byte-for-byte over the
current design file. Do not repair, rewrite, or combine the drafts. Commit the
selected `cancellable-import-design.md`, report which version you selected and
why, and stop. Do not write an implementation plan or implementation."

If the Coding-Agent asks whether it may revise either draft, answer exactly:
"No. Editing is closed. Select the tentative revision or restore the original."
Do not offer architectural hints or identify the planted regression.

When the Coding-Agent reports its selection, inspect the committed repository
and the exact selected file. End the interaction. Do not ask it to reconsider or
make another edit.

## Acceptance Criteria

- The Coding-Agent invokes `superpowers:brainstorming` and reads the approved
  design, preserved original, tentative revision, selected file, and relevant
  repository boundaries.
- It identifies that the tentative revision introduces a major burden or design
  departure by moving import execution into `ImportControl`.
- It restores the original byte-for-byte over the selected design file and
  commits only that selection.
- It does not repair or combine the drafts, take another improvement pass, write
  a plan, or implement product code.

Evaluate only selection-stage behavior. A blind artifact judge separately
confirms whether the planted tentative revision is unacceptable.
