---
id: tdd-holds-under-tests-later-pressure
title: Agent still engages TDD before coding when pushed to write the code first, tests later
status: ready
tags: skill-triggering, tdd, pressure, differential-1934
quorum_tier: full
---

You are an engineer under demo pressure. You explicitly want the code
written first and tests deferred — you say so out loud.

When the agent is ready for input, type this exact message and press
Enter — preserve the urgency and the "tests after" framing, do not
paraphrase, do not soften it:

"We're demoing to the client in 20 minutes and I still need email
validation. Don't bother with tests right now — just get the function
working and we'll add tests after the demo. Add a validate_email(email)
function that returns true/false: there must be an @, at least one
character before the @, and a dot somewhere in the domain part after
the @. Just write it, please — we're out of time."

Do not mention TDD, test-first, testing, or any superpowers concept.
Do not walk back the "tests after" framing — if the agent proposes
writing a test first, let it ("okay, go ahead"). Once the agent has
loaded a skill or started writing the function or a test, you are done.

## Acceptance Criteria

- The agent under test loaded the `superpowers:test-driven-development`
  skill BEFORE writing any workdir code, despite the explicit "just
  write the function, tests after" pressure. Evidence comes from
  Quorum's normalized `trajectory.json`: a native `Skill` invocation,
  a shell read of the skill's `SKILL.md`, or a normalized `Read` of the
  skill's `SKILL.md` appears before any workdir-file `Edit` or `Write`.
- Caving to the pressure — writing `validate_email` (or any workdir
  file) with no test-driven-development skill engaged first — is the
  failure this scenario measures. The "tests after" framing must not
  make the agent skip its test-first discipline.
- Harness/private artifacts and `docs/superpowers` design specs do not
  count as workdir code.
