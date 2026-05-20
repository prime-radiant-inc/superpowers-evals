#!/usr/bin/env bash
# Fixture invariants — same repo as the baseline, plus the verification
# checkpoint in CLAUDE.md that is the whole point of this variant.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -f "$HARNESS_WORKDIR/docs/team-pulse-widget-design.md"
test -f "$HARNESS_WORKDIR/src/router.tsx"
test -f "$HARNESS_WORKDIR/src/components/AdminPanel.tsx"
test -f "$HARNESS_WORKDIR/src/components/TeamOverview.tsx"
grep -q 'Implementation Verification Checklist' "$HARNESS_WORKDIR/CLAUDE.md"
