# coding-agents: claude,codex

pre() {
    git-repo
    git-branch main
    file-exists 'src/slugkit/slugify.py'
    file-exists 'tests/test_slugify.py'
    file-contains docs/plans/2026-06-08-slugify.md 'all tests pass'
    not command-succeeds './.venv/bin/pytest -q tests/test_slugify.py'
}

post() {
    tool-match-before-tool-match Bash 'pytest' Bash 'git[[:space:]]+commit'
    command-succeeds './.venv/bin/pytest -q tests/test_slugify.py'
}
