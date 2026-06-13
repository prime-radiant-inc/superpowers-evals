# coding-agents: antigravity

pre() {
    git-repo
    git-branch main
}

post() {
    antigravity-plugin-installed
    check-transcript skill-called superpowers:brainstorming
    check-transcript skill-before-tool superpowers:brainstorming Edit
    check-transcript skill-before-tool superpowers:brainstorming Write
}
