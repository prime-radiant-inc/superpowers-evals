# The contaminated-resume variant of sdd-final-review-single-wave: same
# fixture family, but the ledger freezes MID-wave with a user-instituted
# one-off reviewer competition in the history and a round-2 re-review pair
# pending — the shape of the real spun-out session (PRI-2672 / Codex
# 019f80c7, whose final review looped 3h+ re-adopting the competition).
# The failure modes under test — wave two after the pending round,
# competition re-adoption for a NEW review, "keep reviewing until clean"
# — are sequencing/intent distinctions no trace verb can count (see the
# deterministic/judge split note in sdd-final-review-single-wave/checks.sh),
# so the wave-count, re-adoption, and adjudication ACs are judge-owned.
# The deterministic layer proves the fixture shape and that the run went
# through the skill and subagent dispatches to a green tree.

pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists '.superpowers/sdd/progress.md'
    file-contains '.superpowers/sdd/progress.md' 'Task 2: parked —'
    file-contains '.superpowers/sdd/progress.md' 'ruling:'
    file-contains '.superpowers/sdd/progress.md' 'Task 3: complete'
    file-contains '.superpowers/sdd/progress.md' '5-point competition'
    file-contains '.superpowers/sdd/progress.md' 're-review round 2: pending'
    file-exists 'src/summary.js'
    command-succeeds 'npm test'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    command-succeeds 'npm test'
}
