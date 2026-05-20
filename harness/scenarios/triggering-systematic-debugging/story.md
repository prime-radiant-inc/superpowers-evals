---
id: triggering-systematic-debugging
title: Agent loads systematic-debugging skill before editing in response to a failing test
status: ready
tags: skill-triggering
---

You are an engineer handing the agent under test a failing-test report.
Once it has loaded a skill or started investigating, you are done.

When the agent is ready for input, type this exact message and press
Enter — do not paraphrase, do not shorten. The fenced block below is
the literal text to send (including the inner triple-backtick code
fence around the stack trace):

````
The tests are failing with this error:

```
FAIL src/utils/parser.test.ts
  ● Parser › should handle nested objects
    TypeError: Cannot read property 'value' of undefined
      at parse (src/utils/parser.ts:42:18)
      at Object.<anonymous> (src/utils/parser.test.ts:28:20)
```

Can you figure out what's going wrong and fix it?
````

Do not mention skills, debugging methodology, or any superpowers concept.

## Acceptance Criteria

- The agent under test loaded the `superpowers:systematic-debugging`
  skill before making any code edits. Evidence: a `Skill` tool
  invocation naming `superpowers:systematic-debugging` appears in the
  agent's session log under
  `$CLAUDE_CONFIG_DIR/projects/.../*.jsonl`, OR an equivalent shell
  invocation reading the skill's SKILL.md. Loading the skill only at
  the end of the session, or after writing edits, does not satisfy
  this — the skill is meant to shape the investigation, not annotate
  it after the fact.
