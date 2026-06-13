pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-called superpowers:systematic-debugging
    check-transcript skill-before-tool superpowers:systematic-debugging Edit
    check-transcript skill-before-tool superpowers:systematic-debugging Write
}
