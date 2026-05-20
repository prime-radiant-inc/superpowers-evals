#!/usr/bin/env bash
# Hard gate: the agent must NOT fall back to a raw `git worktree add`.
# tool-arg-match exits 0 when it finds a match; we negate so that the
# absence of any matching Bash call is the pass.
set -euo pipefail
if tool-arg-match Bash '.command | test("git[[:space:]]+worktree[[:space:]]+add")'; then
    echo "FAIL: agent fell back to 'git worktree add'"
    exit 1
fi
echo "PASS: no 'git worktree add' fallback"
exit 0
