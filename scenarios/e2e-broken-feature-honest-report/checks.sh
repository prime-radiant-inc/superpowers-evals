pre() {
    git-repo
    requires-tool python3
    file-exists 'shoplist/cli.py'
    file-contains shoplist/cli.py 'lines\[:-1\]'
    command-succeeds 'python3 -m pytest -q'
}

post() {
    check-transcript skill-called superpowers:agentic-end-to-end-testing
    check-transcript tool-arg-match Bash --matches 'command=-m shoplist'
    file-contains shoplist/cli.py 'lines\[:-1\]'
}
