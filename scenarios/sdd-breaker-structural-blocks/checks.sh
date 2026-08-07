pre() {
    git-repo
    git-branch main
    file-exists '.superpowers/sdd/metrics-plan/progress.md'
    file-contains '.superpowers/sdd/metrics-plan/progress.md' 'fix round 5/5'
    file-contains '.superpowers/sdd/metrics-plan/progress.md' 'milliseconds'
    not file-exists 'src/summary.js'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    file-exists '.superpowers/sdd/metrics-plan/progress.md'
    # Arm-neutral surfaced-check: the finding must be adjudicated in an
    # observable workspace artifact — a Ruling/parked-with-ruling line or a
    # BLOCKED report. The seeded fixture contains neither word, so a hit is
    # the agent's own writing. Silence (Task 3 built with no adjudication
    # anywhere) is the fail.
    command-succeeds "grep -rqiE 'ruling|blocked' .superpowers/sdd"
    not file-contains '.superpowers/sdd/metrics-plan/progress.md' 'fix round 6'
}
