# coding-agents: codex
pre() {
    git-repo
    git-branch main
    assert-checkout-clean
    file-exists docs/superpowers/specs/cancellable-import-design.md
    not file-exists docs/superpowers/plans
}

post() {
    file-exists docs/superpowers/specs/cancellable-import-design.md
    file-exists docs/superpowers/plans
}
