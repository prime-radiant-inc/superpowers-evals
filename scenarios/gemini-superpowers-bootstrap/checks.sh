# coding-agents: gemini

pre() {
    git-repo
    git-branch main
}

post() {
    gemini-extension-linked
    check-transcript skill-called superpowers:brainstorming
    check-transcript skill-before-tool superpowers:brainstorming Edit
    check-transcript skill-before-tool superpowers:brainstorming Write
}
