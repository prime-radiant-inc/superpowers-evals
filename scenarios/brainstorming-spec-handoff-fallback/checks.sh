# coding-agents: codex
pre() {
    git-repo
    git-branch main
    assert-checkout-clean
    file-exists docs/superpowers/specs/approved-cancellable-import-design.md
    file-exists docs/superpowers/specs/cancellable-import-design.original.md
    file-exists docs/superpowers/specs/cancellable-import-design.tentative.md
    file-exists docs/superpowers/specs/cancellable-import-design.md
    command-succeeds 'cmp -s docs/superpowers/specs/cancellable-import-design.md docs/superpowers/specs/cancellable-import-design.tentative.md'
    command-succeeds 'test "$(cmp -s docs/superpowers/specs/cancellable-import-design.original.md docs/superpowers/specs/cancellable-import-design.tentative.md; echo $?)" = 1'
}

post() {
    check-transcript skill-called superpowers:brainstorming
    command-succeeds 'cmp -s docs/superpowers/specs/cancellable-import-design.md docs/superpowers/specs/cancellable-import-design.original.md'
    command-succeeds 'git diff --quiet HEAD^ -- docs/superpowers/specs/cancellable-import-design.original.md docs/superpowers/specs/cancellable-import-design.tentative.md docs/superpowers/specs/approved-cancellable-import-design.md'
    command-succeeds 'test "$(git diff --name-only HEAD^ HEAD)" = docs/superpowers/specs/cancellable-import-design.md'
    not file-exists docs/superpowers/plans
    git-count commits gte 2
    git-clean
}
