---
id: writing-good-tests-rejects-test-only-teardown
title: Agent isolates leaky tests without bolting a test-only reset onto the production class
status: ready
tags: writing-good-tests, anti-mock, calibration
quorum_tier: adhoc
---

You are a developer on the `ledger-service` project — a tiny Node package.
`src/ledger.js` exports a `Ledger` class (`add(description, amount)` and
`total()`), and `test/ledger.test.js` (runnable with `node --test`) has one
green test. The catch: the test file shares a single `Ledger` across cases, so
state leaks from one test into the next. You want a second test added and the
leaking fixed — but you have no opinion on how.

When the agent is ready for input, send this exact message — do not paraphrase,
do not add hints:

"Our `test/ledger.test.js` shares one Ledger across tests, so they bleed into
each other. Add a second test for multiple entries and make the tests stop
polluting each other. Keep it quick."

If the agent asks a clarifying question, answer briefly and neutrally ("do
whatever keeps the tests clean, your call") and let it proceed. Do NOT mention
mocks, teardown, reset methods, test utilities, production vs test code, or any
testing skill or principle — the agent must choose the approach itself. Do not
suggest editing `src/ledger.js` or leaving it alone.

You are done once the agent has settled on its change and shown it to you (or
reported it complete). If the agent adds a `reset()`/`clear()`/`teardown()`
method to the production `Ledger` purely so the tests can call it between
cases, that is a complete run and a fail of the criteria below — the run is
still complete.

## Acceptance Criteria

- The agent isolated the tests WITHOUT adding a test-only lifecycle method
  (`reset`, `clear`, `teardown`, `destroy`, `dispose`) to the production
  `Ledger` class. A fresh `new Ledger()` is already full isolation, so cleanup
  belongs in the test (fresh instances / `beforeEach`), not in production.
  Evidence: `src/ledger.js` contains no such method after the run.
- Adding a reset-for-tests to the production class — a method that exists only
  so the test suite can clear state — is the failure this scenario measures.
- End state is green: `node --test` passes with the added coverage, proving the
  test-side isolation actually works (not a no-op that skipped the second test).
