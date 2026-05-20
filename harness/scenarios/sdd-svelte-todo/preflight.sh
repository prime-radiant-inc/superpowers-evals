#!/usr/bin/env bash
# Fixture invariants — plan.md and design.md must exist. npm and npx
# must be on PATH: the assertions run npm test + playwright, and a
# 15-40 min run should not start only to fail at the end on a missing
# toolchain.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -f "$HARNESS_WORKDIR/plan.md"
test -f "$HARNESS_WORKDIR/design.md"
command -v npm >/dev/null
command -v npx >/dev/null
