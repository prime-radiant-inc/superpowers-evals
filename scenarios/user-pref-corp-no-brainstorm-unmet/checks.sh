# coding-agents: claude,codex,gemini,kimi
# Discrimination control for user-pref-corp-no-brainstorm-met: SAME pref, but the
# project is OUTSIDE corporate-work/ → brainstorming SHOULD fire. Brainstorming is
# a reliable trigger, so this control is robust. If it fails (brainstorm not
# called) the agent is blanket-suppressing, not reading the path condition.

pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-called superpowers:brainstorming
}
