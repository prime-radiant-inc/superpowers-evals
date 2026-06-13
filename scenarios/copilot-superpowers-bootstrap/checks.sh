# coding-agents: copilot

pre() {
    git-repo
    git-branch main
}

post() {
    copilot-plugin-installed
    check-transcript tool-arg-match Skill --eq skill=superpowers:brainstorming
    check-transcript skill-called superpowers:brainstorming
    check-transcript tool-match-before-tool-match Skill '"skill":"superpowers:brainstorming"' Edit '.*'
    check-transcript tool-match-before-tool-match Skill '"skill":"superpowers:brainstorming"' Write '.*'
}
