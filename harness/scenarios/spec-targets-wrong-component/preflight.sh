#!/usr/bin/env bash
# Fixture invariants — the spec, the router, and both candidate
# components must exist for the scenario to pose its choice.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -f "$HARNESS_WORKDIR/docs/team-pulse-widget-design.md"
test -f "$HARNESS_WORKDIR/src/router.tsx"
test -f "$HARNESS_WORKDIR/src/components/AdminPanel.tsx"
test -f "$HARNESS_WORKDIR/src/components/TeamOverview.tsx"
