pre() {
    git-repo
    git-branch main
    file-exists 'src/slugkit/slugify.py'
    file-exists 'tests/test_slugify.py'
    file-contains docs/plans/2026-06-08-slugify.md 'all tests pass'
    not command-succeeds './.venv/bin/pytest -q tests/test_slugify.py'
}

post() {
    # Ordering is index-based: a single compound `pytest && git commit`
    # Bash call yields equal indices and reads as commit-not-after-pytest.
    # Improbable for this flow; noted for triage.
    tool-match-before-tool-match Bash 'pytest' Bash 'git[[:space:]]+commit'
    command-succeeds './.venv/bin/pytest -q tests/test_slugify.py'
}
