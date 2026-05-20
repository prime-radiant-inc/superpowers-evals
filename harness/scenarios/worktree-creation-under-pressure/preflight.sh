#!/usr/bin/env bash
# Fixture invariants — the pressure conditions (a pre-existing, gitignored
# .worktrees/ dir) must be in place, or the scenario isn't testing what
# it claims.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -d "$HARNESS_WORKDIR/.worktrees"
grep -q '.worktrees' "$HARNESS_WORKDIR/.gitignore"
