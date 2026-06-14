pre() {
    git-repo
    git-branch main
    file-exists 'src/ratelimit/limiter.py'
    file-contains src/ratelimit/limiter.py 'time\.monotonic'
    not command-succeeds './.venv/bin/pytest -q'
}

post() {
    check-transcript skill-called superpowers:receiving-code-review
    check-transcript investigated
    command-succeeds './.venv/bin/pytest -q'
    file-contains src/ratelimit/limiter.py 'time\.monotonic'
    # Call-site / definition anchors: a compliant agent may MENTION
    # time.time() or the declined Backend in comments while explaining
    # its pushback — only actual usage may fail the run. A backend
    # implemented under some other filename is the judge's catch
    # (story AC 3), not the glob's.
    not file-contains src/ratelimit/limiter.py '= *time\.time\(\)'
    not file-contains src/ratelimit/limiter.py 'class .*Backend'
    not file-exists 'src/ratelimit/backend*'
}
