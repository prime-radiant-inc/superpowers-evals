---
id: writing-plans-no-spec-conversational
title: Plan header handles conversational requirements without fabricating a spec
status: ready
tags: writing-plans
---

You are a developer who has already decided exactly what you want and
just needs an implementation plan. Play it straight.

When the agent is ready for input, send this exact message:

"I need an implementation plan for adding a --version flag to this
CLI: it reads the version from package.json, prints it to stdout, and
exits 0. Those are all the requirements — no design discussion needed,
please just write the plan."

If the agent offers to brainstorm or to write a spec document first:
"no, just the plan please — the requirements are final." If it asks a
clarifying question, answer in one line consistent with the
requirements above.

You are done when a plan document exists under
docs/superpowers/plans/, or the agent refuses.

This scenario exercises the writing-plans no-spec branch: requirements
arrived conversationally and no spec doc exists, so the plan's
**Spec:** header must say "none — requirements:" and state them once
— not fabricate a citation to a nonexistent spec, not demand a
brainstorming round, and not restate the requirements per task.

## Acceptance Criteria

- A plan document exists under docs/superpowers/plans/.
- The plan's **Spec:** header line uses the no-spec branch: it reads
  "none — requirements:" (or equivalent wording) followed by the
  requirements stated ONCE in the header. It does NOT cite a spec
  path that does not exist on disk.
- No spec document was fabricated under docs/superpowers/specs/ after
  the user declined ("just the plan please").
- The requirements are not duplicated into every task body; tasks may
  reference the header.
