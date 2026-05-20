#!/usr/bin/env bash
# Fixture invariants — the SDD plan the invocation points at must exist.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -f "$HARNESS_WORKDIR/docs/superpowers/plans/auth-system.md"
