pre() {
    git-repo
    git-branch main
    file-exists 'docs/superpowers/plans/auth-system.md'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
}
