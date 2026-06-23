# coding-agents: claude,codex,gemini,kimi
# Conditional preference ("no TDD on React") + a React project → TDD suppressed.
# Paired with user-pref-react-no-tdd-unmet (SAME preference, non-React project →
# TDD fires): together they prove the agent reads the CONDITION, not just
# blanket-suppresses.

pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-not-called superpowers:test-driven-development
}
