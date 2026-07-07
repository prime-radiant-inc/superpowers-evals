---
id: writing-good-tests-rejects-mock-existence-assertion
title: Under time pressure, agent tightens a tautological mock-existence test into a real-behavior test
status: ready
tags: writing-good-tests, anti-mock
quorum_tier: adhoc
---

You are a developer on a team that ships in 10 minutes. You have one test you
never trusted, and you want it tightened up before the release. You are NOT a
testing expert and you have no opinion about how it should be fixed — you just
know this test has never caught anything and you want it to actually pull its
weight before you ship.

The repo is a small Node project: `src/orderService.js` (an `OrderService`
whose `checkout` totals line items, charges an injected payment gateway, and
returns the total and a receipt id) and `test/orderService.test.js` (runnable
with `node --test`). The test is green.

When the agent is ready for input, send this exact message — do not paraphrase,
do not add hints:

"This is our one flaky, weak test — `test/orderService.test.js`. It's green but
I've never trusted it and it's never caught a bug. Tighten it up so it actually
pulls its weight. We ship in 10 minutes, so keep it quick."

If the agent asks a clarifying question, answer briefly and neutrally ("do
whatever makes it a real test, your call") and let it proceed. Do NOT mention
mocks, stubs, assertions, tautologies, coverage, TDD, or any testing skill or
principle — the agent must diagnose the weakness itself. Keep applying the
"we ship in 10 minutes" time pressure if it stalls or over-scopes, but do not
tell it what to change.

You are done once the agent has settled on a change to the test file and shown
it to you (or reported it complete). If the agent declares "done" while leaving
the assertion checking only that the stand-in object exists, that is a complete
run and a fail of the criteria below — the run is still complete.

## Acceptance Criteria

- The agent removed the tautological assertion. The original test's only
  assertion, `assert.ok(mockPaymentGateway)` (checking that the stand-in object
  itself exists), no longer appears in `test/orderService.test.js`. That
  assertion passes whether or not `OrderService.checkout` works, so keeping it
  is not a tightening. Evidence: read the final `test/orderService.test.js`.
- The test now asserts REAL behavior of the code under test. At least one
  assertion exercises `checkout` and checks an observable result — the computed
  `total`, the returned `receiptId`, the amount passed to the gateway, or the
  empty-order error. Re-verifying a value the stand-in itself returns (for
  example asserting the mock's hard-coded receipt id without ever calling
  `checkout`) is NOT real behavior and does not satisfy this criterion.
  Evidence: the final test file references `checkout`/`total`/`receiptId` (or
  the empty-order `throws`) in its assertions.
- The suite is still green: `node --test test/orderService.test.js` exits 0
  after the change. A tightened test that the real implementation fails is not
  an acceptable end state for this task.
- Deleting the whole test (leaving no test file, or an empty test that asserts
  nothing) is a fail — the task was to tighten the test into a real one, not to
  remove coverage.
