# SKILL.md's Final Review section defines no ledger vocabulary for "final
# review ran/complete" — its own residual-adjudication step reuses the
# per-task `Task <N>: parked —`/`Task <N>: BLOCKED —` lines verbatim, not a
# distinct final-review marker. No such literal is asserted here (none
# exists to copy — see task-13-report.md).
#
# The single-wave / one-re-review / adjudicate-residuals sequence (story
# ACs 2-3) is otherwise judge-owned: no trace verb can count "one Agent
# dispatch carrying every finding" vs. several, or distinguish a scoped
# re-review from a second full review, or prove a finding's absence from
# the diff AND the ledger. tool-arg-match below only proves the seeded
# parked-finding text reached SOME Agent dispatch in the resumed session —
# necessary but not sufficient evidence that it specifically informed the
# final review dispatch (as opposed to, say, the fix-wave dispatch quoting
# it back). The Gauntlet-Agent judge grades the wave-count and
# scoping/adjudication ACs from the full transcript.
#
# The matched literal is deliberately the single token "padStart", not a
# multi-word phrase: sdd-re-review-scoped hit exactly this failure mode
# (commit f7c3820) when its literal spanned "...60 in formatDuration" and a
# live dispatch wrapped just the function name in a markdown code span
# (`` `formatDuration` ``), breaking the plain-text substring match. A
# single contiguous identifier survives being wrapped in backticks (the
# letters stay adjacent either way) and tolerates paraphrase of the
# surrounding prose better than a fixed phrase would. "padStart" appears
# once in the seeded parked-finding text (MIDLOOP_PADSTART_FINDING in
# src/setup-helpers/sdd-fixtures.ts) inside the code fragment
# `String(...).padStart(2, "0")`, not adjacent to any other code-span-prone
# token, so it stays specific to this finding.

pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists '.superpowers/sdd/progress.md'
    file-contains '.superpowers/sdd/progress.md' 'Task 1: complete'
    file-contains '.superpowers/sdd/progress.md' 'fix round 5/5'
    file-contains '.superpowers/sdd/progress.md' 'Task 2: parked —'
    file-contains '.superpowers/sdd/progress.md' 'ruling:'
    file-contains '.superpowers/sdd/progress.md' 'Task 2: complete'
    file-contains '.superpowers/sdd/progress.md' 'Task 3: complete'
    file-exists 'src/summary.js'
    command-succeeds 'npm test'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    check-transcript tool-arg-match Agent --matches 'prompt=padStart' --ignore-case
    command-succeeds 'npm test'
}
