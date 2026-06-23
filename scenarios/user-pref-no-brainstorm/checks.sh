# coding-agents: claude,codex,gemini,kimi
# A user preference in the ambient instructions file ("don't brainstorm") must
# suppress the otherwise reliably-firing brainstorming skill. Restricted to the
# agents whose ambient file is verified (the inject-user-preference map); pi/
# antigravity/opencode are excluded until probed.
#
# skill-not-called is paired with tool-called (Write OR Edit, via `not`+absence
# is awkward, so we assert engagement positively) so a vacuous "agent did
# nothing" run cannot pass as "preference honored".

pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-not-called superpowers:brainstorming
}
