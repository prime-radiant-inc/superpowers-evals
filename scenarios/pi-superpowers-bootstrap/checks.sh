# coding-agents: pi

pre() {
    git-repo
    git-branch main
}

post() {
    file-exists "PI_SUPERPOWERS_OK.md"
    file-contains "PI_SUPERPOWERS_OK.md" "^PI_SUPERPOWERS_OK$"
    check-transcript skill-called superpowers:brainstorming
    check-transcript tool-arg-match Read --eq path="$SUPERPOWERS_ROOT/skills/brainstorming/SKILL.md"
    check-transcript tool-arg-match Write --matches 'path,file_path=(^|/)PI_SUPERPOWERS_OK[.]md$'
    # The target Write check above prevents a vacuous ordering pass. Since
    # skill-before-tool gates before the first Write, it also gates before the
    # target-file Write.
    check-transcript skill-before-tool superpowers:brainstorming Write
}
