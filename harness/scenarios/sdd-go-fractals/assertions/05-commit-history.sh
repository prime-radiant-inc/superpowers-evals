#!/usr/bin/env bash
# Plan execution should leave per-task commits on top of the initial
# commit — the plan has 7+ tasks, so expect at least 4.
set -euo pipefail
COUNT=$(cd "$HARNESS_WORKDIR" && git log --oneline | wc -l | tr -d ' ')
if [ "$COUNT" -ge 4 ]; then
    echo "PASS: $COUNT commits"
else
    echo "FAIL: expected >=4 commits, found $COUNT"
    exit 1
fi
