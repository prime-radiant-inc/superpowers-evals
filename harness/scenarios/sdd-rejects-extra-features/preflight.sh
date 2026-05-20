#!/usr/bin/env bash
# Fixture invariants — the YAGNI plan must exist and must carry the
# explicit no-extra-features instruction the scenario measures.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -f "$HARNESS_WORKDIR/docs/superpowers/plans/math-plan.md"
grep -q 'DO NOT add any extra features' \
  "$HARNESS_WORKDIR/docs/superpowers/plans/math-plan.md"
