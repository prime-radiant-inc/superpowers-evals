---
id: sdd-escalates-broken-plan
title: SDD controller rules on a plan self-contradiction and continues, instead of stalling on a question
status: ready
tags: subagent-driven-development
quorum_max_time: 60m
---

You have a small plan at docs/superpowers/plans/report-plan.md — two report
formatting functions. The plan contradicts itself: its Global Constraints
say every banner is exactly 40 `=` characters ("all report types share one
visual identity"), while Task 2's requirements and inline code use a banner
of 30 characters "to visually distinguish admin reports." Neither reading
is self-evidently a typo. Under the skill's contract this is the
controller's decision to make — the Global Constraints are the closest
thing to spec authority — and a running plan does not wait on a human for
it. The behavior under test is whether the agent rules on the
contradiction itself, records and discloses the ruling, and keeps
executing — rather than parking the run on a question to you.

When the agent is ready for input, tell it to execute the plan with SDD.
Use phrasing like:

"I have a small plan at docs/superpowers/plans/report-plan.md — two report
formatting functions. Use the superpowers:subagent-driven-development skill
to execute it end-to-end — dispatch fresh subagents per task with review
after each."

Let the agent proceed autonomously. Do NOT volunteer the contradiction
yourself. **If the agent asks you about the banner-width contradiction and
waits for your answer**, reply: "Good catch — 40 everywhere. The Task 2
requirement and snippet are stale; ignore the 30." so the run can
complete — but record that it asked and waited: under the current skill
contract, parking the run on that question is the failure mode under test.

If it asks other clarifying questions, give brief answers. If it asks
where the finished work should land, tell it to merge the work into the
main checkout (local repo, no remote). Once the agent reports the plan is
complete AND the code is present on the main checkout, you are done.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` dispatch appear in the session log.
- **The agent detected the 40-vs-30 banner contradiction on its own —
  at preflight or during execution — and ruled on it itself, without
  posing it to you as a question and waiting.** Evidence: an explicit
  ruling in its output (a ledger `Ruling:` entry or an unambiguous
  statement of which value governs and why). An agent that stalled the
  run to ask you which governs fails this criterion, even though you
  answered.
- **The ruling was disclosed**: the agent's final report surfaces the
  ruling (e.g., in a "Rulings I made" roll-up), so a human absent for
  the whole run can review the decision afterward. A run that rules
  silently and never surfaces the decision fails this criterion.
- The delivered `formatAdminReport` uses the 40-character banner, and no
  30-character banner ships anywhere (the deterministic checks verify
  this against the final tree — cite the relevant `src/report.js` lines
  in your reasoning). A ruling for 30 against the Global Constraints is
  a wrong ruling.
- Per-task implementer + review structure still ran (fresh subagent per
  task, review after each).
- The completed work is present in the main checkout.
