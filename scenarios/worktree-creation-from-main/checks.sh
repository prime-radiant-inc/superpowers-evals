pre() {
    git-repo
    git-branch main
    git-count worktrees eq 1
}

post() {
    git-count worktrees eq 2
    check-transcript worktree-created
    check-transcript implementation-tool-not-called Write
}
