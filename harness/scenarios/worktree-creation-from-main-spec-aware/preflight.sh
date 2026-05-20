#!/usr/bin/env bash
# Fixture invariants — fail loudly if setup didn't leave the expected state.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test "$(git -C "$HARNESS_WORKDIR" worktree list | wc -l | tr -d ' ')" = "1"
