# coding-agents: claude,codex

pre() {
    git-repo
    git-branch main
    git-count worktrees eq 2
    assert-checkout-clean .
}

post() {
    check-transcript tool-count Agent gte 2
    assert-checkout-clean .
    # --branches (not --all): stash refs must not count as landed work.
    command-succeeds 'test "$(git rev-list --count --branches --not main)" -ge 1'
}
