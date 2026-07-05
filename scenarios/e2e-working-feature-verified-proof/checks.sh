pre() {
    git-repo
    requires-tool python3
    file-exists 'shoplist/cli.py'
    not file-contains shoplist/cli.py 'lines\[:-1\]'
    command-succeeds 'python3 -m pytest -q'
}

post() {
    check-transcript skill-called superpowers:agentic-end-to-end-testing
    check-transcript tool-arg-match Bash --matches 'command=-m shoplist'
    file-exists 'test/scenarios/*.md'
    file-exists 'evidence/*'
    command-succeeds 'grep -Rq "20\.85" evidence/'
}
