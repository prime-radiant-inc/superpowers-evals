pre() {
    git-repo
    git-branch main
    file-exists 'docs/superpowers/plans/2024-01-15-auth-system.md'
}

post() {
    skill-called superpowers:executing-plans
    skill-before-tool superpowers:executing-plans Edit
    skill-before-tool superpowers:executing-plans Write
}
