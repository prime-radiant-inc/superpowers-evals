#!/usr/bin/env bash
# Already inside a worktree: no new one should be added. Started with 2
# (main + existing-feature worktree), still expect 2.
set -euo pipefail
COUNT=$(cd "$DRILL_WORKDIR" && git worktree list | wc -l | tr -d ' ')
if [ "$COUNT" = "2" ]; then
    echo "PASS: still 2 worktrees"
    exit 0
fi
echo "FAIL: expected 2 worktrees, found $COUNT"
cd "$DRILL_WORKDIR" && git worktree list
exit 1
