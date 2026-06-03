# coding-agents: opencode

pre() {
    git-repo
    git-branch main
}

post() {
    opencode-plugin-installed
    tool-arg-match Skill '.skill == "superpowers:brainstorming"'
    skill-called superpowers:brainstorming
    skill-before-tool superpowers:brainstorming Edit
    skill-before-tool superpowers:brainstorming Write
}
