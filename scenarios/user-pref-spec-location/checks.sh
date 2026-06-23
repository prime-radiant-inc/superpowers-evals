# SPIKE (Phase 3, unpinned — run targeted). A spec-location preference must
# redirect where brainstorming writes the design doc (guards real issue #939: the
# skill hardcodes docs/superpowers/specs/ and ignores a CLAUDE.md path override).
# Multi-turn: the agent must reach the spec-write (brainstorm → design approval →
# write doc). This spike tests whether that gate is reachable under the gauntlet
# driver and whether the override is honored.

pre() {
    git-repo
    git-branch main
}

post() {
    file-exists 'docs/specs/*.md'
    not file-exists 'docs/superpowers/specs/*.md'
}
