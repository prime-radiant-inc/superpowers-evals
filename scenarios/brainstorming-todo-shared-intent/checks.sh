# coding-agents: codex
pre() {
    git-repo
    git-branch main
    assert-checkout-clean
    file-exists README.md
    not file-exists package.json
    not file-exists AGENTS.md
}

post() {
    brainstorming-review
}
