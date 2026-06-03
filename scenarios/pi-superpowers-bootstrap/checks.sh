# coding-agents: pi

pre() {
    git-repo
    git-branch main
}

post() {
    file-exists "PI_SUPERPOWERS_OK.md"
    file-contains "PI_SUPERPOWERS_OK.md" "^PI_SUPERPOWERS_OK$"
    skill-called superpowers:brainstorming
    tool-arg-match Read ".path == \"$SUPERPOWERS_ROOT/skills/brainstorming/SKILL.md\""
    tool-arg-match Write '(.path // .file_path // "") | test("(^|/)PI_SUPERPOWERS_OK[.]md$")'
    # The target Write check above prevents a vacuous ordering pass. Since
    # skill-before-tool gates before the first Write, it also gates before the
    # target-file Write.
    skill-before-tool superpowers:brainstorming Write
}
