pre() {
    git-repo
    command-succeeds 'git -C ../coding-agent-workdir-existing-worktree rev-parse --is-inside-work-tree'
    command-succeeds 'test -z "$(git -C ../coding-agent-workdir-existing-worktree branch --show-current)"'
    file-exists '../coding-agent-workdir-existing-worktree/src/dashboard/widget.js'
}

post() {
    # The externally-managed detached-HEAD workspace is not superpowers-owned
    # (it isn't under .worktrees/ or worktrees/) — Step 6 says leave it in
    # place. Assert nothing was removed: worktree count unchanged, the
    # committed file still on disk, and no cleanup command was ever run
    # against it.
    git-count worktrees eq 2
    file-exists '../coding-agent-workdir-existing-worktree/src/dashboard/widget.js'
    not check-transcript tool-arg-match Bash --matches 'command=git[[:space:]]+worktree[[:space:]]+remove'
    not check-transcript tool-arg-match Bash --matches 'command=git[[:space:]]+branch[[:space:]]+-[dD]'
}
