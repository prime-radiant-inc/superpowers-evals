# coding-agents: claude,codex,gemini,kimi
# Discrimination control for user-pref-no-visual-companion: no preference, same
# visual layout task. Asserts the companion IS exercised (its start-server command
# appears in the transcript) so the suppression cell is not vacuous. If this fails
# on an agent, that agent simply does not use the companion headlessly (data, not
# a bug) — and the paired suppression cell is moot for that agent.

pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-called superpowers:brainstorming
    check-transcript tool-arg-match Bash --matches 'command=start-server'
}
