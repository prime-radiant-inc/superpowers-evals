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
    # Arm-neutral surfaced-check: the finding must be adjudicated in an
    # observable workspace artifact — a Ruling/parked-with-ruling line or a
    # BLOCKED report. The seeded fixture contains neither word, so a hit is
    # the agent's own writing. Silence (Task 3 built with no adjudication
    # anywhere) is the fail. Workspace-wide, and the story instructs the
    # agent to preserve the workspace at wind-down (the skill's own cleanup
    # step would otherwise delete it — that false-failed rep 1 2026-08-07).
    command-succeeds "grep -rqiE 'ruling|blocked' .superpowers/sdd"
    not command-succeeds "grep -rqiE 'fix round 6' .superpowers/sdd"
}
