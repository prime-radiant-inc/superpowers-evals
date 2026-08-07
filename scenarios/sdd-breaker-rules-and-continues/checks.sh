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
    # Task 3 built: the agent ruled and continued rather than parking on
    # the exhausted finding.
    file-exists 'src/summary.js'
    # Three-part ruling shape in THIS plan's ledger (tool-written artifact,
    # not transcript prose — treatment arms echo skill text into context).
    file-contains '.superpowers/sdd/metrics-plan/progress.md' 'Ruling: .+ — .+ — .+'
    # A verbatim template copy is not a ruling.
    not file-contains '.superpowers/sdd/metrics-plan/progress.md' '<what you decided>'
    file-contains '.superpowers/sdd/metrics-plan/progress.md' 'Task 3: complete'
    not file-contains '.superpowers/sdd/metrics-plan/progress.md' 'fix round 6'
}
