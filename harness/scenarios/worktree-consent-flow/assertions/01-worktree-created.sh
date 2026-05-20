#!/usr/bin/env bash
# Direct skill invocation is consent: a worktree should now exist.
# Started with 1 (main), expect 2.
set -euo pipefail
COUNT=$(cd "$DRILL_WORKDIR" && git worktree list | wc -l | tr -d ' ')
if [ "$COUNT" = "2" ]; then
    echo "PASS: 2 worktrees (main + new)"
    exit 0
fi
echo "FAIL: expected 2 worktrees, found $COUNT"
cd "$DRILL_WORKDIR" && git worktree list
exit 1
