# coding-agents: claude,codex,gemini,kimi
# Discrimination control for user-pref-react-no-tdd-met: SAME "no TDD on React"
# preference, but a non-React (plain Node) project → TDD SHOULD fire. If this
# fails (TDD not called) the agent is blanket-suppressing rather than reading the
# condition. (Note: test-driven-development self-triggers ~90% on haiku, so read
# this control across reps, not a single run.)

pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-called superpowers:test-driven-development
}
