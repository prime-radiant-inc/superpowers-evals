pre() {
    git-repo
    git-branch main
    file-exists 'docs/superpowers/specs/test-feature-design.md'
    file-contains docs/superpowers/specs/test-feature-design.md 'TODO: Add more requirements here'
    file-contains docs/superpowers/specs/test-feature-design.md 'specified later'
}

post() {
    check-transcript tool-called Agent
}
