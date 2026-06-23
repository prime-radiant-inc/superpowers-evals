# coding-agents: claude,codex,gemini,kimi
# C-visual sub-feature suppression: a no-visual-companion preference keeps
# brainstorming in the terminal — the skill still fires, but the companion server
# is not started. Deterministic signal = the companion's start-server command in
# the transcript (the .superpowers/brainstorm dir is UNRELIABLE: the companion
# uses /tmp without --project-dir, so the dir is absent even when it IS used).
# Paired with the -control cell, which asserts the companion IS started when no
# preference forbids it (verified exercised headlessly).

pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-called superpowers:brainstorming
    not check-transcript tool-arg-match Bash --matches 'command=start-server'
}
