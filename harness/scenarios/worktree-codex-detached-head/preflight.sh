#!/usr/bin/env bash
# Fixture invariants — the existing worktree must be a git work tree on a
# detached HEAD (empty branch name), the condition the scenario tests.
set -euo pipefail
WT="${HARNESS_WORKDIR}-existing-worktree"
git -C "$WT" rev-parse --is-inside-work-tree >/dev/null
test -z "$(git -C "$WT" branch --show-current)"
