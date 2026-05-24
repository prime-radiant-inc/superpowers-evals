pre() {
    git-repo
    git-branch main
    git-clean
    file-exists 'docs/superpowers/plans/custom-greeting.md'
    git-count worktrees eq 1
}

post() {
    git-count worktrees eq 1
}
