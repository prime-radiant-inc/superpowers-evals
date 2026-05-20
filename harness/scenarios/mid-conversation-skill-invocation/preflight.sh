#!/usr/bin/env bash
# Fixture invariants — the SDD plan the turn-2 message references must
# exist for the scenario to mean anything.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -f "$HARNESS_WORKDIR/docs/superpowers/plans/auth-system.md"
