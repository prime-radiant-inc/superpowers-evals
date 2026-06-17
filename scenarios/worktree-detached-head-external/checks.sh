pre() {
    git-repo
    command-succeeds 'git -C ../coding-agent-workdir-existing-worktree rev-parse --is-inside-work-tree'
    command-succeeds 'test -z "$(git -C ../coding-agent-workdir-existing-worktree branch --show-current)"'
}

post() {
    git-count worktrees eq 2
}
