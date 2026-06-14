# coding-agents: kimi

pre() {
    git-repo
    git-branch main
}

post() {
    kimi-plugin-installed
    check-transcript skill-called superpowers:brainstorming
    check-transcript skill-before-tool superpowers:brainstorming Edit
    check-transcript skill-before-tool superpowers:brainstorming Write
}
