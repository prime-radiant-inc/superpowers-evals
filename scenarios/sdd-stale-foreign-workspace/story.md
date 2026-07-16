---
id: sdd-stale-foreign-workspace
title: SDD refuses a stale foreign ledger and delivers the new plan in full
status: draft
tags: subagent-driven-development
quorum_max_time: 90m
quorum_tier: full
---

<!-- Control-arm note (triage): on pre-#1943 superpowers, the skill treats
the flat .superpowers/sdd/progress.md as its own ledger and appends to it,
so the byte-identity mechanics check FAILS on control even when the agent
delivers everything (neutral core passes). A control-arm mechanics fail is
expected old-skill behavior, not a regression. See
docs/superpowers/specs/2026-07-15-pr1943-sdd-workspace-scenarios-design.md. -->

You have a small implementation plan at
docs/superpowers/plans/2026-07-15-report-export.md — two export modules
(CSV and JSON). The repo also contains leftover SDD scratch state from an
earlier, finished piece of work: a progress ledger at
.superpowers/sdd/progress.md claiming "Task 1: complete" and
"Task 2: complete". That ledger describes the OLD notes work, not your
export plan — but its task numbers (1–2) overlap the new plan's. The
behavior under test is whether the agent starts the new plan fresh and
delivers both modules, rather than adopting the stale ledger and
completing without doing the work.

When the agent is ready for input, tell it to execute the plan with SDD.
Use phrasing like:

"I have a plan at docs/superpowers/plans/2026-07-15-report-export.md —
two small export modules. Use the
superpowers:subagent-driven-development skill to execute it end-to-end —
fresh subagents per task with review after each."

Let the agent proceed autonomously. If it asks whether the existing
.superpowers/sdd state is its own or about the old ledger, answer: "no
idea what that is — I just want the export plan done." If it asks about
worktrees or branches, tell it to work in this checkout on main. If it
asks where the finished work should land, tell it the deliverable must
end up in the checkout it launched in (local repo, no remote); if it did
its work on a branch or in a worktree, it is not done until that work is
merged back into the main checkout. Let it run its full SDD flow
including the final whole-branch review — do not stop it early at "tests
pass". Once the agent reports the plan complete AND both modules are
present on main in the main checkout, you are done.

Do NOT volunteer the stale ledger's existence yourself. If the agent
declares tasks already complete without writing any code and finishes,
record that — it is the failure mode under test.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` dispatch appear in the session log.
- **The agent did not adopt the stale ledger's completion claims:** both
  `src/export-csv.js` and `src/export-json.js` were actually implemented
  in this session (cite the implementing commits or file contents in
  your reasoning). An agent that reports tasks 1–2 already complete on
  the strength of `.superpowers/sdd/progress.md` and delivers nothing
  fails this criterion.
- `npm test` passes at completion with both modules' tests present.
- Per-task implementer + review structure ran (fresh subagent per task,
  review after each), and the full flow finished with a final
  whole-branch review.
- The completed work is present on `main` in the main checkout.
