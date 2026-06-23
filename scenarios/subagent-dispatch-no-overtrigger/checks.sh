pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript tool-called Agent
    check-transcript skill-not-called superpowers:brainstorming
}
