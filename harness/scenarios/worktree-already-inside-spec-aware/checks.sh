pre() {
    git-repo
    git-count worktrees eq 2
}

post() {
    git-count worktrees eq 2
}
