# The discriminator for PR #1933's WORKTREE_PATH-before-cd fix: post()
# verifies git state, not agent narration. `git-count worktrees` counts
# `git worktree list` lines INCLUDING the main worktree, so 2 = main +
# feature worktree (pre()), 1 = main only (post(), feature worktree removed).

pre() {
    git-repo
    git-count worktrees gt 1
    command-succeeds 'git rev-parse --verify feature-report-export'
    command-succeeds 'git -C .worktrees/report-export log -1 --oneline | grep -q reportexportfixturemarker'
}

post() {
    git-count worktrees eq 1
    not command-succeeds 'git rev-parse --verify feature-report-export'
    command-succeeds 'git log --oneline main | grep -q reportexportfixturemarker'
}
