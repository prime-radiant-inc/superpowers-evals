# coding-agents: codex
pre() {
    git-repo
    git-branch main
    assert-checkout-clean
    file-exists README.md
    file-exists src/import-service.js
    file-exists src/import-store.js
    file-exists src/cli.js
    file-exists src/worker.js
    not file-exists docs/superpowers/specs/cancellable-import-design.md
}

post() {
    check-transcript skill-called superpowers:brainstorming
    file-exists docs/superpowers/specs/cancellable-import-design.md
    not file-exists docs/superpowers/plans
    git-count commits gte 2
    git-clean
}
