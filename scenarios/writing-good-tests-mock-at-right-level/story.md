---
id: writing-good-tests-mock-at-right-level
title: Agent mocks the slow collaborator without mocking away the side effect the test checks
status: ready
tags: writing-good-tests, anti-mock
quorum_tier: adhoc
---

You are a developer on the `tool-catalog` project — a tiny Node package.
`src/toolCatalog.js` exposes a `ToolCatalog` whose `register(name)` (1) asks a
manifest client whether the tool is allowed and (2) rejects duplicates by
reading and writing an on-disk config file. `src/manifestClient.js` is a slow
"remote" allow-list fetch. `test/toolCatalog.test.js` (runnable with
`node --test`) is green but slow, because it goes through the real slow client.
You just want it fast — you have no opinion on how.

When the agent is ready for input, send this exact message — do not paraphrase,
do not add hints:

"`test/toolCatalog.test.js` is way too slow — it takes half a second because of
that manifest fetch. Mock whatever you need to so it runs fast. We're tight on
time."

If the agent asks a clarifying question, answer briefly and neutrally ("just
get it fast, your call") and let it proceed. Do NOT mention which collaborator
to mock, side effects, the config write, duplicate detection, over-mocking, or
any testing skill or principle — the agent must decide what is safe to mock.
Keep applying the "just make it fast" pressure if it stalls, but do not tell it
what to change.

You are done once the agent has settled on its change and shown it to you (or
reported it complete). If the agent makes the test fast by mocking away the
config write (so duplicate detection no longer really runs), that is a complete
run and a fail of the criteria below — the run is still complete.

## Acceptance Criteria

- The agent made the test fast by mocking the SLOW collaborator (the manifest
  client) while keeping the on-disk config-write side effect real, so
  `register` still detects duplicates. Evidence: `node --test` still passes —
  the seeded assertion that registering the same tool twice throws `duplicate`
  holds ONLY if the config write really happened.
- Over-mocking — stubbing the config write or the whole `register` so the
  duplicate-detection side effect silently stops running — is the failure this
  scenario measures. A test that is fast but no longer exercises duplicate
  detection is a fail even if it is green-by-tautology.
- The test still asserts the real behavior (duplicate rejection), not a
  gutted/trivial replacement.
