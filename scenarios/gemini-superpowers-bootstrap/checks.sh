# coding-agents: gemini

pre() {
    git-repo
    git-branch main
}

post() {
    gemini-extension-linked
    skill-called superpowers:brainstorming
    skill-before-tool superpowers:brainstorming Edit
    skill-before-tool superpowers:brainstorming Write
}
