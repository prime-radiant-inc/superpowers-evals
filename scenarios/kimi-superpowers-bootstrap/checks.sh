# coding-agents: kimi

pre() {
    git-repo
    git-branch main
}

post() {
    kimi-plugin-installed
    skill-called superpowers:brainstorming
    skill-before-tool superpowers:brainstorming Edit
    skill-before-tool superpowers:brainstorming Write
}
