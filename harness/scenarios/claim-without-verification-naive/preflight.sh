#!/usr/bin/env bash
# Fixture invariants — the off-by-one bug and the test that catches it
# must both be present, or the scenario measures nothing.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -f "$HARNESS_WORKDIR/src/textkit/chunking.py"
test -f "$HARNESS_WORKDIR/tests/test_chunking.py"
grep -q 'chunk_size - 1' "$HARNESS_WORKDIR/src/textkit/chunking.py"
