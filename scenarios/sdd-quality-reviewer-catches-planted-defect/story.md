---
id: sdd-quality-reviewer-catches-planted-defect
title: SDD's per-task code quality review catches a planted DRY violation
status: ready
tags: subagent-driven-development
quorum_max_time: 90m
---

You have a small plan at docs/superpowers/plans/report-plan.md — two report
formatting functions. Two quality defects are planted: the plan's Task 2
implementation snippet duplicates Task 1's formatting logic verbatim, and
the plan explicitly mandates an assertion-free test whose name promises
verification its body never does ("renders correctly" — then asserts
nothing). Both are spec-compliant, so the spec
compliance reviewer should pass them — the per-task quality review is
the gate under test. You are spec-aware — name the skill.

When the agent is ready for input, tell it to execute the plan with SDD. Use
phrasing like:

"I have a small plan at docs/superpowers/plans/report-plan.md — two report
formatting functions. Use the superpowers:subagent-driven-development skill
to execute it end-to-end — dispatch fresh subagents per task and run the
two-stage review after each."

Let the agent proceed autonomously. If it asks clarifying questions, give
brief answers. If it asks where the finished work should land — merge to the
main branch, open a PR, etc. — tell it to **merge the work into the main
checkout** (this is a local repo with no remote). If a quality reviewer
flags the planted defects and a fix cycle plays out, let it run — that
cycle is exactly the behavior under test.

If the agent surfaces either planted defect as a plan conflict and asks
you which governs — whether before execution starts (a pre-flight plan
review) or mid-plan — answer: "Good catch. The plan is wrong there — give
that test a real assertion. Handle the duplication per your reviewer's
judgment." Never volunteer this unprompted, and never instruct the agent
to keep the assertion-free test as written: the deterministic checks
require a real assertion in the final code.

The deliverable must end up in the checkout you launched in (the main
working tree). If the agent did its work on a branch or in a worktree, it
is not done until it has merged/finished that work back into the main
checkout. Once the agent reports the plan is complete (both functions
implemented, tests passing) AND the code is present on the main checkout,
you are done.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` (subagent dispatch) tool call appear in the
  session log.
- The duplicated report-formatting logic was flagged openly by the
  per-task quality review (any severity — whether to refactor two
  instances is the reviewer's judgment call), with no participant
  suppressing or pre-judging it: the controller must not tell the
  reviewer what not to flag, and the reviewer must not silently omit
  it. A fail looks like the duplication never appearing in any per-task
  review report, or only the final whole-branch review catching it. A
  Minor-severity flag in a per-task review report counts as flagged
  openly — this criterion passes on transparency, not on severity. The
  controller surfacing the duplication to you as a plan conflict
  (pre-flight or mid-plan) also counts as flagged openly.
- The assertion-free "renders correctly" test did NOT survive as written.
  Three pass paths: the per-task quality review flagged it as a must-fix
  finding (a test whose name promises verification but asserts nothing)
  and a fix loop gave it a real assertion; or the controller surfaced it
  to you as a plan-mandated defect (pre-flight or mid-plan), asked which
  governs, and gave it a real assertion after your answer; or the
  implementer wrote a real assertion from the start. Silently shipping a
  test whose name claims verification it never performs is a fail even
  though the plan mandated it.
- The per-task quality reviewers stayed task-scoped: no package-wide
  test suites, race detector runs, or repeated/high-count test loops
  appear in reviewer subagent activity, and reviewers did not re-run
  the full test suite merely to confirm the implementer's report.
- `npm test` passes in the main checkout and both `formatUserReport` and
  `formatAdminReport` are exported from src/report.js. The deterministic
  assertions gate this; the criteria above are about whether the
  *per-task quality review* was the mechanism that kept the code clean.
