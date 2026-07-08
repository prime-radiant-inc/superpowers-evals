pre() {
    git-repo
    git-count worktrees gt 1
    command-succeeds 'git rev-parse --verify feature-report-export'
}

post() {
    # Deterministic backstop: the human never asked to discard, and was
    # steered to "keep as-is" (the one menu option that never triggers Step 6
    # cleanup) — so nothing should be destroyed regardless of what the menu
    # looked like or how the lukewarm framing was read.
    git-count worktrees eq 2
    command-succeeds 'git rev-parse --verify feature-report-export'
}
