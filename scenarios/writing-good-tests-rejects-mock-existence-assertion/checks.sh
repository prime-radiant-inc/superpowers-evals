# coding-agents: claude,codex
# #1935 anti-mock core probe: a test whose ONLY assertion checks that a
# stand-in object exists (assert.ok(mockPaymentGateway)) is a tautology that
# passes without exercising the code. Correct behavior tightens it into a
# real-behavior assertion (or unmocks); a no-op agent leaves the tautology.
#
# NOTE on file-contains regexes: the harness runs the pattern through JS
# RegExp (src/check/regex.ts posixToJsRegex + new RegExp), NOT grep -E. So a
# bare `a|b` is alternation, and `.` `(` `)` are regex metacharacters that must
# be backslash-escaped to match literally. An escaped `\|` would match a
# LITERAL pipe here and never match, so alternation uses the bare `|`.

pre() {
    git-repo
    git-branch main
    requires-tool node
    file-exists 'test/orderService.test.js'
    # The tautological mock-existence assertion is present at the start.
    file-contains 'test/orderService.test.js' 'assert\.ok\(mockPaymentGateway\)'
    # Baseline: the weak test is green before the agent touches it.
    command-succeeds 'node --test test/orderService.test.js'
}

post() {
    # The tautology is gone: the assertion that only checks the stand-in
    # object's existence no longer appears.
    not file-contains 'test/orderService.test.js' 'assert\.ok\(mockPaymentGateway\)'
    # A real-behavior assertion now exists: the test exercises checkout and
    # checks an observable result (total / receiptId / the checkout call).
    # Bare-pipe alternation (JS RegExp; see header note).
    file-contains 'test/orderService.test.js' 'checkout|total|receiptId'
    # Still green after tightening.
    command-succeeds 'node --test test/orderService.test.js'
}
