# SPIKE (Phase 3, unpinned — run targeted). An "always subagent-driven, don't
# ask" preference: the agent should dispatch a subagent without prompting for a
# strategy. SOFT/MULTI-TURN: tool-not-called AskUserQuestion is weak (a plain
# text question would not trip it), and reaching the strategy decision is deep
# multi-turn. This spike tests reachability + measurability before authoring more
# execution-mode scenarios.

pre() {
    git-repo
    git-branch main
    file-exists 'docs/superpowers/plans/2024-01-15-auth-system.md'
}

post() {
    check-transcript tool-called Agent
    check-transcript tool-not-called AskUserQuestion
}
