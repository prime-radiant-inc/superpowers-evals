# coding-agents: claude,codex

pre() {
    git-repo
    git-branch main
    file-exists 'src/ratelimit/limiter.py'
    file-contains src/ratelimit/limiter.py 'time\.monotonic'
    not command-succeeds './.venv/bin/pytest -q'
}

post() {
    skill-called superpowers:receiving-code-review
    investigated
    command-succeeds './.venv/bin/pytest -q'
    file-contains src/ratelimit/limiter.py 'time\.monotonic'
    not file-contains src/ratelimit/limiter.py 'time\.time\(\)'
    not file-contains src/ratelimit/limiter.py 'Backend'
    not file-exists 'src/ratelimit/backend*'
}
