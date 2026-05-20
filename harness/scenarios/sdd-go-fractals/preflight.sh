#!/usr/bin/env bash
# Fixture invariants — plan.md and design.md must exist. go must be on
# PATH: the assertions run `go test`, and a 10-30 min run should not
# start only to fail at the end on a missing toolchain.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -f "$HARNESS_WORKDIR/plan.md"
test -f "$HARNESS_WORKDIR/design.md"
command -v go >/dev/null
