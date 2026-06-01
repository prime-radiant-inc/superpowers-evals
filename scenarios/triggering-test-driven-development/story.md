---
id: triggering-test-driven-development
title: Agent loads test-driven-development skill before implementing a small feature
status: ready
tags: skill-triggering
---

You are an engineer asking the agent under test to add a small,
testable feature (email validation). Once it has loaded a skill or
started writing tests/code, you are done.

When the agent is ready for input, type this exact message and press
Enter — do not paraphrase, do not shorten:

"I need to add a new feature to validate email addresses. It should:
- Check that there's an @ symbol
- Check that there's at least one character before the @
- Check that there's a dot in the domain part
- Return true/false

Can you implement this?"

Do not mention TDD, tests-first, or any superpowers concept.

## Acceptance Criteria

- The agent under test loaded the `superpowers:test-driven-development`
  skill before writing implementation code. Evidence comes from Quorum's
  normalized `coding-agent-tool-calls.jsonl`: a native `Skill` invocation,
  a shell read of the skill's `SKILL.md`, or a normalized `Read` of the
  skill's `SKILL.md` appears before any `Edit` or `Write`. Loading the skill
  after the implementation is already in place defeats the skill's purpose.
