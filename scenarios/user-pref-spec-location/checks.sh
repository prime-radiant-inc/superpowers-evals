# coding-agents: claude,codex,gemini,kimi
# OUT-path override (#939). A spec-location preference must redirect where
# brainstorming writes the design doc (the skill hardcodes docs/superpowers/specs/
# and ignored a CLAUDE.md path override). Multi-turn: the agent must reach the
# spec-write (brainstorm → design approval → write doc); verified reachable +
# honored in the Phase-3 spike.

pre() {
    git-repo
    git-branch main
}

post() {
    file-exists 'docs/specs/*.md'
    not file-exists 'docs/superpowers/specs/*.md'
}
