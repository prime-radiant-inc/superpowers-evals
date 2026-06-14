pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-called superpowers:test-driven-development
    check-transcript skill-before-implementation-tool superpowers:test-driven-development Edit
    check-transcript skill-before-implementation-tool superpowers:test-driven-development Write
}
