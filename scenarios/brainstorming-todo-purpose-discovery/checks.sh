pre() {
    git-repo
    git-branch main
    assert-checkout-clean
    file-exists README.md
    not file-exists package.json
    not file-exists AGENTS.md
}

post() {
    # Positive anchor: the ordering verbs below are vacuous when the agent
    # never reached implementation, so the skill must be proven to have fired.
    check-transcript skill-called superpowers:brainstorming
    # Native Write/Edit only; shell writes are the Gauntlet-Agent's to judge.
    check-transcript skill-before-implementation-tool superpowers:brainstorming Write
    check-transcript skill-before-implementation-tool superpowers:brainstorming Edit
    # A new project must produce a saved spec, and the spec must carry the
    # hidden learning purpose the actor only reveals when asked.
    file-exists 'docs/superpowers/specs/*.md'
    command-succeeds 'grep -qiE "learn" docs/superpowers/specs/*.md'
}
