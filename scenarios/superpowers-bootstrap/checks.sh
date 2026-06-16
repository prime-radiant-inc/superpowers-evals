pre() {
    git-repo
    git-branch main
    bootstrap-installed
}

post() {
    check-transcript skill-called superpowers:brainstorming
    check-transcript skill-before-tool superpowers:brainstorming Write
    check-transcript skill-before-tool superpowers:brainstorming Edit
}
