---
id: sdd-same-plan-resume
title: SDD resumes its own interrupted plan from the scoped ledger without redoing task 1
status: draft
tags: subagent-driven-development
quorum_max_time: 90m
quorum_tier: full
---

<!-- Control-arm note (triage): on pre-#1943 superpowers, the skill looks
for the flat .superpowers/sdd/progress.md, finds nothing, and usually
redoes task 1 (mechanics + resume checks fail). But the old skill also
says to trust git log, and the task-1 commit is discoverable — a control
agent can legitimately recover and pass. Fail-LEANING on control, not
fail-by-construction; neither control outcome is a regression signal.
See docs/superpowers/specs/2026-07-15-pr1943-sdd-workspace-scenarios-design.md. -->

An earlier session started executing the plan at
docs/superpowers/plans/2026-07-15-report-export.md with
subagent-driven-development and was interrupted after finishing task 1
(CSV export — implemented, tested, reviewed clean, committed). Its SDD
workspace and progress ledger are still on disk. The behavior under test
is whether a fresh agent resumes at task 2 — trusting its own plan's
truthful ledger — instead of re-implementing task 1 from scratch.

When the agent is ready for input, ask it to pick the work back up. Use
phrasing like:

"An earlier session was executing
docs/superpowers/plans/2026-07-15-report-export.md with the
superpowers:subagent-driven-development skill and got interrupted. Please
pick it up and finish the plan — fresh subagents per task with review
after each."

Let the agent proceed autonomously. If it asks whether the ledger or
workspace is trustworthy, answer: "whatever the workspace says — you
left it there." If it asks about worktrees or branches, tell it to work
in this checkout on main. If it asks where the finished work should
land, tell it the deliverable must end up in the checkout it launched in
(local repo, no remote); work done on a branch or in a worktree is not
done until merged back into the main checkout. Let it run its full SDD
flow including the final whole-branch review — do not stop it early.
Once the agent reports the plan complete AND both modules are present on
main in the main checkout, you are done.

Do NOT tell the agent task 1 is already done — discovering that from its
own workspace is the behavior under test.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` dispatch appear in the session log.
- **The agent resumed at task 2:** it did not re-dispatch or re-implement
  task 1 (CSV export). Evidence: it acknowledged task 1 as complete from
  the ledger/git history, and no implementer subagent was dispatched for
  the CSV module. An agent that rebuilds `src/export-csv.js` from
  scratch fails this criterion even if the final code works.
- `src/export-json.js` was implemented in this session with its tests,
  and `npm test` passes at completion.
- Review structure ran for the work performed (task-2 review, final
  whole-branch review).
- The completed work is present on `main` in the main checkout.
