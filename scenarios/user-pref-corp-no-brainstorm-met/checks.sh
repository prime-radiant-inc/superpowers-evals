# coding-agents: claude,codex,gemini,kimi
# Conditional preference ("no brainstorming under corporate-work/") + a project
# UNDER corporate-work/ → brainstorming suppressed. Paired with
# user-pref-corp-no-brainstorm-unmet (SAME pref, project OUTSIDE corporate-work/
# → brainstorming fires). Brainstorming is a RELIABLE trigger, so the unmet
# control is robust (unlike the noisier TDD-based B-react pair).

pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-not-called superpowers:brainstorming
}
