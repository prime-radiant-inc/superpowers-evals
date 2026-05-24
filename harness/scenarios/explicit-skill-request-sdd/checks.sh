pre() {
    git-repo
    git-branch main
    file-exists 'docs/superpowers/plans/auth-system.md'
}

post() {
    skill-called superpowers:subagent-driven-development
    tool-called Agent
}
