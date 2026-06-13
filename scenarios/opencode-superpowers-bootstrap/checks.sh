# coding-agents: opencode

pre() {
    git-repo
    git-branch main
}

post() {
    opencode-plugin-installed
    check-transcript tool-arg-match Skill --eq skill=superpowers:brainstorming
    check-transcript skill-called superpowers:brainstorming
    check-transcript skill-before-tool superpowers:brainstorming Edit
    check-transcript skill-before-tool superpowers:brainstorming Write
}
