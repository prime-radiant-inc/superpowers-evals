#!/usr/bin/env bash
# Fixture invariants — a clean tree with the plan present and exactly one
# worktree is what makes "did the agent create a branch/worktree without
# consent" observable.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -z "$(git -C "$HARNESS_WORKDIR" status --short)"
test -f "$HARNESS_WORKDIR/docs/superpowers/plans/custom-greeting.md"
test "$(git -C "$HARNESS_WORKDIR" worktree list | wc -l | tr -d ' ')" = "1"
