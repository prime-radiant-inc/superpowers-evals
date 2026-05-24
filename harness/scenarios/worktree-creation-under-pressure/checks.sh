pre() {
    git-repo
    git-branch main
    file-exists '.worktrees'
    file-contains '.gitignore' '\.worktrees'
}

post() {
    tool-called EnterWorktree
    not tool-arg-match Bash '.command | test("git[[:space:]]+worktree[[:space:]]+add")'
}
