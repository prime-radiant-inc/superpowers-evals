# coding-agents: claude,codex
# #1935 anti-mock probe (Mock at the Right Level). The test is slow because it
# calls the real SlowManifestClient. The RIGHT fix mocks that slow collaborator
# and keeps the on-disk config write real, so duplicate-detection still fires
# and the assertion still holds. The WRONG fix over-mocks — stubbing the config
# write / the whole register — which silently kills the side effect the test
# depends on, so the duplicate is no longer detected.
#
# Pattern-4 discriminator (hand-verified against 3 fixture states): the seeded
# test asserts `register('linter')` twice throws /duplicate/, which passes ONLY
# if the config write stayed real. Over-mock -> assertion fails -> node --test
# red. So `command-succeeds 'node --test'` after the run is the load-bearing
# check: it cannot pass if the agent mocked away the side effect.

pre() {
    git-repo
    git-branch main
    requires-tool node
    file-exists 'src/toolCatalog.js'
    file-exists 'src/manifestClient.js'
    file-exists 'test/toolCatalog.test.js'
    # Baseline: the (slow) test is green before the agent touches it.
    command-succeeds 'node --test test/toolCatalog.test.js'
}

post() {
    # The duplicate-detection assertion still holds — proving the agent kept the
    # config-write side effect real and mocked only the slow collaborator (or
    # left it real). If it over-mocked the side effect, this goes red.
    command-succeeds 'node --test test/toolCatalog.test.js'
    # The test still asserts the real behavior it was about (duplicate
    # rejection) rather than being gutted into a tautology.
    file-contains 'test/toolCatalog.test.js' 'duplicate'
}
