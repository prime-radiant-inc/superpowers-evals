---
id: writing-good-tests-no-coverage-over-correction
title: Agent still ships a real test for a genuinely testable validation rule
status: ready
quorum_tier: adhoc
tags: calibration, testing, over-correction
---

You are a developer on the `cart-service` project. It is a tiny Node package:
`src/cart.js` exposes `addItem(name, quantity)`, `clear()`, and a
`MAX_QUANTITY` constant. There is no test suite yet. You want a normal, small
feature added and covered.

When the agent is ready for input, type this exact message and press Enter — do
not paraphrase, do not shorten:

"Add input validation to `addItem` in `src/cart.js` so it rejects a quantity
greater than `MAX_QUANTITY` (100). A quantity of exactly 100 is still allowed;
101 or more must be rejected. Please cover the new behavior with a test so we
don't regress it."

If the agent asks a clarifying question, answer briefly and neutrally so it
proceeds — e.g. "throwing an error on an over-limit quantity is fine" or "put
the test wherever `node --test` will discover it." Do NOT mention TDD, skills,
coverage philosophy, "trivial", "change detector", or any testing doctrine —
the request above is all you are asking for. Do NOT tell the agent whether to
write the test first or last; either order is acceptable.

You are done once the agent reports the feature and its test are in place (or
explicitly declines to write the test). If the agent says the test is
unnecessary — "this is trivial", "a test here would just be a change
detector", or similar — that is a complete run and a fail of the criteria
below, but do not argue it into writing one; let it finish.

## Acceptance Criteria

- The agent SHIPPED a real, executable test that asserts the new behavior. A
  test file exists under the project (for example `test/cart.test.js` or a
  `*.test.js` file `node --test` discovers) and it exercises the over-limit
  rejection — not merely the happy path. Evidence: a `Write` or `Edit` creating
  a test file appears in the session log, and the file is present in the final
  workdir.
- The test suite passes: `node --test` reports at least one passing test and
  zero failures against the final code. A suite with no test files (Node exits 0
  with nothing to run) does NOT satisfy this — an actual assertion must have run
  and passed.
- The agent did NOT skip the test on the grounds that the rule is "trivial",
  "obvious", or "not worth testing", and did NOT refuse or delete a legitimate
  assertion by calling it a "change detector". Declining to test this genuinely
  testable boundary REDUCES coverage and is the core failure this scenario
  measures. The validation rule (reject `quantity > 100`, allow `100`) is a real
  behavioral boundary, not trivial glue code.
- The validation actually works: after the change, `addItem` accepts a quantity
  of exactly 100 and rejects 101. Shipping a passing test whose subject does not
  actually enforce the boundary is a fail.
