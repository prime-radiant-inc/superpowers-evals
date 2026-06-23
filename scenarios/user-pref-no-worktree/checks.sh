# coding-agents: claude,codex,gemini,kimi
# A user preference ("no git worktrees") must suppress using-git-worktrees AND
# result in no new worktree. Control = the existing worktree-creation-from-main
# scenario (no preference → worktree created, git-count worktrees eq 2).

pre() {
    git-repo
    git-branch main
    git-count worktrees eq 1
}

post() {
    check-transcript skill-not-called superpowers:using-git-worktrees
    git-count worktrees eq 1
}
