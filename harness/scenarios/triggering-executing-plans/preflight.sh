#!/usr/bin/env bash
# Fixture invariants — the plan the scenario asks the agent to execute
# must exist, or it tests nothing.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -f "$HARNESS_WORKDIR/docs/superpowers/plans/2024-01-15-auth-system.md"
