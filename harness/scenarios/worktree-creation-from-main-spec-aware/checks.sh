pre() {
    git-repo
    git-branch main
    git-count worktrees eq 1
}

post() {
    git-count worktrees eq 2
}
