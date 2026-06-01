# coding-agents: antigravity

pre() {
    git-repo
    git-branch main
}

post() {
    antigravity-plugin-installed
    skill-called superpowers:brainstorming
    skill-before-tool superpowers:brainstorming Edit
    skill-before-tool superpowers:brainstorming Write
}
