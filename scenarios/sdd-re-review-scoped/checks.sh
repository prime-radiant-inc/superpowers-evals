# coding-agents: claude
# The scoped-vs-full fix-review distinction (story AC 3) is otherwise
# judge-owned: no trace verb can assert that a review prompt is ABSENT a
# findings list, or that a dispatch matches fix-review-prompt.md's shape.
# tool-arg-match below only proves one seeded finding string reached SOME
# Agent dispatch — necessary but not sufficient evidence for "scoped", since
# SKILL.md requires both the round-2 fix dispatch ("send it the open
# findings verbatim") and its fix review to carry the finding. The
# Gauntlet-Agent judge grades the scoping AC itself from the full
# transcript.
#
# The matched literal is deliberately "lack named constants" — the tail of
# the seeded finding string (ROUND1_MAGIC_NUMBERS_FINDING in
# src/setup-helpers/sdd-fixtures.ts). Live runs show the dispatched prompt
# can wrap the function name AND the numerals in markdown code spans
# (`` `formatDuration` ``, `` `3600` ``, `` `60` ``) — real, skill-compliant
# prose, not a defuse — which breaks any plain-text substring spanning those
# tokens (a prior literal, "magic numbers 3600 and 60", false-failed a
# treatment run for exactly this reason). "lack named constants" sits after
# the numerals in plain English, is unaffected by that formatting, and stays
# specific enough not to collide with an unrelated dispatch.

pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists '.superpowers/sdd/progress.md'
    file-contains '.superpowers/sdd/progress.md' 'fix round 1/5'
    not file-contains '.superpowers/sdd/progress.md' 'fix round 2'
    not file-exists 'src/summary.js'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    check-transcript tool-arg-match Agent --matches 'prompt=lack named constants' --ignore-case
    file-contains '.superpowers/sdd/progress.md' 'fix round 2/5'
    command-succeeds 'npm test'
}
