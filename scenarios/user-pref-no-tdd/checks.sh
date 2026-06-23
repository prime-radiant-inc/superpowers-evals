# coding-agents: claude,codex,gemini,kimi
# A user preference ("don't use TDD") must suppress the test-driven-development
# skill. Restricted to agents with a verified ambient-instructions file.
# Control = the existing triggering-test-driven-development scenario.

pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-not-called superpowers:test-driven-development
}
