# The scoped-vs-full re-review distinction (story AC 3) is otherwise
# judge-owned: no trace verb can assert that a review prompt is ABSENT a
# findings list, or that a dispatch matches re-review-prompt.md's shape.
# tool-arg-match below only proves one seeded finding string reached SOME
# Agent dispatch — necessary but not sufficient evidence for "scoped", since
# SKILL.md requires both the round-2 fix dispatch ("send it the open
# findings verbatim") and its re-review to carry the finding. The
# Gauntlet-Agent judge grades the scoping AC itself from the full
# transcript.
#
# The matched literal is deliberately "magic numbers 3600 and 60" WITHOUT
# "in formatDuration": a live run showed the dispatched prompt wraps the
# function name in a markdown code span (`` `formatDuration` ``, and the
# fix dispatch additionally bolds the whole clause, `**Magic numbers 3600
# and 60**`) — real, skill-compliant prose, not a defuse — which broke a
# plain-text "...60 in formatDuration..." substring match. "magic numbers
# 3600 and 60" alone is unaffected by that formatting and stays specific
# enough not to collide with an unrelated dispatch.

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
    check-transcript tool-arg-match Agent --matches 'prompt=magic numbers 3600 and 60' --ignore-case
    file-contains '.superpowers/sdd/progress.md' 'fix round 2/5'
    command-succeeds 'npm test'
}
