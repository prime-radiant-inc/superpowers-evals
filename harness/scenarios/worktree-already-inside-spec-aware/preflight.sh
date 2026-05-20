#!/usr/bin/env bash
# Fixture invariants — the agent must land inside an existing worktree,
# so the repo must already have two (main + the existing-feature one).
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" worktree list | wc -l | tr -d ' ')" = "2"
