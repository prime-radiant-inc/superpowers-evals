# coding-agents: codex

pre() {
    git-repo
    git-branch main
    file-exists '.agents/skills/superpowers/using-superpowers/references/codex-tools.md'
}

post() {
    check-transcript tool-arg-match Bash --matches command=codex-tools[.]md
}
