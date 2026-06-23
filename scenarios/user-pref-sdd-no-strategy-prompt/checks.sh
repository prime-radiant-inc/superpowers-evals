# coding-agents: claude,codex,gemini,kimi
# Execution-mode override (#846). An "always subagent-driven, don't ask"
# preference: the agent should dispatch a subagent without prompting for a
# strategy. SOFT: tool-not-called AskUserQuestion is weak (a plain text question
# would not trip it); the strong signal is the subagent dispatch (tool-called
# Agent). Verified reachable + honored in the Phase-3 spike.

pre() {
    git-repo
    git-branch main
    file-exists 'docs/superpowers/plans/2024-01-15-auth-system.md'
}

post() {
    check-transcript tool-called Agent
    check-transcript tool-not-called AskUserQuestion
}
