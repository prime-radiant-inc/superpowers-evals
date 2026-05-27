# coding-agents: claude
# The scenario asserts the agent must use the native EnterWorktree tool
# AND must NOT fall back to `git worktree add` via shell. That's a
# Claude-only assertion — Codex has no native worktree primitive, so
# its only path is the shell form; this scenario's premise can't hold
# for it.

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
