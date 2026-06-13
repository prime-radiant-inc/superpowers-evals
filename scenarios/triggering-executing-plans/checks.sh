pre() {
    git-repo
    git-branch main
    file-exists 'docs/superpowers/plans/2024-01-15-auth-system.md'
}

post() {
    check-transcript skill-called superpowers:executing-plans
    check-transcript skill-before-tool superpowers:executing-plans Edit
    check-transcript skill-before-tool superpowers:executing-plans Write
}
