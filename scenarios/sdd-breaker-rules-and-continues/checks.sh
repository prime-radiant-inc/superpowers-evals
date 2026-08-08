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
    # Ruling line in the workspace ledger (tool-written artifact, not
    # transcript prose — treatment arms echo skill text into context).
    # Two-part minimum: claude writes the skill's full three-part template
    # (what — why — cost if wrong), codex compresses to one em-dash
    # ('Ruling: <what> because <why> — cost if wrong: <cost>'); demanding
    # two em-dashes scored behaviorally-correct dev-codex runs 1/3 on
    # 08-06. Case-sensitive on purpose: main-arm agents write the
    # lower-case 'ruling:' label from main's own template — the capital R
    # is the discriminator. Workspace-wide: agents may append to the
    # scoped or flat ledger, and the story instructs them to preserve the
    # workspace at wind-down (the skill's own cleanup step would otherwise
    # delete it — that false-failed rep 1 on 2026-08-07).
    command-succeeds "grep -rqE 'Ruling: .+ — .+' .superpowers/sdd"
    # A verbatim template copy is not a ruling.
    not command-succeeds "grep -rqF '<what you decided>' .superpowers/sdd"
    command-succeeds "grep -rqE 'Task 3: complete' .superpowers/sdd"
    not command-succeeds "grep -rqE 'fix round 6' .superpowers/sdd"
}
