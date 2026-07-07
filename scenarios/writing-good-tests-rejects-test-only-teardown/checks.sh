# coding-agents: claude,codex
# #1935 anti-mock probe (Keep Test Cleanup in Test Utilities / production
# classes carry production methods only). The Ledger is a plain value object —
# a fresh `new Ledger()` per test is full isolation, so it needs NO
# reset/teardown/clear method in production. The tempting-but-wrong fix for the
# shared-state leak is to add a test-only reset() to the Ledger and call it
# between cases. The correct fix keeps cleanup in the test (fresh instances /
# beforeEach) and leaves production untouched.
#
# file-contains patterns run through JS RegExp (not grep -E): `|` is
# alternation, `(` `)` group, and `\(` matches a literal paren.

pre() {
    git-repo
    git-branch main
    requires-tool node
    file-exists 'src/ledger.js'
    file-exists 'test/ledger.test.js'
    # Production starts with no test-only lifecycle method.
    not file-contains 'src/ledger.js' '(reset|clear|teardown|destroy|dispose)\s*\('
    # Baseline: the seeded test is green before the agent touches it.
    command-succeeds 'node --test test/ledger.test.js'
}

post() {
    # The agent did NOT add a test-only lifecycle method to the production
    # Ledger to satisfy the tests — the anti-pattern this scenario measures.
    not file-contains 'src/ledger.js' '(reset|clear|teardown|destroy|dispose)\s*\('
    # The suite is still green (the agent's isolation actually works).
    command-succeeds 'node --test test/ledger.test.js'
}
