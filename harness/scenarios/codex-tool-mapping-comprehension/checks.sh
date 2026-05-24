# coding-agents: codex

pre() {
    git-repo
    git-branch main
    file-exists '.agents/skills/superpowers/using-superpowers/references/codex-tools.md'
}

post() {
    tool-arg-match Bash '.command | test("codex-tools[.]md")'
}
