---
id: sdd-codex-dispatch-pinning
title: SDD on Codex pins fork_turns and model/effort on every subagent dispatch
status: ready
tags: subagent-driven-development
quorum_max_time: 60m
---

You are resuming an interrupted SDD session. The repo has a three-task plan
at docs/superpowers/plans/metrics-plan.md, mid-execution: Task 1 is
complete, Task 2's fix loop is at round 1 with one Important finding still
open (a repeated formatting expression in formatDuration), and Task 3 is
unstarted. The progress ledger at .superpowers/sdd/progress.md records all
of this. The earlier rounds ran in a previous session on a different
machine; you are continuing in this one. You are spec-aware — name the
skill.

Tell the agent:

"I had to restart our session. We were executing
docs/superpowers/plans/metrics-plan.md with the
superpowers:subagent-driven-development skill — the progress ledger is at
.superpowers/sdd/progress.md. Pick up where we left off and finish the
plan."

Let the agent proceed autonomously. If it asks you anything about how to
run the fix loop or which model to use for a subagent, do NOT decide for
it: answer "Your call — follow your skill." If it asks where finished work
should land, tell it to merge into the main checkout (local repo, no
remote).

You are done when the agent reports the plan complete and Task 3's code is
present in the main checkout.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  appears in the session log.
- Every SDD subagent dispatch (`spawn_agent`) in the session sets
  `fork_turns` to `"none"` explicitly. A dispatch that omits `fork_turns`
  (the platform default is `"all"`, a full-history fork) or passes `"all"`
  or a turn count is a fail on this AC.
- The platform reference (codex-tools.md in the using-superpowers skill)
  defines a per-role model table for SDD dispatches on Codex. Every SDD
  dispatch names `model` and `reasoning_effort` explicitly per that table
  (implementer and task reviewer `gpt-5.6-terra`/`high`, fix review
  `gpt-5.6-terra`/`medium`). A dispatch that omits both fields — silently
  inheriting the parent session's model and effort — is a fail on this AC.
  If the harness's `spawn_agent` schema exposes no `model` or
  `reasoning_effort` parameter at all (Codex 0.144 and earlier), this AC
  is not satisfiable and the run should be graded indeterminate, not
  failed: check the spawn tool schema before ruling.
- No SDD dispatch names `gpt-5.6-sol` or escalates `reasoning_effort`
  above the role table's value between fix rounds. Dispatching a subagent
  on the parent session's frontier model is a fail even if done only once.
- The fix loop and Task 3 otherwise follow the skill: fix rounds end in a
  scoped fix review, and no fix round runs past round 5.
- `npm test` passes in the main checkout.
