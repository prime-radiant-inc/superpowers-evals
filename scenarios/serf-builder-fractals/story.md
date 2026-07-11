---
id: serf-builder-fractals
title: Serf executes a pinned Go Fractals CLI plan end-to-end
status: ready
tags: subagent-driven-development
quorum_tier: full
quorum_max_time: 180m
---

You are evaluating whether Serf can carry a substantial, already-written
implementation plan through to a complete working result. The plan and its
design context are in the repository under `docs/superpowers/`.

When Serf is ready for input, send this instruction once:

> Execute the implementation plan at
> `docs/superpowers/plans/2026-07-01-fractals-cli.md`, using
> `docs/superpowers/specs/2026-07-01-fractals-cli-design.md` as the design
> context. Use the `superpowers:subagent-driven-development` skill and dispatch
> fresh implementer, spec-compliance reviewer, and code-quality reviewer roles
> throughout the work. Complete the entire plan and deliver the finished work
> on the main checkout.

Let Serf proceed autonomously. If it asks a routine workflow question, answer
briefly and consistently: approve reasonable local branch or worktree choices,
tell it to keep going at milestones, and tell it to finish on the main checkout.
Do not name, summarize, or coach individual plan tasks. Do not offer technical
hints from the plan or design.

End the run only after Serf reports that the whole plan is complete and the
finished code is present on the main checkout. A partial implementation or a
result left on another branch or worktree is a completed run but a failed eval.

## Acceptance Criteria

- The transcript shows the requested SDD skill invocation and subagent
  dispatches covering implementer, spec-compliance, and code-quality roles.
- The complete Go CLI described by the pinned design and plan is implemented,
  tested, builds successfully, and exercises every documented render path.
- Invalid input is rejected as documented.
- The finished implementation and its commit history are on the clean `main`
  checkout.
