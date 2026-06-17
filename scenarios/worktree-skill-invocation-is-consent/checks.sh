pre() {
    git-repo
    git-branch main
}

post() {
    git-count worktrees eq 2
}
